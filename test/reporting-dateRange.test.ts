import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDateRange,
  resolveWeek,
  mostRecentCompletedWeek,
  localDateStartUtc,
} from "../src/analytics/reporting/dateRange.js";

// 9. Date ranges use the configured time zone.
test("date range boundaries are computed in the configured time zone", () => {
  // In New York (UTC-4 in June), local midnight June 1 = 04:00Z.
  const ny = resolveDateRange("2024-06-01", "2024-06-01", "America/New_York");
  assert.equal(ny.startUtc, "2024-06-01T04:00:00.000Z");
  assert.equal(ny.endUtcExclusive, "2024-06-02T04:00:00.000Z");
  // UTC is exactly midnight.
  const utc = resolveDateRange("2024-06-01", "2024-06-01", "UTC");
  assert.equal(utc.startUtc, "2024-06-01T00:00:00.000Z");
  assert.equal(utc.endUtcExclusive, "2024-06-02T00:00:00.000Z");
});

// 11. Midnight boundaries do not double-count (end is exclusive).
test("range end is exclusive, so midnight is not double-counted", () => {
  const { startUtc, endUtcExclusive } = resolveDateRange("2024-06-01", "2024-06-02", "UTC");
  assert.equal(startUtc, "2024-06-01T00:00:00.000Z");
  // Covers June 1 and June 2 fully; excludes June 3 00:00.
  assert.equal(endUtcExclusive, "2024-06-03T00:00:00.000Z");
});

// 12. Invalid or reversed date ranges are rejected.
test("reversed or malformed ranges throw", () => {
  assert.throws(() => resolveDateRange("2024-06-05", "2024-06-01", "UTC"), /earlier/);
  assert.throws(() => resolveDateRange("2024/06/01", "2024-06-02", "UTC"), /YYYY-MM-DD/);
  assert.throws(() => resolveDateRange("2024-06-01", "nope", "UTC"), /YYYY-MM-DD/);
});

// 10. Weekly ranges use the configured week-start convention.
test("weekly range snaps to the configured week start", () => {
  // 2024-06-05 is a Wednesday. MONDAY week starts 2024-06-03.
  const mon = resolveWeek("2024-06-05", "UTC", "MONDAY");
  assert.equal(mon.localStartDate, "2024-06-03");
  assert.equal(mon.localEndDate, "2024-06-09");
  assert.equal(mon.startUtc, "2024-06-03T00:00:00.000Z");
  assert.equal(mon.endUtcExclusive, "2024-06-10T00:00:00.000Z");
  // SUNDAY week starts 2024-06-02.
  const sun = resolveWeek("2024-06-05", "UTC", "SUNDAY");
  assert.equal(sun.localStartDate, "2024-06-02");
  assert.equal(sun.localEndDate, "2024-06-08");
});

// 13. Most-recent-completed-week logic excludes a partial current week.
test("most recent completed week excludes the partial current week", () => {
  // "Now" = Wednesday 2024-06-12 12:00Z. Current MONDAY week starts 06-10 (partial).
  // The most recently COMPLETED week is 06-03 .. 06-09.
  const wk = mostRecentCompletedWeek(new Date("2024-06-12T12:00:00.000Z"), "UTC", "MONDAY");
  assert.equal(wk.localStartDate, "2024-06-03");
  assert.equal(wk.localEndDate, "2024-06-09");
});

test("localDateStartUtc handles a DST-offset zone", () => {
  // Los Angeles is UTC-7 in July; local midnight = 07:00Z.
  assert.equal(
    localDateStartUtc("2024-07-15", "America/Los_Angeles").toISOString(),
    "2024-07-15T07:00:00.000Z",
  );
});
