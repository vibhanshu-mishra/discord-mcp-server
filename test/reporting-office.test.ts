import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOfficeHourMetrics } from "../src/analytics/reporting/officeHours.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const RANGE = { startDate: "2024-06-03", endDate: "2024-06-09" };
const reporting = makeReporting({
  officeHourChannelIds: [R.voice],
  staffUserIds: [R.staff, R.owner],
});

// 59/60/61/62/63/64. Filtering, staff exclusion, unique/repeat, durations, incomplete.
test("office-hour attendance metrics are correct", () => {
  const DAVE = "500000000000000099";
  const f = makeFixture();
  // Alice: two sessions (repeat), 30m + 10m.
  f.voice({
    userId: R.member,
    channelId: R.voice,
    joinedAt: "2024-06-04T10:00:00.000Z",
    leftAt: "2024-06-04T10:30:00.000Z",
  });
  f.voice({
    userId: R.member,
    channelId: R.voice,
    joinedAt: "2024-06-05T10:00:00.000Z",
    leftAt: "2024-06-05T10:10:00.000Z",
  });
  // Bob: one complete session, 20m.
  f.voice({
    userId: R.member2,
    channelId: R.voice,
    joinedAt: "2024-06-04T11:00:00.000Z",
    leftAt: "2024-06-04T11:20:00.000Z",
  });
  // Carol: one incomplete session (unknown leave).
  f.voice({
    userId: R.member3,
    channelId: R.voice,
    joinedAt: "2024-06-06T11:00:00.000Z",
    incomplete: true,
  });
  // Dave: a session in a DIFFERENT (non-office) channel — excluded by channel filter.
  f.voice({
    userId: DAVE,
    channelId: R.voice2,
    joinedAt: "2024-06-04T12:00:00.000Z",
    leftAt: "2024-06-04T12:30:00.000Z",
  });
  // A staff session — excluded when exclude_staff (default).
  f.voice({
    userId: R.staff,
    channelId: R.voice,
    joinedAt: "2024-06-04T13:00:00.000Z",
    leftAt: "2024-06-04T13:30:00.000Z",
  });

  const res = buildOfficeHourMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(
    res.uniqueAttendees,
    3,
    "Alice, Bob, Carol in the office channel; Dave (other channel) and staff excluded",
  ); // 59/60/61
  assert.equal(res.repeatAttendees, 1, "only Alice attended more than once"); // 62
  assert.equal(res.totalSessions, 4, "Alice 2 + Bob 1 + Carol 1 (incomplete)");
  assert.equal(res.incompleteSessionCount, 1); // 64
  // Durations counted: 1800, 600, 1200 (incomplete excluded). Median = 1200. Total = 3600s = 60min.
  assert.equal(res.medianSessionSeconds, 1200); // 63
  assert.equal(res.totalAttendanceMinutes, 60);
  assert.equal(res.longestSessionSeconds, 1800);
});

// 60. exclude_staff=false includes staff.
test("exclude_staff=false includes staff attendees", () => {
  const f = makeFixture();
  f.voice({
    userId: R.staff,
    channelId: R.voice,
    joinedAt: "2024-06-04T13:00:00.000Z",
    leftAt: "2024-06-04T13:30:00.000Z",
  });
  const res = buildOfficeHourMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    ...RANGE,
    excludeStaff: false,
  });
  assert.equal(res.uniqueAttendees, 1);
});

// 65. First-time-attendee status reflects stored-history availability.
test("first-time status reports history availability", () => {
  const f = makeFixture();
  // No history before the range → confidence flags that first-time may be overstated.
  f.voice({
    userId: R.member,
    channelId: R.voice,
    joinedAt: "2024-06-04T10:00:00.000Z",
    leftAt: "2024-06-04T10:30:00.000Z",
  });
  const noHistory = buildOfficeHourMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    ...RANGE,
  });
  assert.equal(noHistory.firstTimeAttendees, 1);
  assert.equal(noHistory.firstTimeConfidence.historyAvailableBeforeRange, false);

  // Add an earlier session (before the range) for the same member → now a repeat, history available.
  f.voice({
    userId: R.member,
    channelId: R.voice,
    joinedAt: "2024-05-20T10:00:00.000Z",
    leftAt: "2024-05-20T10:30:00.000Z",
  });
  const withHistory = buildOfficeHourMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    ...RANGE,
  });
  assert.equal(withHistory.firstTimeConfidence.historyAvailableBeforeRange, true);
  assert.equal(withHistory.firstTimeAttendees, 0, "member has prior history → not first-time");
});
