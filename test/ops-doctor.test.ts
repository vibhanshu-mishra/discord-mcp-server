import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { collectDoctorChecks, summarise, type Check } from "../src/cli/commands/doctor.js";
import { EXIT } from "../src/cli/exitCodes.js";
import { makeTempDir, cleanup, seedTempDb, OPS } from "./ops-helpers.js";

const ENV = [
  "DISCORD_TOKEN",
  "DISCORD_READ_ONLY",
  "DISCORD_ALLOWED_GUILDS",
  "DISCORD_ANALYTICS_DB_PATH",
  "DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT",
];
let dir = "";
afterEach(() => {
  ENV.forEach((k) => delete process.env[k]);
  if (dir) cleanup(dir);
  dir = "";
});

const find = (checks: Check[], name: string) => checks.find((c) => c.name === name)!;

// 7. Offline doctor does not connect to Discord (no online category).
test("offline doctor produces no online checks", () => {
  const checks = collectDoctorChecks();
  assert.ok(!checks.some((c) => c.category === "online"));
});

// 8. Missing token reported without revealing a value.
test("missing token reported as 'missing' without a value", () => {
  delete process.env.DISCORD_TOKEN;
  const c = find(collectDoctorChecks(), "discord-token");
  assert.equal(c.detail, "missing");
  process.env.DISCORD_TOKEN = "SECRETVALUE1234567890";
  const c2 = find(collectDoctorChecks(), "discord-token");
  assert.equal(c2.detail, "configured");
  assert.ok(!c2.detail.includes("SECRETVALUE"));
});

// 9. Read-only mode is reported.
test("read-only mode is reported", () => {
  delete process.env.DISCORD_READ_ONLY; // default = read-only on
  assert.equal(find(collectDoctorChecks(), "read-only-mode").status, "PASS");
  process.env.DISCORD_READ_ONLY = "false";
  const c = find(collectDoctorChecks(), "read-only-mode");
  assert.equal(c.status, "WARNING");
});

// 10. Invalid guild configuration is detected.
test("invalid allowed-guilds are detected", () => {
  process.env.DISCORD_ALLOWED_GUILDS = "not-a-snowflake";
  assert.equal(find(collectDoctorChecks(), "allowed-guilds").status, "FAIL");
});

// 12. Git-ignore checks work (default DB path is ignored in this repo).
test("git-ignore checks run", () => {
  const c = find(collectDoctorChecks(), "db-git-ignored");
  assert.ok(["PASS", "SKIPPED"].includes(c.status), "PASS in a git repo, SKIPPED without git");
});

// 13/14. Database schema checks work and open voice sessions warn.
test("database checks reflect a seeded database with an open voice session", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir, { withOpenVoice: true });
  process.env.DISCORD_ANALYTICS_DB_PATH = dbPath;
  const checks = collectDoctorChecks();
  assert.equal(find(checks, "integrity").status, "PASS"); // 13
  assert.equal(find(checks, "schema-version").status, "PASS");
  assert.equal(find(checks, "open-voice-sessions").status, "WARNING"); // 14
  assert.match(find(checks, "open-voice-sessions").detail, /1 open/);
});

// content-output enabled is flagged as a warning (privacy-sensitive).
test("content output enabled is flagged", () => {
  process.env.DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT = "true";
  assert.equal(find(collectDoctorChecks(), "content-output").status, "WARNING");
});

// 17. Exit codes distinguish warning from failure.
test("summarise: warnings exit 0, failures exit nonzero", () => {
  const warn: Check[] = [{ category: "config", name: "x", status: "WARNING", detail: "" }];
  assert.equal(summarise(warn).exit, EXIT.SUCCESS);
  const fail: Check[] = [{ category: "config", name: "x", status: "FAIL", detail: "" }];
  assert.equal(summarise(fail).exit, EXIT.CONFIG);
  const dbFail: Check[] = [{ category: "database", name: "integrity", status: "FAIL", detail: "" }];
  assert.equal(summarise(dbFail).exit, EXIT.DATABASE);
});

// 15. Online checks require an explicit flag (offline run makes no connection).
test("online checks require --online (unused param avoids a connection)", () => {
  // collectDoctorChecks (the offline collector) never has online checks; the
  // run() dispatcher only calls the online path when args.bool('online') is set.
  assert.ok(!collectDoctorChecks().some((c) => c.name === "authentication"));
  void OPS;
});
