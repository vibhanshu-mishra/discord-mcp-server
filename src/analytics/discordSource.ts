/**
 * Adapts the shared discord.js client to the {@link DiscordSource} interface the
 * history sync consumes. This is a thin, READ-ONLY translation layer: it only
 * fetches guilds, channels, threads, and message pages — it never issues a write.
 *
 * The sync *algorithm* is unit-tested against fake sources; this adapter maps the
 * live Discord API and so is exercised only against a real bot, never in tests.
 */
import {
  ChannelType,
  type Client,
  type GuildBasedChannel,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import type { DiscordSource, SourceChannel, SourceGuild, SourceMessage } from "./sync.js";

/** Channel types whose linear message history we page through. */
const TEXTLIKE_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

function normalizeMessage(m: Message): SourceMessage {
  const attachments = [...m.attachments.values()].map((a) => ({
    id: a.id,
    filename: a.name ?? null,
    contentType: a.contentType ?? null,
    size: a.size ?? null,
    url: a.url ?? null,
    proxyUrl: a.proxyURL ?? null,
    width: a.width ?? null,
    height: a.height ?? null,
  }));
  const reactionCount = [...m.reactions.cache.values()].reduce((sum, r) => sum + (r.count ?? 0), 0);
  return {
    id: m.id,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    authorId: m.author?.id ?? null,
    authorUsername: m.author?.username ?? null,
    authorDisplayName: m.member?.displayName ?? m.author?.globalName ?? m.author?.username ?? null,
    authorIsBot: m.author?.bot ?? false,
    content: m.content ?? null,
    referencedMessageId: m.reference?.messageId ?? null,
    isReply: Boolean(m.reference?.messageId),
    pinned: m.pinned,
    type: m.type,
    attachments,
    reactionCount,
  };
}

function toSourceChannel(channel: GuildBasedChannel & TextBasedChannel): SourceChannel {
  const isThread = channel.isThread();
  return {
    id: channel.id,
    guildId: channel.guildId,
    parentId: channel.parentId ?? null,
    name: "name" in channel ? (channel.name ?? null) : null,
    type: channel.type,
    isThread,
    archived: isThread ? (channel.archived ?? false) : false,
    async fetchMessages({ limit, before }) {
      const page = await channel.messages.fetch({ limit, before, cache: false });
      return [...page.values()]
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .map(normalizeMessage);
    },
  };
}

/** Builds a live DiscordSource backed by the shared discord.js client. */
export function createDiscordSource(client: Client): DiscordSource {
  return {
    async getGuild(guildId: string): Promise<SourceGuild | null> {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return null;
      return {
        id: guild.id,
        name: guild.name,
        async listChannels(): Promise<SourceChannel[]> {
          const out: SourceChannel[] = [];
          const seen = new Set<string>();
          const add = (c: GuildBasedChannel) => {
            if (seen.has(c.id)) return;
            if (!("messages" in c) || !TEXTLIKE_TYPES.has(c.type)) return;
            seen.add(c.id);
            out.push(toSourceChannel(c as GuildBasedChannel & TextBasedChannel));
          };

          const channels = await guild.channels.fetch();
          for (const channel of channels.values()) {
            if (!channel) continue;
            add(channel);

            // Threads and forum posts live under their parent; collect active and
            // (where Discord permits) archived ones.
            if ("threads" in channel && channel.threads) {
              try {
                const active = await channel.threads.fetchActive();
                active.threads.forEach(add);
              } catch {
                /* thread listing not permitted — skip */
              }
              try {
                const archived = await channel.threads.fetchArchived();
                archived.threads.forEach(add);
              } catch {
                /* archived threads not permitted — skip */
              }
            }
          }
          return out;
        },
      };
    },
  };
}
