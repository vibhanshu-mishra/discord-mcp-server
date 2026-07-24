import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateReportingConfig, isValidTimeZone } from "../src/analytics/reporting/config.js";
import { R } from "./reporting-helpers.js";

const ENV = [
  "DISCORD_ANALYTICS_PRIMARY_USER_ID",
  "DISCORD_ANALYTICS_STAFF_USER_IDS",
  "DISCORD_ANALYTICS_RESOURCE_CHANNEL_IDS",
  "DISCORD_ANALYTICS_OFFICE_HOUR_CHANNEL_IDS",
  "DISCORD_ANALYTICS_RESPONSE_WINDOW_HOURS",
  "DISCORD_ANALYTICS_ACKNOWLEDGEMENT_WINDOW_HOURS",
  "DISCORD_ANALYTICS_TIMEZONE",
  "DISCORD_ANALYTICS_WEEK_START",
  "DISCORD_ANALYTICS_TRAINING_KEYWORDS",
];
afterEach(() => ENV.forEach((k) => delete process.env[k]));

// 1. Primary user ID remains a string.
test("primary user ID is kept as a string", () => {
  process.env.DISCORD_ANALYTICS_PRIMARY_USER_ID = R.owner;
  const { config } = validateReportingConfig();
  assert.equal(typeof config.primaryUserId, "string");
  assert.equal(config.primaryUserId, R.owner);
});

// 2. The primary user is automatically included in the effective staff set.
test("the primary user is automatically part of the effective staff set", () => {
  process.env.DISCORD_ANALYTICS_PRIMARY_USER_ID = R.owner;
  process.env.DISCORD_ANALYTICS_STAFF_USER_IDS = R.staff;
  const { config } = validateReportingConfig();
  assert.ok(config.staffUserIds.includes(R.owner), "primary user in effective staff");
  assert.ok(config.staffUserIds.includes(R.staff));
  assert.ok(
    !config.configuredStaffUserIds.includes(R.owner),
    "configured set excludes the auto-added primary user",
  );
});

// 3/4/5. Invalid IDs are rejected clearly.
test("invalid staff/resource/office IDs are rejected with an error", () => {
  process.env.DISCORD_ANALYTICS_STAFF_USER_IDS = "not-an-id";
  process.env.DISCORD_ANALYTICS_RESOURCE_CHANNEL_IDS = "12,abc";
  process.env.DISCORD_ANALYTICS_OFFICE_HOUR_CHANNEL_IDS = "bad";
  const { config, errors } = validateReportingConfig();
  assert.deepEqual(config.configuredStaffUserIds, []);
  assert.deepEqual(config.resourceChannelIds, []);
  assert.deepEqual(config.officeHourChannelIds, []);
  assert.ok(errors.filter((e) => e.includes("invalid snowflake")).length >= 3);
});

// 6. Response windows require safe positive values.
test("windows reject non-positive values and clamp huge ones", () => {
  process.env.DISCORD_ANALYTICS_RESPONSE_WINDOW_HOURS = "-3";
  process.env.DISCORD_ANALYTICS_ACKNOWLEDGEMENT_WINDOW_HOURS = "999999";
  const { config, errors } = validateReportingConfig();
  assert.equal(config.responseWindowHours, 24, "invalid falls back to default");
  assert.equal(config.acknowledgementWindowHours, 24 * 365, "clamped to safe maximum");
  assert.ok(errors.some((e) => e.includes("RESPONSE_WINDOW")));
});

// 7. Invalid time zones fail safely (fall back to UTC + error).
test("invalid time zone falls back to UTC safely", () => {
  process.env.DISCORD_ANALYTICS_TIMEZONE = "Mars/Phobos";
  const { config, errors } = validateReportingConfig();
  assert.equal(config.timezone, "UTC");
  assert.ok(errors.some((e) => e.includes("IANA")));
  assert.ok(isValidTimeZone("America/New_York"));
  assert.ok(!isValidTimeZone("Nope/Nowhere"));
});

// 8. Week-start validation works.
test("week start validates MONDAY/SUNDAY and defaults safely", () => {
  process.env.DISCORD_ANALYTICS_WEEK_START = "sunday";
  assert.equal(validateReportingConfig().config.weekStart, "SUNDAY");
  process.env.DISCORD_ANALYTICS_WEEK_START = "funday";
  const { config, errors } = validateReportingConfig();
  assert.equal(config.weekStart, "MONDAY");
  assert.ok(errors.some((e) => e.includes("WEEK_START")));
});

test("training keywords parse and default", () => {
  assert.ok(validateReportingConfig().config.trainingKeywords.includes("training"));
  process.env.DISCORD_ANALYTICS_TRAINING_KEYWORDS = "Foo, BAR ,foo";
  assert.deepEqual(validateReportingConfig().config.trainingKeywords, ["foo", "bar"]);
});
