/**
 * Data-access layer over the analytics SQLite database. Every read and write the
 * collector, history sync, and MCP tools perform goes through here, so the SQL
 * lives in exactly one place. All writes are UPSERTs (idempotent) and batch
 * operations run inside a transaction.
 *
 * This layer is Discord-agnostic: callers pass plain row data. It never contacts
 * Discord and never logs message content.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AttachmentRow,
  MessageRow,
  SyncRunRow,
  SyncRunStatus,
  VoiceSessionRow,
} from "./types.js";

/** SQLite bind values accepted by node:sqlite prepared statements. */
type Bind = string | number | null;

/** A one-way SHA-256 hex hash — never reversible, used when content is not stored. */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const nowIso = () => new Date().toISOString();
const bool = (v: boolean | undefined): number => (v ? 1 : 0);

/** Input for {@link AnalyticsRepository.upsertMessage}, before content policy is applied. */
export interface MessageInput {
  message_id: string;
  guild_id: string | null;
  channel_id: string;
  parent_channel_id?: string | null;
  author_id: string | null;
  /** Raw text as seen from Discord; stored or hashed per `storeContent`. */
  content: string | null;
  created_at: string;
  edited_at?: string | null;
  referenced_message_id?: string | null;
  is_reply?: boolean;
  is_pinned?: boolean;
  author_is_bot?: boolean;
  message_type?: number | null;
  attachment_count?: number;
  reaction_count?: number;
}

export interface MessageCountFilter {
  guildId?: string;
  channelIds?: string[];
  memberIds?: string[];
  startDate?: string | null;
  endDate?: string | null;
  includeBots?: boolean;
}

export type MessageCountGroupBy = "guild" | "channel" | "member" | "day" | "week";

export interface VoiceSessionFilter {
  guildId?: string;
  channelIds?: string[];
  memberIds?: string[];
  startDate?: string | null;
  endDate?: string | null;
  includeBots?: boolean;
  includeIncomplete?: boolean;
}

export interface SyncRunFilter {
  guildId?: string;
  channelId?: string;
  status?: SyncRunStatus;
  startDate?: string | null;
  endDate?: string | null;
  limit?: number;
}

export class AnalyticsRepository {
  constructor(
    private readonly db: DatabaseSync,
    /** Whether readable message text is stored (vs. metadata + one-way hash only). */
    public readonly storeContent: boolean,
  ) {}

  /** Runs `fn` inside a single transaction, rolling back on any error. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ─── Guilds / channels / members ──────────────────────────────────────────

  upsertGuild(guildId: string, name: string | null, at = nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO guilds (guild_id, name, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET
           name = COALESCE(excluded.name, guilds.name),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(guildId, name, at, at);
  }

  markGuildSynced(guildId: string, at = nowIso()): void {
    this.db
      .prepare(`UPDATE guilds SET last_history_sync_at = ? WHERE guild_id = ?`)
      .run(at, guildId);
  }

  upsertChannel(row: {
    channel_id: string;
    guild_id: string;
    parent_channel_id?: string | null;
    name: string | null;
    type: number;
    is_thread?: boolean;
    is_archived?: boolean;
  }): void {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO channels
           (channel_id, guild_id, parent_channel_id, name, type, is_thread, is_archived, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           guild_id = excluded.guild_id,
           parent_channel_id = excluded.parent_channel_id,
           name = COALESCE(excluded.name, channels.name),
           type = excluded.type,
           is_thread = excluded.is_thread,
           is_archived = excluded.is_archived,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        row.channel_id,
        row.guild_id,
        row.parent_channel_id ?? null,
        row.name,
        row.type,
        bool(row.is_thread),
        bool(row.is_archived),
        at,
        at,
      );
  }

  upsertMember(row: {
    user_id: string;
    guild_id: string;
    username: string | null;
    display_name: string | null;
    is_bot?: boolean;
  }): void {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO members
           (user_id, guild_id, username, display_name, is_bot, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id) DO UPDATE SET
           username = COALESCE(excluded.username, members.username),
           display_name = COALESCE(excluded.display_name, members.display_name),
           is_bot = excluded.is_bot,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(row.user_id, row.guild_id, row.username, row.display_name, bool(row.is_bot), at, at);
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  /**
   * Applies the content-storage policy: when storage is on, keeps the text and a
   * hash; when off, drops the text but keeps the one-way hash (no reversible
   * form is ever written). Missing content yields null/null.
   */
  private applyContentPolicy(content: string | null): {
    content: string | null;
    hash: string | null;
  } {
    if (content === null || content === undefined) return { content: null, hash: null };
    const hash = contentHash(content);
    return { content: this.storeContent ? content : null, hash };
  }

  upsertMessage(input: MessageInput): void {
    const { content, hash } = this.applyContentPolicy(input.content);
    this.db
      .prepare(
        `INSERT INTO messages
           (message_id, guild_id, channel_id, parent_channel_id, author_id, content, content_hash,
            created_at, edited_at, referenced_message_id, is_reply, is_pinned, author_is_bot,
            message_type, is_deleted, deleted_observed_at, attachment_count, reaction_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           guild_id = excluded.guild_id,
           channel_id = excluded.channel_id,
           parent_channel_id = excluded.parent_channel_id,
           author_id = COALESCE(excluded.author_id, messages.author_id),
           content = excluded.content,
           content_hash = excluded.content_hash,
           edited_at = excluded.edited_at,
           referenced_message_id = excluded.referenced_message_id,
           is_reply = excluded.is_reply,
           is_pinned = excluded.is_pinned,
           author_is_bot = excluded.author_is_bot,
           message_type = excluded.message_type,
           attachment_count = excluded.attachment_count,
           reaction_count = excluded.reaction_count`,
      )
      .run(
        input.message_id,
        input.guild_id,
        input.channel_id,
        input.parent_channel_id ?? null,
        input.author_id,
        content,
        hash,
        input.created_at,
        input.edited_at ?? null,
        input.referenced_message_id ?? null,
        bool(input.is_reply),
        bool(input.is_pinned),
        bool(input.author_is_bot),
        input.message_type ?? null,
        input.attachment_count ?? 0,
        input.reaction_count ?? 0,
      );
  }

  /** Marks an existing message deleted (never resurrects or fabricates rows). */
  markMessageDeleted(messageId: string, at = nowIso()): boolean {
    const info = this.db
      .prepare(
        `UPDATE messages SET is_deleted = 1, deleted_observed_at = ?
         WHERE message_id = ? AND is_deleted = 0`,
      )
      .run(at, messageId);
    return info.changes > 0;
  }

  getMessage(messageId: string): MessageRow | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE message_id = ?`).get(messageId) as
      MessageRow | undefined;
  }

  // ─── Attachments & reactions ──────────────────────────────────────────────

  upsertAttachment(row: AttachmentRow): void {
    this.db
      .prepare(
        `INSERT INTO attachments
           (attachment_id, message_id, filename, content_type, size, url, proxy_url, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id) DO UPDATE SET
           filename = excluded.filename,
           content_type = excluded.content_type,
           size = excluded.size,
           url = excluded.url,
           proxy_url = excluded.proxy_url,
           width = excluded.width,
           height = excluded.height`,
      )
      .run(
        row.attachment_id,
        row.message_id,
        row.filename,
        row.content_type,
        row.size,
        row.url,
        row.proxy_url,
        row.width,
        row.height,
      );
  }

  /** Stores a reaction once; the unique index makes repeats a no-op. */
  insertReaction(row: {
    message_id: string;
    emoji_id?: string | null;
    emoji_name?: string | null;
    user_id?: string | null;
    reactor_is_bot?: boolean;
    observed_at?: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reactions
           (message_id, emoji_id, emoji_name, user_id, reactor_is_bot, observed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.message_id,
        row.emoji_id ?? null,
        row.emoji_name ?? null,
        row.user_id ?? null,
        bool(row.reactor_is_bot),
        row.observed_at ?? nowIso(),
      );
  }

  /** Removes the matching reaction row(s); returns how many were deleted. */
  removeReaction(
    messageId: string,
    emoji: { id?: string | null; name?: string | null },
    userId: string | null,
  ): number {
    const info = this.db
      .prepare(
        `DELETE FROM reactions
         WHERE message_id = ?
           AND COALESCE(emoji_id, emoji_name, '') = COALESCE(?, ?, '')
           AND COALESCE(user_id, '') = COALESCE(?, '')`,
      )
      .run(messageId, emoji.id ?? null, emoji.name ?? null, userId ?? null);
    return Number(info.changes);
  }

  // ─── Voice sessions ───────────────────────────────────────────────────────

  findOpenVoiceSession(guildId: string, userId: string): VoiceSessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM voice_sessions WHERE guild_id = ? AND user_id = ? AND is_open = 1`)
      .get(guildId, userId) as VoiceSessionRow | undefined;
  }

  /** Opens a session unless one is already open for this user (idempotent). */
  openVoiceSession(row: {
    guild_id: string;
    channel_id: string;
    user_id: string;
    user_is_bot?: boolean;
    joined_at?: string;
  }): string | null {
    if (this.findOpenVoiceSession(row.guild_id, row.user_id)) return null;
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO voice_sessions
           (session_id, guild_id, channel_id, user_id, user_is_bot, joined_at, is_open, is_incomplete)
         VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
      )
      .run(
        id,
        row.guild_id,
        row.channel_id,
        row.user_id,
        bool(row.user_is_bot),
        row.joined_at ?? nowIso(),
      );
    return id;
  }

  /** Closes the open session for a user, computing duration in seconds. */
  closeVoiceSession(guildId: string, userId: string, leftAt = nowIso()): boolean {
    const open = this.findOpenVoiceSession(guildId, userId);
    if (!open) return false;
    const duration = Math.max(
      0,
      Math.round((Date.parse(leftAt) - Date.parse(open.joined_at)) / 1000),
    );
    this.db
      .prepare(
        `UPDATE voice_sessions SET left_at = ?, duration_seconds = ?, is_open = 0 WHERE session_id = ?`,
      )
      .run(leftAt, duration, open.session_id);
    return true;
  }

  /**
   * On startup, any session still marked open is stale (we cannot know the real
   * leave time). Flag it incomplete and close it WITHOUT inventing a duration.
   */
  markOpenSessionsIncomplete(): number {
    const info = this.db
      .prepare(
        `UPDATE voice_sessions
         SET is_open = 0, is_incomplete = 1, left_at = NULL, duration_seconds = NULL
         WHERE is_open = 1`,
      )
      .run();
    return Number(info.changes);
  }

  // ─── Sync runs ────────────────────────────────────────────────────────────

  startSyncRun(row: {
    guild_id: string;
    channel_id: string | null;
    requested_start_date: string | null;
    requested_max_messages: number | null;
  }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sync_runs
           (run_id, guild_id, channel_id, requested_start_date, requested_max_messages, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        id,
        row.guild_id,
        row.channel_id,
        row.requested_start_date,
        row.requested_max_messages,
        nowIso(),
      );
    return id;
  }

  finishSyncRun(
    runId: string,
    update: {
      status: SyncRunStatus;
      messages_imported: number;
      oldest_message_reached?: string | null;
      error_summary?: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET
           completed_at = ?, status = ?, messages_imported = ?,
           oldest_message_reached = ?, error_summary = ?
         WHERE run_id = ?`,
      )
      .run(
        nowIso(),
        update.status,
        update.messages_imported,
        update.oldest_message_reached ?? null,
        update.error_summary ?? null,
        runId,
      );
  }

  getSyncRuns(filter: SyncRunFilter): SyncRunRow[] {
    const where: string[] = [];
    const params: Bind[] = [];
    const add = (clause: string, value: Bind) => {
      where.push(clause);
      params.push(value);
    };
    if (filter.guildId) add("guild_id = ?", filter.guildId);
    if (filter.channelId) add("channel_id = ?", filter.channelId);
    if (filter.status) add("status = ?", filter.status);
    if (filter.startDate) add("date(started_at) >= ?", filter.startDate);
    if (filter.endDate) add("date(started_at) <= ?", filter.endDate);
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    const sql =
      `SELECT * FROM sync_runs` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY started_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, limit) as unknown as SyncRunRow[];
  }

  // ─── Aggregate reads for the tools ────────────────────────────────────────

  getMessageCounts(
    filter: MessageCountFilter,
    groupBy: MessageCountGroupBy,
  ): { group: string | null; count: number }[] {
    const groupExpr: Record<MessageCountGroupBy, string> = {
      guild: "guild_id",
      channel: "channel_id",
      member: "author_id",
      day: "substr(created_at, 1, 10)",
      week: "strftime('%Y-W%W', created_at)",
    };
    const where: string[] = [];
    const params: Bind[] = [];
    const add = (clause: string, value: Bind) => {
      where.push(clause);
      params.push(value);
    };
    if (filter.guildId) add("guild_id = ?", filter.guildId);
    if (filter.channelIds?.length) {
      where.push(`channel_id IN (${filter.channelIds.map(() => "?").join(",")})`);
      params.push(...filter.channelIds);
    }
    if (filter.memberIds?.length) {
      where.push(`author_id IN (${filter.memberIds.map(() => "?").join(",")})`);
      params.push(...filter.memberIds);
    }
    if (filter.startDate) add("date(created_at) >= ?", filter.startDate);
    if (filter.endDate) add("date(created_at) <= ?", filter.endDate);
    if (filter.includeBots === false) where.push("author_is_bot = 0");
    const expr = groupExpr[groupBy];
    const sql =
      `SELECT ${expr} AS group_key, COUNT(*) AS count FROM messages` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` GROUP BY ${expr} ORDER BY count DESC`;
    const rows = this.db.prepare(sql).all(...params) as unknown as {
      group_key: string | null;
      count: number;
    }[];
    return rows.map((r) => ({ group: r.group_key, count: r.count }));
  }

  getVoiceSessions(filter: VoiceSessionFilter): VoiceSessionRow[] {
    const where: string[] = [];
    const params: Bind[] = [];
    const add = (clause: string, value: Bind) => {
      where.push(clause);
      params.push(value);
    };
    if (filter.guildId) add("guild_id = ?", filter.guildId);
    if (filter.channelIds?.length) {
      where.push(`channel_id IN (${filter.channelIds.map(() => "?").join(",")})`);
      params.push(...filter.channelIds);
    }
    if (filter.memberIds?.length) {
      where.push(`user_id IN (${filter.memberIds.map(() => "?").join(",")})`);
      params.push(...filter.memberIds);
    }
    if (filter.startDate) add("date(joined_at) >= ?", filter.startDate);
    if (filter.endDate) add("date(joined_at) <= ?", filter.endDate);
    if (filter.includeBots === false) where.push("user_is_bot = 0");
    if (filter.includeIncomplete === false) where.push("is_incomplete = 0");
    const sql =
      `SELECT * FROM voice_sessions` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY joined_at DESC LIMIT 1000`;
    return this.db.prepare(sql).all(...params) as unknown as VoiceSessionRow[];
  }

  /** Row counts and last-sync timestamp for the status tool. */
  getStatusCounts(): {
    messages: number;
    channels: number;
    members: number;
    reactions: number;
    voiceSessions: number;
    openVoiceSessions: number;
    lastSyncAt: string | null;
  } {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;
    const last = this.db.prepare(`SELECT MAX(last_history_sync_at) AS t FROM guilds`).get() as {
      t: string | null;
    };
    return {
      messages: count("SELECT COUNT(*) c FROM messages"),
      channels: count("SELECT COUNT(*) c FROM channels"),
      members: count("SELECT COUNT(*) c FROM members"),
      reactions: count("SELECT COUNT(*) c FROM reactions"),
      voiceSessions: count("SELECT COUNT(*) c FROM voice_sessions"),
      openVoiceSessions: count("SELECT COUNT(*) c FROM voice_sessions WHERE is_open = 1"),
      lastSyncAt: last.t,
    };
  }
}
