/**
 * Historical message synchronisation. Reads Discord history (via an injected
 * {@link DiscordSource} so it can be unit-tested with fakes) and writes ONLY to
 * the local analytics database. It never issues a Discord write.
 *
 * The algorithm pages backwards through each channel until it hits the requested
 * start date, the safety message limit, an access error, or the end of history —
 * upserting in bounded, transactional batches so a large server never has to be
 * held in memory, and so re-running is idempotent.
 */
import type { AnalyticsConfig } from "./types.js";
import type { AnalyticsRepository } from "./repository.js";

/** One attachment as seen from Discord history. */
export interface SourceAttachment {
  id: string;
  filename: string | null;
  contentType: string | null;
  size: number | null;
  url: string | null;
  proxyUrl: string | null;
  width: number | null;
  height: number | null;
}

/** One message as seen from Discord history (already normalised, IDs as strings). */
export interface SourceMessage {
  id: string;
  createdAt: string;
  editedAt: string | null;
  authorId: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorIsBot: boolean;
  content: string | null;
  referencedMessageId: string | null;
  isReply: boolean;
  pinned: boolean;
  type: number | null;
  attachments: SourceAttachment[];
  reactionCount: number;
}

/** A readable channel/thread/forum-post the sync can page through. */
export interface SourceChannel {
  id: string;
  guildId: string;
  parentId: string | null;
  name: string | null;
  type: number;
  isThread: boolean;
  archived: boolean;
  /** Fetch one page (newest-first) older than `before`, up to `limit` messages. */
  fetchMessages(options: { limit: number; before?: string }): Promise<SourceMessage[]>;
}

export interface SourceGuild {
  id: string;
  name: string | null;
  /** All readable channels, threads, forum posts, and (where permitted) archived threads. */
  listChannels(): Promise<SourceChannel[]>;
}

/** Abstraction over Discord reads, so the algorithm is testable without a gateway. */
export interface DiscordSource {
  getGuild(guildId: string): Promise<SourceGuild | null>;
}

export interface SyncOptions {
  guildId: string;
  /** YYYY-MM-DD lower bound (inclusive). Falls back to the configured default. */
  startDate?: string | null;
  /** Restrict to these channel IDs; otherwise every readable channel is synced. */
  channelIds?: string[];
  /** Safety cap on messages fetched per channel. */
  maxMessagesPerChannel?: number;
  /** When true, page and count but write nothing (estimate mode). */
  dryRun?: boolean;
}

export interface ChannelSyncResult {
  channelId: string;
  channelName: string | null;
  status: "completed" | "failed" | "skipped";
  messagesImported: number;
  oldestMessageReached: string | null;
  error: string | null;
}

export interface SyncSummary {
  guildId: string;
  dryRun: boolean;
  startDate: string | null;
  channels: ChannelSyncResult[];
  totalMessages: number;
}

/** Absolute ceiling on pages per channel, so a bug can never loop forever. */
const MAX_PAGES_PER_CHANNEL = 10_000;

/** Turns a YYYY-MM-DD date into an ISO lower bound, or null. */
function startBoundary(date: string | null | undefined): string | null {
  return date ? `${date}T00:00:00.000Z` : null;
}

/**
 * Syncs one channel, paging backwards. Writes through the repo unless `dryRun`.
 * Stops at the start date, the message cap, empty history, or the page ceiling.
 */
async function syncChannel(
  repo: AnalyticsRepository,
  channel: SourceChannel,
  opts: {
    boundary: string | null;
    maxMessages: number | null;
    pageLimit: number;
    dryRun: boolean;
  },
): Promise<{ imported: number; oldest: string | null }> {
  let before: string | undefined;
  let imported = 0;
  let oldest: string | null = null;

  for (let page = 0; page < MAX_PAGES_PER_CHANNEL; page++) {
    if (opts.maxMessages !== null && imported >= opts.maxMessages) break;
    const remaining =
      opts.maxMessages !== null
        ? Math.min(opts.pageLimit, opts.maxMessages - imported)
        : opts.pageLimit;
    const batch = await channel.fetchMessages({ limit: remaining, before });
    if (batch.length === 0) break;

    let reachedStart = false;
    const persist = () => {
      for (const m of batch) {
        if (opts.boundary && m.createdAt < opts.boundary) {
          reachedStart = true;
          break;
        }
        if (!opts.dryRun) writeMessage(repo, channel, m);
        imported += 1;
        oldest = m.createdAt;
      }
    };
    if (opts.dryRun) persist();
    else repo.transaction(persist);

    before = batch[batch.length - 1].id;
    if (reachedStart) break;
    if (batch.length < remaining) break;
  }
  return { imported, oldest };
}

/** Writes a single message plus its guild/channel/author/attachments. */
function writeMessage(repo: AnalyticsRepository, channel: SourceChannel, m: SourceMessage): void {
  repo.upsertChannel({
    channel_id: channel.id,
    guild_id: channel.guildId,
    parent_channel_id: channel.parentId,
    name: channel.name,
    type: channel.type,
    is_thread: channel.isThread,
    is_archived: channel.archived,
  });
  if (m.authorId) {
    repo.upsertMember({
      user_id: m.authorId,
      guild_id: channel.guildId,
      username: m.authorUsername,
      display_name: m.authorDisplayName,
      is_bot: m.authorIsBot,
    });
  }
  repo.upsertMessage({
    message_id: m.id,
    guild_id: channel.guildId,
    channel_id: channel.id,
    parent_channel_id: channel.parentId,
    author_id: m.authorId,
    content: m.content,
    created_at: m.createdAt,
    edited_at: m.editedAt,
    referenced_message_id: m.referencedMessageId,
    is_reply: m.isReply,
    is_pinned: m.pinned,
    author_is_bot: m.authorIsBot,
    message_type: m.type,
    attachment_count: m.attachments.length,
    reaction_count: m.reactionCount,
  });
  for (const a of m.attachments) {
    repo.upsertAttachment({
      attachment_id: a.id,
      message_id: m.id,
      filename: a.filename,
      content_type: a.contentType,
      size: a.size,
      url: a.url,
      proxy_url: a.proxyUrl,
      width: a.width,
      height: a.height,
    });
  }
}

/**
 * Runs a history sync for one guild across its readable channels. Records a
 * sync-run row per channel, continues past channel-level failures, and never
 * calls a Discord write. Progress is reported as counts only — never content.
 */
export async function syncMessageHistory(
  repo: AnalyticsRepository,
  source: DiscordSource,
  config: AnalyticsConfig,
  options: SyncOptions,
  log: (msg: string) => void = () => {},
): Promise<SyncSummary> {
  const startDate = options.startDate ?? config.historyStartDate ?? null;
  const boundary = startBoundary(startDate);
  const dryRun = options.dryRun ?? false;

  const guild = await source.getGuild(options.guildId);
  if (!guild) {
    throw new Error(`Guild ${options.guildId} is not reachable by the bot.`);
  }
  if (!dryRun) repo.upsertGuild(guild.id, guild.name);

  const allChannels = await guild.listChannels();
  const channels = options.channelIds?.length
    ? allChannels.filter((c) => options.channelIds!.includes(c.id))
    : allChannels;

  const results: ChannelSyncResult[] = [];
  let total = 0;

  for (const channel of channels) {
    const runId = dryRun
      ? null
      : repo.startSyncRun({
          guild_id: guild.id,
          channel_id: channel.id,
          requested_start_date: startDate,
          requested_max_messages: options.maxMessagesPerChannel ?? null,
        });
    try {
      const { imported, oldest } = await syncChannel(repo, channel, {
        boundary,
        maxMessages: options.maxMessagesPerChannel ?? null,
        pageLimit: config.syncPageLimit,
        dryRun,
      });
      total += imported;
      log(`channel ${channel.id}: ${imported} messages${dryRun ? " (estimate)" : ""}`);
      if (runId) {
        repo.finishSyncRun(runId, {
          status: "completed",
          messages_imported: imported,
          oldest_message_reached: oldest,
        });
      }
      results.push({
        channelId: channel.id,
        channelName: channel.name,
        status: "completed",
        messagesImported: imported,
        oldestMessageReached: oldest,
        error: null,
      });
    } catch (err) {
      // One channel failing (e.g. Missing Access) must not abort the others.
      const summary = err instanceof Error ? err.message : String(err);
      log(`channel ${channel.id}: FAILED — ${summary}`);
      if (runId) {
        repo.finishSyncRun(runId, {
          status: "failed",
          messages_imported: 0,
          error_summary: summary.slice(0, 500),
        });
      }
      results.push({
        channelId: channel.id,
        channelName: channel.name,
        status: "failed",
        messagesImported: 0,
        oldestMessageReached: null,
        error: summary.slice(0, 500),
      });
    }
  }

  if (!dryRun) repo.markGuildSynced(guild.id);
  return { guildId: guild.id, dryRun, startDate, channels: results, totalMessages: total };
}
