/**
 * Shared fixtures for the Phase 3 reporting tests. All data is invented — no real
 * Discord IDs, users, or messages — and every database is in-memory.
 */
import { openDatabase } from "../src/analytics/database.js";
import { AnalyticsRepository, type MessageInput } from "../src/analytics/repository.js";
import { ReportingStore } from "../src/analytics/reporting/store.js";
import type { ReportingConfig } from "../src/analytics/reporting/config.js";
import type { ReportContext } from "../src/analytics/reporting/types.js";

export const R = {
  guild: "500000000000000001",
  channel: "500000000000000002",
  channel2: "500000000000000003",
  thread: "500000000000000004",
  voice: "500000000000000005",
  voice2: "500000000000000006",
  resource: "500000000000000007",
  member: "500000000000000010",
  member2: "500000000000000011",
  member3: "500000000000000012",
  staff: "500000000000000020",
  owner: "500000000000000021",
  bot: "500000000000000030",
};

export interface Fixture {
  repo: AnalyticsRepository;
  store: ReportingStore;
  msg: (
    input: Partial<MessageInput> & { message_id: string; author_id: string; created_at: string },
  ) => void;
  react: (
    messageId: string,
    userId: string,
    opts?: { isBot?: boolean; observedAt?: string },
  ) => void;
  channel: (id: string, opts?: { isThread?: boolean; parentId?: string; type?: number }) => void;
  member: (id: string, opts?: { username?: string; display?: string; isBot?: boolean }) => void;
  voice: (opts: {
    userId: string;
    channelId: string;
    joinedAt: string;
    leftAt?: string;
    isBot?: boolean;
    incomplete?: boolean;
  }) => void;
}

/** Creates an in-memory repository + reporting store with tiny insert helpers. */
export function makeFixture(storeContent = true): Fixture {
  const repo = new AnalyticsRepository(openDatabase(":memory:"), storeContent);
  const store = new ReportingStore(repo.connection, storeContent);
  repo.upsertGuild(R.guild, "Test Guild");

  const channel = (
    id: string,
    opts: { isThread?: boolean; parentId?: string; type?: number } = {},
  ) =>
    repo.upsertChannel({
      channel_id: id,
      guild_id: R.guild,
      name: `chan-${id}`,
      type: opts.type ?? 0,
      is_thread: opts.isThread,
      parent_channel_id: opts.parentId ?? null,
    });
  channel(R.channel);

  const member = (
    id: string,
    opts: { username?: string; display?: string; isBot?: boolean } = {},
  ) =>
    repo.upsertMember({
      user_id: id,
      guild_id: R.guild,
      username: opts.username ?? `user-${id}`,
      display_name: opts.display ?? `User ${id}`,
      is_bot: opts.isBot,
    });

  const msg: Fixture["msg"] = (input) =>
    repo.upsertMessage({
      guild_id: R.guild,
      channel_id: R.channel,
      content: null,
      ...input,
    });

  const react: Fixture["react"] = (messageId, userId, opts = {}) =>
    repo.insertReaction({
      message_id: messageId,
      emoji_name: "star",
      user_id: userId,
      reactor_is_bot: opts.isBot ?? false,
      observed_at: opts.observedAt,
    });

  const voice: Fixture["voice"] = (o) => {
    const id = repo.openVoiceSession({
      guild_id: R.guild,
      channel_id: o.channelId,
      user_id: o.userId,
      user_is_bot: o.isBot,
      joined_at: o.joinedAt,
    });
    if (o.incomplete) {
      repo.markOpenSessionsIncomplete();
    } else if (o.leftAt) {
      repo.closeVoiceSession(R.guild, o.userId, o.leftAt);
    }
    return void id;
  };

  return { repo, store, msg, react, channel, member, voice };
}

/** A reporting config with sensible test defaults. */
export function makeReporting(over: Partial<ReportingConfig> = {}): ReportingConfig {
  return {
    primaryUserId: R.owner,
    configuredStaffUserIds: [R.staff],
    staffUserIds: [R.staff, R.owner],
    resourceChannelIds: [R.resource],
    officeHourChannelIds: [R.voice],
    responseWindowHours: 24,
    acknowledgementWindowHours: 24,
    timezone: "UTC",
    weekStart: "MONDAY",
    trainingKeywords: ["training", "workshop", "office hours"],
    ...over,
  };
}

/** Bundles a store + reporting config + fixed clock into a ReportContext. */
export function ctxOf(
  store: ReportingStore,
  reporting: ReportingConfig,
  now = "2024-07-01T00:00:00.000Z",
): ReportContext {
  return { store, reporting, now: new Date(now) };
}
