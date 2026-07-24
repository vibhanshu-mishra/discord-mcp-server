import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  validateAnalyticsConfig,
  isAnalyticsEnabled,
  isAnalyticsGuildAuthorised,
  DEFAULT_DB_PATH,
} from "../src/analytics/config.js";
import { IDS } from "./analytics-helpers.js";

const ANALYTICS_ENV = [
  "DISCORD_ANALYTICS_ENABLED",
  "DISCORD_ANALYTICS_DB_PATH",
  "DISCORD_ANALYTICS_GUILD_IDS",
  "DISCORD_ANALYTICS_HISTORY_START_DATE",
  "DISCORD_ANALYTICS_SYNC_PAGE_LIMIT",
  "DISCORD_ANALYTICS_COLLECT_VOICE",
  "DISCORD_ANALYTICS_COLLECT_BOT_DMS",
  "DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT",
  "DISCORD_ALLOWED_GUILDS",
];

afterEach(() => {
  for (const key of ANALYTICS_ENV) delete process.env[key];
});

// 1. Analytics defaults to disabled.
test("analytics is disabled by default", () => {
  assert.equal(isAnalyticsEnabled(), false);
  assert.equal(validateAnalyticsConfig().config.enabled, false);
});

// 2. The database path defaults correctly.
test("database path defaults to data/discord-analytics.sqlite", () => {
  assert.equal(validateAnalyticsConfig().config.dbPath, DEFAULT_DB_PATH);
  assert.equal(DEFAULT_DB_PATH, "data/discord-analytics.sqlite");
});

// 3. Invalid analytics configuration fails safely (records errors, never throws).
test("invalid values are reported and safely defaulted", () => {
  process.env.DISCORD_ANALYTICS_ENABLED = "true";
  process.env.DISCORD_ANALYTICS_GUILD_IDS = IDS.guild;
  process.env.DISCORD_ANALYTICS_HISTORY_START_DATE = "not-a-date";
  process.env.DISCORD_ANALYTICS_SYNC_PAGE_LIMIT = "-5";
  process.env.DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT = "maybe";
  const { config, errors } = validateAnalyticsConfig();
  assert.ok(errors.length >= 3, "each invalid value should be reported");
  assert.equal(config.historyStartDate, null, "bad date falls back to null");
  assert.equal(config.syncPageLimit, 100, "bad page limit falls back to default");
  assert.equal(config.storeMessageContent, true, "bad boolean falls back to default");
});

test("page limit is clamped to the safe upper bound", () => {
  process.env.DISCORD_ANALYTICS_SYNC_PAGE_LIMIT = "100000";
  assert.equal(validateAnalyticsConfig().config.syncPageLimit, 100);
});

// 5/6/7. A guild must be permitted by BOTH DISCORD_ANALYTICS_GUILD_IDS and
// DISCORD_ALLOWED_GUILDS; missing from either → rejected.
test("guild must be authorised by BOTH allow-lists", () => {
  // In analytics list AND allow-list → authorised.
  process.env.DISCORD_ANALYTICS_GUILD_IDS = IDS.guild;
  process.env.DISCORD_ALLOWED_GUILDS = IDS.guild;
  assert.ok(isAnalyticsGuildAuthorised(IDS.guild));

  // In analytics list but NOT in allow-list → rejected (and reported).
  process.env.DISCORD_ALLOWED_GUILDS = IDS.otherGuild;
  const { config, errors } = validateAnalyticsConfig();
  assert.ok(!config.guildIds.includes(IDS.guild), "guild outside allow-list is dropped");
  assert.ok(!isAnalyticsGuildAuthorised(IDS.guild, config));
  assert.ok(errors.some((e) => e.includes("DISCORD_ALLOWED_GUILDS")));
});

test("guild in allow-list but not analytics list is rejected", () => {
  process.env.DISCORD_ANALYTICS_GUILD_IDS = "";
  process.env.DISCORD_ALLOWED_GUILDS = IDS.guild;
  assert.ok(!isAnalyticsGuildAuthorised(IDS.guild));
});

// 8. Discord snowflake IDs remain strings.
test("guild IDs are kept as strings", () => {
  process.env.DISCORD_ANALYTICS_GUILD_IDS = IDS.guild;
  const [id] = validateAnalyticsConfig().config.guildIds;
  assert.equal(typeof id, "string");
  assert.equal(id, IDS.guild);
});

test("invalid snowflake IDs are ignored, not coerced", () => {
  process.env.DISCORD_ANALYTICS_GUILD_IDS = "123,not-a-snowflake";
  const { config, errors } = validateAnalyticsConfig();
  assert.deepEqual(config.guildIds, []);
  assert.ok(errors.some((e) => e.includes("invalid snowflake")));
});

// 33. The default analytics database path is ignored by Git.
test("the default database path is git-ignored", () => {
  const ignore = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  for (const rule of ["data/", "*.sqlite", "*.db"]) {
    assert.ok(ignore.includes(rule), `.gitignore must contain ${rule}`);
  }
  // Ask git directly: the default DB file must be ignored.
  const out = execFileSync("git", ["check-ignore", DEFAULT_DB_PATH], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }).trim();
  assert.equal(out, DEFAULT_DB_PATH, "git must report the default DB path as ignored");
});
