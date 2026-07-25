/**
 * Shared fixtures for the Phase 4 qualitative-analysis tests. All data is
 * invented — generic IDs, generic member/staff labels, no real people, messages,
 * or URLs — and every database is in-memory.
 */
import { openDatabase } from "../src/analytics/database.js";
import { AnalyticsRepository, type MessageInput } from "../src/analytics/repository.js";
import { QualitativeStore } from "../src/analytics/qualitative/store.js";
import { ReportingStore } from "../src/analytics/reporting/store.js";
import { OutputPolicy } from "../src/analytics/qualitative/contentPolicy.js";
import type { QualitativeConfig } from "../src/analytics/qualitative/config.js";
import type { QualContext } from "../src/analytics/qualitative/types.js";
import type { ReportingConfig } from "../src/analytics/reporting/config.js";

export const Q = {
  guild: "600000000000000001",
  channel: "600000000000000002",
  channel2: "600000000000000003",
  thread: "600000000000000004",
  excluded: "600000000000000009",
  member1: "600000000000000010",
  member2: "600000000000000011",
  member3: "600000000000000012",
  staff1: "600000000000000020",
  primary: "600000000000000021",
};

export interface QualFixture {
  repo: AnalyticsRepository;
  qStore: QualitativeStore;
  rStore: ReportingStore;
  msg: (
    input: Partial<MessageInput> & { message_id: string; author_id: string; created_at: string },
  ) => void;
  react: (messageId: string, userId: string) => void;
  channel: (id: string, opts?: { isThread?: boolean; parentId?: string; type?: number }) => void;
}

export function makeQualFixture(storeContent = true): QualFixture {
  const repo = new AnalyticsRepository(openDatabase(":memory:"), storeContent);
  repo.upsertGuild(Q.guild, "Test Guild");
  const channel = (
    id: string,
    opts: { isThread?: boolean; parentId?: string; type?: number } = {},
  ) =>
    repo.upsertChannel({
      channel_id: id,
      guild_id: Q.guild,
      name: `chan-${id}`,
      type: opts.type ?? 0,
      is_thread: opts.isThread,
      parent_channel_id: opts.parentId ?? null,
    });
  channel(Q.channel);
  const msg: QualFixture["msg"] = (input) =>
    repo.upsertMessage({ guild_id: Q.guild, channel_id: Q.channel, content: null, ...input });
  const react: QualFixture["react"] = (messageId, userId) =>
    repo.insertReaction({ message_id: messageId, emoji_name: "star", user_id: userId });
  return {
    repo,
    qStore: new QualitativeStore(repo.connection, storeContent),
    rStore: new ReportingStore(repo.connection, storeContent),
    msg,
    react,
    channel,
  };
}

export function makeQualConfig(over: Partial<QualitativeConfig> = {}): QualitativeConfig {
  return {
    allowContentOutput: false,
    maxExcerptCharacters: 240,
    maxEvidenceMessages: 100,
    redactMentions: true,
    pseudonymizeUsers: true,
    excludedChannelIds: [],
    includeStaff: false,
    topicMinMessages: 2,
    topicLimit: 15,
    questionSimilarityThreshold: 0.5,
    ...over,
  };
}

export function makeReportingConfig(over: Partial<ReportingConfig> = {}): ReportingConfig {
  return {
    primaryUserId: Q.primary,
    configuredStaffUserIds: [Q.staff1],
    staffUserIds: [Q.staff1, Q.primary],
    resourceChannelIds: [],
    officeHourChannelIds: [],
    responseWindowHours: 24,
    acknowledgementWindowHours: 24,
    timezone: "UTC",
    weekStart: "MONDAY",
    trainingKeywords: ["training"],
    ...over,
  };
}

/** Builds a full QualContext for a fixture, with a fixed clock. */
export function makeQualCtx(
  f: QualFixture,
  opts: {
    qcfg?: QualitativeConfig;
    reporting?: ReportingConfig;
    storeContent?: boolean;
    now?: string;
  } = {},
): QualContext {
  const qcfg = opts.qcfg ?? makeQualConfig();
  const reporting = opts.reporting ?? makeReportingConfig();
  const storeContent = opts.storeContent ?? f.qStore.storeContent;
  const now = new Date(opts.now ?? "2024-07-01T00:00:00.000Z");
  return {
    qStore: f.qStore,
    report: { store: f.rStore, reporting, now },
    qualitative: qcfg,
    policy: new OutputPolicy(storeContent, qcfg),
    now,
  };
}
