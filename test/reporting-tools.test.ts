import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import analyticsModule from "../src/tools/analytics.js";
import { selectModules, handleTool, getAllDefinitions } from "../src/tools/index.js";
import { setAnalyticsRuntimeForTest, type AnalyticsRuntime } from "../src/analytics/runtime.js";
import { makeConfig } from "./analytics-helpers.js";
import { makeFixture, R } from "./reporting-helpers.js";

const PHASE3_TOOLS = [
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
  delete process.env.DISCORD_READ_ONLY;
  delete process.env.DISCORD_ALLOWED_GUILDS;
  delete process.env.DISCORD_ANALYTICS_STAFF_USER_IDS;
  setAnalyticsRuntimeForTest(null);
  mock.restoreAll();
});

/** Injects a runtime backed by a seeded in-memory repo (source deliberately null). */
function injectRuntime(seed = true): AnalyticsRuntime {
  const f = makeFixture();
  if (seed) {
    f.msg({
      message_id: "d10000000000000001",
      author_id: R.member,
      created_at: "2024-06-11T10:00:00.000Z",
      content: "how do I A?",
    });
  }
  const rt: AnalyticsRuntime = {
    enabled: true,
    active: true,
    config: makeConfig({ guildIds: [R.guild], storeMessageContent: true }),
    errors: [],
    db: null,
    repo: f.repo,
    source: null, // reporting must not need Discord
    collector: null,
  };
  setAnalyticsRuntimeForTest(rt);
  return rt;
}

// 78. The analytics toolset remains registered under `analytics` with the tools.
test("analytics toolset includes all eight Phase 3 tools", () => {
  process.env.DISCORD_MCP_TOOLSETS = "analytics";
  try {
    const names = new Set(selectModules().flatMap((m) => m.definitions.map((d) => d.name)));
    for (const t of PHASE3_TOOLS) assert.ok(names.has(t), `${t} registered`);
  } finally {
    delete process.env.DISCORD_MCP_TOOLSETS;
  }
});

// 72/73. Annotations: readOnlyHint true, discordWrite false.
test("all eight Phase 3 tools are read-only and non-Discord-writing", () => {
  const byName = Object.fromEntries(analyticsModule.definitions.map((d) => [d.name, d]));
  for (const t of PHASE3_TOOLS) {
    assert.equal(byName[t].annotations?.readOnlyHint, true, `${t} readOnlyHint`); // 72
    assert.equal(byName[t].discordWrite, false, `${t} discordWrite`); // 73
  }
});

// 74. All eight work while DISCORD_READ_ONLY=true (not blocked, exposed).
test("Phase 3 tools run and are exposed under DISCORD_READ_ONLY=true", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  injectRuntime();
  const exposed = new Set(getAllDefinitions().map((d) => d.name));
  for (const t of PHASE3_TOOLS) assert.ok(exposed.has(t), `${t} exposed in read-only mode`);

  const res = (await handleTool("discord_get_member_engagement", {
    guild_id: R.guild,
    start_date: "2024-06-10",
    end_date: "2024-06-16",
  })) as { isError?: boolean };
  assert.notEqual(res.isError, true, "reporting tool not blocked in read-only mode");
});

// 75. No Phase 3 reporting tool needs Discord (source is null yet tools work).
test("reporting tools work with no Discord source available", async () => {
  injectRuntime();
  const res = (await handleTool("discord_generate_weekly_metrics", {
    guild_id: R.guild,
    week_start_date: "2024-06-10",
  })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
  assert.notEqual(res.isError, true);
  assert.ok(res.structuredContent && "reportingPeriod" in res.structuredContent);
});

// 76. No Phase 3 reporting tool writes to SQLite.
test("reporting tools do not modify the database", async () => {
  const rt = injectRuntime();
  const before = rt.repo!.getStatusCounts();
  await handleTool("discord_get_staff_response_metrics", {
    guild_id: R.guild,
    start_date: "2024-06-10",
    end_date: "2024-06-16",
  });
  await handleTool("discord_get_unanswered_questions", { guild_id: R.guild });
  await handleTool("discord_get_office_hour_metrics", {
    guild_id: R.guild,
    start_date: "2024-06-10",
    end_date: "2024-06-16",
  });
  const after = rt.repo!.getStatusCounts();
  assert.deepEqual(after, before, "row counts unchanged after reporting");
});

// 77. No complete message content appears in logs or error output.
test("no message content leaks into logs or errors", async () => {
  const logged: string[] = [];
  mock.method(console, "error", (...a: unknown[]) => logged.push(a.join(" ")));
  const rt = injectRuntime(false);
  const secret = "PRIVATE-MEMBER-TEXT";
  const f = makeFixture();
  f.msg({
    message_id: "d20000000000000001",
    author_id: R.member,
    created_at: "2024-06-11T10:00:00.000Z",
    content: secret,
  });
  rt.repo = f.repo;
  setAnalyticsRuntimeForTest(rt);

  const res = (await handleTool("discord_get_unanswered_questions", {
    guild_id: R.guild,
    include_excerpt: false,
  })) as { content: { text?: string }[] };
  const output = JSON.stringify(res) + "\n" + logged.join("\n");
  assert.ok(!output.includes(secret), "message content must not appear in output or logs");

  // Unauthorised guild error must not contain content either.
  const err = (await handleTool("discord_get_member_engagement", {
    guild_id: "500000000000009999",
    start_date: "2024-06-10",
    end_date: "2024-06-16",
  })) as { isError?: boolean; content: { text?: string }[] };
  assert.equal(err.isError, true);
  assert.ok(!(err.content[0].text ?? "").includes(secret));
});

// The generic user-activity tool accepts a required user_id and reports on it.
test("discord_get_user_activity accepts user_id and reports on that user", async () => {
  injectRuntime();
  const res = (await handleTool("discord_get_user_activity", {
    guild_id: R.guild,
    user_id: R.member,
    start_date: "2024-06-10",
    end_date: "2024-06-16",
  })) as { isError?: boolean; structuredContent?: { userId?: string } };
  assert.notEqual(res.isError, true);
  assert.equal(res.structuredContent?.userId, R.member);

  // user_id is required: omitting it fails schema validation.
  await assert.rejects(
    () =>
      handleTool("discord_get_user_activity", {
        guild_id: R.guild,
        start_date: "2024-06-10",
        end_date: "2024-06-16",
      }),
    "user_id is required",
  );
});
