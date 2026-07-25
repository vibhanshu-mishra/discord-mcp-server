import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  generateReport,
  supportsCsv,
  tabularRows,
  toCsv,
  REPORT_TYPES,
} from "../src/operations/export.js";
import { makeTempDir, cleanup, seedTempDb, OPS, SECRET_CONTENT } from "./ops-helpers.js";

const ENV = [
  "DISCORD_ANALYTICS_GUILD_IDS",
  "DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT",
  "DISCORD_ANALYTICS_TOPIC_MIN_MESSAGES",
  "DISCORD_ANALYTICS_PSEUDONYMIZE_USERS",
];
let dir = "";
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  if (dir) cleanup(dir);
  dir = "";
});

function setup(allowContent: boolean): string {
  dir = makeTempDir();
  process.env.DISCORD_ANALYTICS_GUILD_IDS = OPS.guild;
  process.env.DISCORD_ANALYTICS_TOPIC_MIN_MESSAGES = "2";
  process.env.DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT = allowContent ? "true" : "false";
  return seedTempDb(dir);
}

const RANGE = { startDate: "2024-06-01", endDate: "2025-01-31" };

// 53. JSON exports reuse existing reporting services.
test("generateReport reuses reporting services (all report types produce objects)", () => {
  const db = setup(false);
  for (const reportType of REPORT_TYPES) {
    const report = generateReport({ reportType, guildId: OPS.guild, ...RANGE, dbPath: db });
    assert.equal(typeof report, "object");
    assert.ok("methodology" in report || "reportingPeriod" in report || "period" in report);
  }
});

// 54/55. CSV works for tabular reports; nested reports are rejected.
test("CSV is supported for tabular reports and rejected for nested ones", () => {
  const db = setup(false);
  assert.ok(supportsCsv("member-engagement"));
  assert.ok(!supportsCsv("weekly-metrics"));
  const report = generateReport({
    reportType: "member-engagement",
    guildId: OPS.guild,
    ...RANGE,
    dbPath: db,
  });
  const rows = tabularRows("member-engagement", report)!;
  const csv = toCsv(rows);
  assert.ok(csv.includes("\n"), "CSV has a header and rows");
  assert.ok(!csv.includes(SECRET_CONTENT), "no message content in CSV");
});

// 56/57. Excerpts absent by default; evidence needs all gates.
test("excerpts require content storage AND content output AND include-evidence", () => {
  // Content output OFF: even with include-evidence, no excerpts.
  const dbOff = setup(false);
  const off = generateReport({
    reportType: "topic-candidates",
    guildId: OPS.guild,
    ...RANGE,
    includeEvidence: true,
    dbPath: dbOff,
  }) as {
    topics: { evidence?: { excerpt: string | null }[] }[];
  };
  const offExcerpts = off.topics.flatMap((t) => t.evidence ?? []).map((e) => e.excerpt);
  assert.ok(
    offExcerpts.every((e) => e === null),
    "no excerpt when content output disabled",
  );
  cleanup(dir);

  // Content output ON + stored + include-evidence: excerpt present.
  const dbOn = setup(true);
  const on = generateReport({
    reportType: "topic-candidates",
    guildId: OPS.guild,
    ...RANGE,
    includeEvidence: true,
    dbPath: dbOn,
  }) as {
    topics: {
      evidence?: { excerpt: string | null; author: { label?: string; userId?: string } }[];
    }[];
  };
  const evidence = on.topics.flatMap((t) => t.evidence ?? []);
  assert.ok(evidence.length > 0, "evidence produced");
  assert.ok(
    evidence.some((e) => typeof e.excerpt === "string"),
    "excerpt present when all gates open",
  ); // 57
  // 58. Pseudonymisation preserved: author is a label, never a raw user ID.
  for (const e of evidence) {
    assert.equal(e.author.userId, undefined, "no raw user ID");
    assert.ok(
      e.author.label?.startsWith("Member") ||
        e.author.label?.startsWith("Staff") ||
        e.author.label === "Primary User",
    );
  }
});

// 56 (default). Without include-evidence there is no evidence array at all.
test("aggregate export has no evidence by default", () => {
  const db = setup(true);
  const report = generateReport({
    reportType: "topic-candidates",
    guildId: OPS.guild,
    ...RANGE,
    dbPath: db,
  }) as {
    topics: { evidence?: unknown }[];
  };
  assert.ok(report.topics.every((t) => t.evidence === undefined));
});

// 59. Attachment URLs are never present in evidence.
test("evidence never contains attachment URLs", () => {
  const db = setup(true);
  const report = generateReport({
    reportType: "feedback-signals",
    guildId: OPS.guild,
    ...RANGE,
    includeEvidence: true,
    dbPath: db,
  });
  const s = JSON.stringify(report);
  assert.ok(!/cdn\.discordapp\.com|attachments\//.test(s), "no attachment URLs");
});
