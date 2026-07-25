import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import analyticsModule from "../src/tools/analytics.js";
import { selectModules, getAllDefinitions, handleTool } from "../src/tools/index.js";
import { setAnalyticsRuntimeForTest, type AnalyticsRuntime } from "../src/analytics/runtime.js";
import { makeConfig } from "./analytics-helpers.js";
import { makeQualFixture, Q } from "./qualitative-helpers.js";

const PHASE4_TOOLS = [
  "discord_get_conversation_context",
  "discord_get_topic_candidates",
  "discord_get_recurring_question_candidates",
  "discord_get_feedback_signals",
  "discord_get_channel_conversation_summary_packet",
  "discord_generate_qualitative_analysis_packet",
];

afterEach(() => {
  delete process.env.DISCORD_READ_ONLY;
  delete process.env.DISCORD_ALLOWED_GUILDS;
  delete process.env.DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT;
  setAnalyticsRuntimeForTest(null);
  mock.restoreAll();
});

const SECRET = "PRIVATE-QUALITATIVE-BODY";

function injectRuntime(): AnalyticsRuntime {
  const f = makeQualFixture();
  f.msg({
    message_id: "760000000000000001",
    author_id: Q.member1,
    content: `${SECRET} deploy failed`,
    created_at: "2024-06-11T10:00:00.000Z",
  });
  f.msg({
    message_id: "760000000000000002",
    author_id: Q.member2,
    content: "deploy failed again",
    created_at: "2024-06-11T10:05:00.000Z",
  });
  const rt: AnalyticsRuntime = {
    enabled: true,
    active: true,
    config: makeConfig({ guildIds: [Q.guild], storeMessageContent: true }),
    errors: [],
    db: null,
    repo: f.repo,
    source: null, // qualitative tools must not need Discord
    collector: null,
  };
  setAnalyticsRuntimeForTest(rt);
  return rt;
}

// 66. The analytics toolset stays registered with all six Phase 4 tools.
test("analytics toolset includes all six Phase 4 tools", () => {
  process.env.DISCORD_MCP_TOOLSETS = "analytics";
  try {
    const names = new Set(selectModules().flatMap((m) => m.definitions.map((d) => d.name)));
    for (const t of PHASE4_TOOLS) assert.ok(names.has(t), `${t} registered`);
  } finally {
    delete process.env.DISCORD_MCP_TOOLSETS;
  }
});

// 61/62. readOnlyHint true and discordWrite false for all six.
test("all six Phase 4 tools are read-only and non-Discord-writing", () => {
  const byName = Object.fromEntries(analyticsModule.definitions.map((d) => [d.name, d]));
  for (const t of PHASE4_TOOLS) {
    assert.equal(byName[t].annotations?.readOnlyHint, true, `${t} readOnlyHint`);
    assert.equal(byName[t].discordWrite, false, `${t} discordWrite`);
  }
});

// 63/64. All six run and are exposed under DISCORD_READ_ONLY=true (no Discord needed).
test("Phase 4 tools run and are exposed under DISCORD_READ_ONLY=true", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  injectRuntime();
  const exposed = new Set(getAllDefinitions().map((d) => d.name));
  for (const t of PHASE4_TOOLS) assert.ok(exposed.has(t), `${t} exposed`);

  const calls: [string, Record<string, unknown>][] = [
    [
      "discord_get_topic_candidates",
      { guild_id: Q.guild, start_date: "2024-06-08", end_date: "2024-06-14" },
    ],
    [
      "discord_get_recurring_question_candidates",
      { guild_id: Q.guild, start_date: "2024-06-08", end_date: "2024-06-14" },
    ],
    [
      "discord_get_feedback_signals",
      { guild_id: Q.guild, start_date: "2024-06-08", end_date: "2024-06-14" },
    ],
    ["discord_get_conversation_context", { guild_id: Q.guild, message_id: "760000000000000001" }],
    [
      "discord_get_channel_conversation_summary_packet",
      {
        guild_id: Q.guild,
        channel_id: Q.channel,
        start_date: "2024-06-08",
        end_date: "2024-06-14",
      },
    ],
    [
      "discord_generate_qualitative_analysis_packet",
      { guild_id: Q.guild, start_date: "2024-06-08", end_date: "2024-06-14" },
    ],
  ];
  for (const [name, args] of calls) {
    const res = (await handleTool(name, args)) as { isError?: boolean };
    assert.notEqual(res.isError, true, `${name} runs without error in read-only mode`);
  }
});

// 65. No Phase 4 tool writes to SQLite.
test("Phase 4 tools do not modify the database", async () => {
  const rt = injectRuntime();
  const before = rt.repo!.getStatusCounts();
  await handleTool("discord_get_topic_candidates", {
    guild_id: Q.guild,
    start_date: "2024-06-08",
    end_date: "2024-06-14",
  });
  await handleTool("discord_generate_qualitative_analysis_packet", {
    guild_id: Q.guild,
    start_date: "2024-06-08",
    end_date: "2024-06-14",
  });
  await handleTool("discord_get_channel_conversation_summary_packet", {
    guild_id: Q.guild,
    channel_id: Q.channel,
    start_date: "2024-06-08",
    end_date: "2024-06-14",
  });
  assert.deepEqual(rt.repo!.getStatusCounts(), before);
});

// 12. Message content never appears in outputs (content output disabled) or logs.
test("message content never leaks into output or logs when content output is disabled", async () => {
  const logged: string[] = [];
  mock.method(console, "error", (...a: unknown[]) => logged.push(a.join(" ")));
  injectRuntime(); // content output defaults to false
  const res = await handleTool("discord_generate_qualitative_analysis_packet", {
    guild_id: Q.guild,
    start_date: "2024-06-08",
    end_date: "2024-06-14",
    include_evidence: true,
  });
  const all = JSON.stringify(res) + "\n" + logged.join("\n");
  assert.ok(!all.includes(SECRET), "secret content must not appear anywhere");
});

// Unauthorised guild → clear error, no content.
test("unauthorised guild returns a clear error without content", async () => {
  injectRuntime();
  const res = (await handleTool("discord_get_topic_candidates", {
    guild_id: "760000000000009999",
    start_date: "2024-06-08",
    end_date: "2024-06-14",
  })) as { isError?: boolean; content: { text?: string }[] };
  assert.equal(res.isError, true);
  assert.ok(!(res.content[0].text ?? "").includes(SECRET));
});
