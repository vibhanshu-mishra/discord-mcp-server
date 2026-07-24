import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import analyticsModule from "../src/tools/analytics.js";
import { selectModules, getAllDefinitions, handleTool } from "../src/tools/index.js";
import { ReadOnlyModeError } from "../src/readonly.js";
import { setAnalyticsRuntimeForTest, type AnalyticsRuntime } from "../src/analytics/runtime.js";
import {
  makeRepo,
  makeConfig,
  makeFakeSource,
  fakeSourceMessage,
  IDS,
} from "./analytics-helpers.js";

const ANALYTICS_TOOL_NAMES = [
  // Phase 2
  "discord_analytics_status",
  "discord_sync_message_history",
  "discord_get_sync_runs",
  "discord_get_stored_message_counts",
  "discord_get_voice_sessions",
  // Phase 3 reporting
  "discord_get_member_engagement",
  "discord_get_user_activity",
  "discord_get_staff_response_metrics",
  "discord_get_unanswered_questions",
  "discord_get_unacknowledged_messages",
  "discord_get_training_cadence",
  "discord_get_office_hour_metrics",
  "discord_generate_weekly_metrics",
];

afterEach(() => {
  delete process.env.DISCORD_MCP_TOOLSETS;
  delete process.env.DISCORD_READ_ONLY;
  delete process.env.DISCORD_ALLOWED_GUILDS;
  setAnalyticsRuntimeForTest(null);
});

/** Injects a working, in-memory analytics runtime for tool tests. */
function injectRuntime(over: Partial<AnalyticsRuntime> = {}): AnalyticsRuntime {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [{ id: IDS.channelA, messages: [fakeSourceMessage({ id: "830000000000000001" })] }],
  });
  const rt: AnalyticsRuntime = {
    enabled: true,
    active: true,
    config: makeConfig(),
    errors: [],
    db: null,
    repo,
    source,
    collector: null,
    ...over,
  };
  setAnalyticsRuntimeForTest(rt);
  return rt;
}

// 31. The analytics module is registered under the `analytics` key.
test("analytics toolset is selectable by its key and holds the 5 tools", () => {
  process.env.DISCORD_MCP_TOOLSETS = "analytics";
  const selected = selectModules();
  assert.equal(selected.length, 1, "only the analytics module is selected");
  const names = selected[0].definitions.map((d) => d.name).sort();
  assert.deepEqual(names, [...ANALYTICS_TOOL_NAMES].sort());
});

// 32. DISCORD_MCP_TOOLSETS=analytics selects the analytics module correctly.
test("DISCORD_MCP_TOOLSETS=analytics selects exactly the analytics tools", () => {
  process.env.DISCORD_MCP_TOOLSETS = "analytics";
  const names = new Set(selectModules().flatMap((m) => m.definitions.map((d) => d.name)));
  for (const n of ANALYTICS_TOOL_NAMES) assert.ok(names.has(n), `${n} selected`);
  assert.ok(!names.has("discord_send_message"), "non-analytics tools are not selected");
  assert.equal(names.size, ANALYTICS_TOOL_NAMES.length, "only analytics tools selected");
});

// MCP annotations are honest; the internal discordWrite flag is never leaked.
test("annotations are honest and discordWrite is internal-only", () => {
  const byName = Object.fromEntries(analyticsModule.definitions.map((d) => [d.name, d]));
  // Inspection tools: readOnlyHint true.
  assert.equal(byName.discord_analytics_status.annotations?.readOnlyHint, true);
  assert.equal(byName.discord_get_voice_sessions.annotations?.readOnlyHint, true);
  // The sync tool honestly reports a side effect (local write) yet never mutates Discord.
  assert.equal(byName.discord_sync_message_history.annotations?.readOnlyHint, false);
  assert.equal(byName.discord_sync_message_history.discordWrite, false);
  // Every analytics tool is classified as a non-Discord-writer.
  for (const d of analyticsModule.definitions) assert.equal(d.discordWrite, false);
  // The internal flag must never be advertised to clients.
  process.env.DISCORD_READ_ONLY = "false";
  for (const d of getAllDefinitions()) {
    assert.ok(!("discordWrite" in d), `${d.name} must not expose discordWrite over the wire`);
  }
});

// 29. discord_sync_message_history is usable while DISCORD_READ_ONLY=true.
test("sync tool runs in read-only mode and writes only to the local DB", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  const rt = injectRuntime();
  // Exposed even in read-only mode (it does not mutate Discord).
  assert.ok(
    getAllDefinitions().some((d) => d.name === "discord_sync_message_history"),
    "sync tool is exposed in read-only mode",
  );
  // And it actually runs (no ReadOnlyModeError) and imports to the local DB.
  const res = (await handleTool("discord_sync_message_history", { guild_id: IDS.guild })) as {
    isError?: boolean;
    structuredContent?: { totalMessages: number };
  };
  assert.notEqual(res.isError, true, "sync must not be blocked in read-only mode");
  assert.equal(res.structuredContent?.totalMessages, 1);
  assert.equal(rt.repo!.getMessageCounts({ guildId: IDS.guild }, "guild")[0].count, 1);
});

test("sync tool rejects a guild not authorised by both allow-lists", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  injectRuntime({ config: makeConfig({ guildIds: [IDS.guild] }) });
  const res = (await handleTool("discord_sync_message_history", { guild_id: IDS.otherGuild })) as {
    isError?: boolean;
  };
  assert.equal(res.isError, true, "unauthorised guild is refused");
});

test("sync tool reports clearly when analytics is disabled", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  setAnalyticsRuntimeForTest({
    enabled: false,
    active: false,
    config: makeConfig({ enabled: false }),
    errors: [],
    db: null,
    repo: null,
    source: null,
    collector: null,
  });
  const res = (await handleTool("discord_sync_message_history", { guild_id: IDS.guild })) as {
    isError?: boolean;
  };
  assert.equal(res.isError, true);
});

// 30. Genuine Discord write tools remain hidden AND blocked in read-only mode.
test("Discord write tools stay hidden and blocked while analytics tools are allowed", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  injectRuntime();
  const names = new Set(getAllDefinitions().map((d) => d.name));
  assert.ok(!names.has("discord_send_message"), "send-message hidden");
  assert.ok(names.has("discord_analytics_status"), "analytics read tool visible");
  await assert.rejects(
    () => handleTool("discord_send_message", { channel_id: IDS.channelA, content: "x" }),
    ReadOnlyModeError,
  );
});

// status tool works even when analytics is disabled (no DB required).
test("analytics_status works with analytics disabled", async () => {
  setAnalyticsRuntimeForTest({
    enabled: false,
    active: false,
    config: makeConfig({ enabled: false, guildIds: [] }),
    errors: [],
    db: null,
    repo: null,
    source: null,
    collector: null,
  });
  const res = (await handleTool("discord_analytics_status", {})) as {
    isError?: boolean;
    structuredContent?: { enabled: boolean; messageCount: number };
  };
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent?.enabled, false);
  assert.equal(res.structuredContent?.messageCount, 0);
});
