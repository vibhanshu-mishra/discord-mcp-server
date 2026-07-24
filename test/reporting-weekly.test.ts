import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWeeklyMetrics } from "../src/analytics/reporting/weeklyMetrics.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const reporting = makeReporting({
  staffUserIds: [R.staff, R.owner],
  resourceChannelIds: [R.resource],
  officeHourChannelIds: [R.voice],
});

// 66. Weekly metrics combine all expected sections.
test("weekly report contains every expected section", () => {
  const f = makeFixture();
  f.msg({
    message_id: "c10000000000000001",
    author_id: R.member,
    created_at: "2024-06-11T10:00:00.000Z",
    content: "how do I A?",
  });
  const res = buildWeeklyMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    weekStartDate: "2024-06-10",
  });
  for (const key of [
    "reportingPeriod",
    "communityActivity",
    "primaryUserActivity",
    "responseHealth",
    "acknowledgementHealth",
    "trainingCadence",
    "officeHours",
    "dataQualityWarnings",
  ]) {
    assert.ok(key in res, `missing section ${key}`);
  }
  // Primary user is configured in the test reporting config, so the section is present.
  assert.equal(res.primaryUserActivity.configured, true);
  assert.equal(res.reportingPeriod.currentWeekLocalDates.start, "2024-06-10");
  assert.equal(res.reportingPeriod.currentWeekUtcBoundaries.startUtc, "2024-06-10T00:00:00.000Z");
});

// 67. Previous-week comparisons are correct.
test("previous-week comparison computes absolute and percentage change", () => {
  const f = makeFixture();
  // Current week (06-10..): 3 member messages.
  for (let i = 0; i < 3; i++)
    f.msg({
      message_id: `c2000000000000000${i}`,
      author_id: R.member,
      created_at: "2024-06-11T10:00:00.000Z",
      content: `msg ${i}`,
    });
  // Previous week (06-03..): 2 member messages.
  for (let i = 0; i < 2; i++)
    f.msg({
      message_id: `c3000000000000000${i}`,
      author_id: R.member,
      created_at: "2024-06-04T10:00:00.000Z",
      content: `old ${i}`,
    });
  const res = buildWeeklyMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    weekStartDate: "2024-06-10",
  });
  const change = res.communityActivity.changeVsPreviousWeek.memberMessages!;
  assert.equal(change.current, 3);
  assert.equal(change.previous, 2);
  assert.equal(change.absoluteChange, 1);
  assert.equal(change.percentageChange, 50);
});

// 68. A zero previous value does not create infinite percentage change.
test("zero previous value yields null percentage change, not Infinity", () => {
  const f = makeFixture();
  f.msg({
    message_id: "c40000000000000001",
    author_id: R.member,
    created_at: "2024-06-11T10:00:00.000Z",
    content: "hi",
  });
  const res = buildWeeklyMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    weekStartDate: "2024-06-10",
  });
  const change = res.communityActivity.changeVsPreviousWeek.memberMessages!;
  assert.equal(change.previous, 0);
  assert.equal(change.percentageChange, null);
  assert.ok(change.reason && change.reason.includes("zero"));
});

// 69/70. Missing configuration and partial-history produce warnings, not fabricated data.
test("missing configuration and limited history produce warnings", () => {
  const f = makeFixture(false); // content storage disabled too
  const res = buildWeeklyMetrics(
    ctxOf(
      f.store,
      makeReporting({
        primaryUserId: null,
        configuredStaffUserIds: [],
        staffUserIds: [],
        resourceChannelIds: [],
        officeHourChannelIds: [],
      }),
    ),
    { guildId: R.guild, weekStartDate: "2024-06-10", collectionActive: false },
  );
  // With no primary user configured, the section is clearly omitted (not fabricated).
  assert.equal(res.primaryUserActivity.configured, false);
  const w = res.dataQualityWarnings.join(" | ");
  assert.ok(w.includes("content"), "content-disabled warning");
  assert.ok(w.includes("Primary user"), "primary-user-missing warning");
  assert.ok(w.includes("staff"), "staff-missing warning");
  assert.ok(w.includes("resource"), "resource-channels warning");
  assert.ok(w.includes("office"), "office-channels warning");
  assert.ok(w.toLowerCase().includes("collection is not active"), "collection-not-active warning");
});

// 71. Weekly report never returns full message content.
test("weekly report contains no message content", () => {
  const f = makeFixture();
  const secret = "SUPER-SECRET-WEEKLY-BODY";
  f.msg({
    message_id: "c50000000000000001",
    author_id: R.member,
    created_at: "2024-06-11T10:00:00.000Z",
    content: secret,
  });
  const res = buildWeeklyMetrics(ctxOf(f.store, reporting), {
    guildId: R.guild,
    weekStartDate: "2024-06-10",
  });
  assert.ok(!JSON.stringify(res).includes(secret), "no message content in the weekly report");
});
