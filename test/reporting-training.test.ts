import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrainingCadence } from "../src/analytics/reporting/trainingCadence.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const WEEK = { startDate: "2024-06-03", endDate: "2024-06-09" }; // one MONDAY week
const reporting = makeReporting({
  resourceChannelIds: [R.resource],
  staffUserIds: [R.staff, R.owner],
});

function withResourceChannel(storeContent = true) {
  const f = makeFixture(storeContent);
  f.channel(R.resource, { type: 0 });
  return f;
}

// 52. Attachment-based detection.
test("attachment-based training detection works", () => {
  const f = withResourceChannel();
  f.msg({
    message_id: "a10000000000000001",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: "see attached",
    attachment_count: 1,
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), { guildId: R.guild, ...WEEK });
  assert.equal(res.completedChannelWeeks, 1);
  assert.deepEqual(res.weeks[0].detectionReasons, [["attachment"]]);
});

// 53. Link-based detection.
test("link-based training detection works", () => {
  const f = withResourceChannel();
  f.msg({
    message_id: "a10000000000000010",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: "replay here https://example.com/x",
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), { guildId: R.guild, ...WEEK });
  assert.equal(res.completedChannelWeeks, 1);
  assert.ok(res.weeks[0].detectionReasons?.[0].includes("link"));
});

// 54. Keyword-based detection.
test("keyword-based training detection works", () => {
  const f = withResourceChannel();
  f.msg({
    message_id: "a10000000000000020",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: "weekly workshop notes",
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), { guildId: R.guild, ...WEEK });
  assert.equal(res.completedChannelWeeks, 1);
  assert.ok(res.weeks[0].detectionReasons?.[0].includes("keyword"));
});

// 55. Non-staff posts do not qualify by default.
test("a non-staff post does not qualify", () => {
  const f = withResourceChannel();
  f.msg({
    message_id: "a10000000000000030",
    author_id: R.member,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: "training",
    attachment_count: 1,
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), { guildId: R.guild, ...WEEK });
  assert.equal(res.completedChannelWeeks, 0);
  assert.equal(res.weeks[0].missing, true);
});

// 56. Weekly missing-channel detection.
test("missing channel-weeks are detected across a multi-week range", () => {
  const f = withResourceChannel();
  // Only week 1 has a post; week 2 is missing.
  f.msg({
    message_id: "a10000000000000040",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: "training",
    attachment_count: 1,
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), {
    guildId: R.guild,
    startDate: "2024-06-03",
    endDate: "2024-06-16",
  });
  assert.equal(res.expectedChannelWeeks, 2);
  assert.equal(res.completedChannelWeeks, 1);
  assert.equal(res.missingChannelWeeks, 1);
  assert.equal(res.cadence.percentage, 50);
});

// 57. Content-disabled: attachment detection still works; link/keyword unavailable.
test("content disabled still supports attachment-based detection", () => {
  const f = withResourceChannel(false);
  f.msg({
    message_id: "a10000000000000050",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-04T09:00:00.000Z",
    content: null,
    attachment_count: 1,
  });
  // A keyword-only post cannot be detected without content.
  f.msg({
    message_id: "a10000000000000051",
    author_id: R.staff,
    channel_id: R.resource,
    created_at: "2024-06-05T09:00:00.000Z",
    content: null,
  });
  const res = buildTrainingCadence(ctxOf(f.store, reporting), { guildId: R.guild, ...WEEK });
  assert.equal(res.completedChannelWeeks, 1, "attachment post still qualifies");
  assert.ok(res.limitations.some((l) => l.toLowerCase().includes("content")));
});

// 58. Cadence percentage handles zero expected weeks safely.
test("cadence percentage is null when there are no resource channels", () => {
  const f = withResourceChannel();
  const res = buildTrainingCadence(ctxOf(f.store, makeReporting({ resourceChannelIds: [] })), {
    guildId: R.guild,
    ...WEEK,
  });
  assert.equal(res.expectedChannelWeeks, 0);
  assert.equal(res.cadence.percentage, null);
});
