/**
 * Shared test utilities for the analytics suites. Everything here is invented —
 * fake guilds, channels, users, and messages with obviously-fictional snowflakes.
 * No real Discord data, tokens, or network access is ever involved.
 */
import { openDatabase } from "../src/analytics/database.js";
import { AnalyticsRepository } from "../src/analytics/repository.js";
import type { AnalyticsConfig } from "../src/analytics/types.js";
import type {
  DiscordSource,
  SourceChannel,
  SourceGuild,
  SourceMessage,
} from "../src/analytics/sync.js";

/** Fictional IDs used across the tests. */
export const IDS = {
  guild: "111111111111111111",
  otherGuild: "999999999999999999",
  channelA: "222222222222222222",
  channelB: "333333333333333333",
  voiceChannel: "444444444444444444",
  voiceChannel2: "555555555555555555",
  user: "666666666666666666",
  bot: "777777777777777777",
};

/** An in-memory repository for a single test (no files touched). */
export function makeRepo(storeContent = true): AnalyticsRepository {
  return new AnalyticsRepository(openDatabase(":memory:"), storeContent);
}

/** A minimal valid config for direct service tests. */
export function makeConfig(over: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    enabled: true,
    dbPath: ":memory:",
    guildIds: [IDS.guild],
    historyStartDate: null,
    syncPageLimit: 100,
    collectVoice: true,
    collectBotDms: false,
    storeMessageContent: true,
    ...over,
  };
}

/** Builds one fake history message with sensible defaults. */
export function fakeSourceMessage(over: Partial<SourceMessage> & { id: string }): SourceMessage {
  return {
    createdAt: "2024-06-01T12:00:00.000Z",
    editedAt: null,
    authorId: IDS.user,
    authorUsername: "alice",
    authorDisplayName: "Alice",
    authorIsBot: false,
    content: "hello world",
    referencedMessageId: null,
    isReply: false,
    pinned: false,
    type: 0,
    attachments: [],
    reactionCount: 0,
    ...over,
  };
}

/**
 * Builds a fake {@link DiscordSource} that serves the given per-channel message
 * lists (newest-first) through backward pagination. A channel whose id is in
 * `failChannels` throws on fetch, to exercise per-channel failure isolation.
 * The returned object also records that only READ methods were ever used.
 */
export function makeFakeSource(opts: {
  guildId?: string;
  guildName?: string | null;
  channels: { id: string; type?: number; messages: SourceMessage[] }[];
  failChannels?: string[];
}): DiscordSource & { fetchCalls: number } {
  const guildId = opts.guildId ?? IDS.guild;
  const fail = new Set(opts.failChannels ?? []);
  const state = { fetchCalls: 0 };

  const channels: SourceChannel[] = opts.channels.map((c) => {
    // Newest-first, so pagination walks backwards via `before`.
    const ordered = [...c.messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      id: c.id,
      guildId,
      parentId: null,
      name: `channel-${c.id}`,
      type: c.type ?? 0,
      isThread: false,
      archived: false,
      async fetchMessages({ limit, before }) {
        state.fetchCalls += 1;
        if (fail.has(c.id)) throw new Error("Missing Access");
        let pool = ordered;
        if (before) {
          const idx = ordered.findIndex((m) => m.id === before);
          pool = idx >= 0 ? ordered.slice(idx + 1) : [];
        }
        return pool.slice(0, limit);
      },
    };
  });

  const guild: SourceGuild = {
    id: guildId,
    name: opts.guildName ?? "Test Guild",
    async listChannels() {
      return channels;
    },
  };

  const source: DiscordSource = {
    async getGuild(id: string) {
      return id === guildId ? guild : null;
    },
  };
  Object.defineProperty(source, "fetchCalls", { get: () => state.fetchCalls });
  return source as DiscordSource & { fetchCalls: number };
}
