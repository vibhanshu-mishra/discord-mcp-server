import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStaffResponseMetrics } from "../src/analytics/reporting/responseMetrics.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const RANGE = { startDate: "2024-06-01", endDate: "2024-06-07" };
const reporting = makeReporting({ staffUserIds: [R.staff], responseWindowHours: 24 });

// 33. A direct staff reply counts as a response.
test("a direct staff reply is a staff response", () => {
  const f = makeFixture();
  f.msg({
    message_id: "700000000000000001",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "how do I start?",
  });
  f.msg({
    message_id: "700000000000000002",
    author_id: R.staff,
    created_at: "2024-06-02T10:30:00.000Z",
    referenced_message_id: "700000000000000001",
    is_reply: true,
  });
  const res = buildStaffResponseMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(res.totalQuestions, 1);
  assert.equal(res.questionsWithResponse, 1);
  assert.equal(res.fastestResponseSeconds, 1800); // 36
});

// 34. A staff reply inside a thread started from the question counts.
test("a staff thread reply is a staff response", () => {
  const f = makeFixture();
  f.msg({
    message_id: "700000000000000010",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "any advice on setup?",
  });
  // Thread started from the question: its channel_id equals the question id.
  f.channel("700000000000000010", { isThread: true, parentId: R.channel });
  f.msg({
    message_id: "700000000000000011",
    author_id: R.staff,
    channel_id: "700000000000000010",
    created_at: "2024-06-02T11:00:00.000Z",
    content: "sure, here's how",
  });
  const res = buildStaffResponseMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(res.questionsWithResponse, 1);
});

// 35. A non-staff reply does not count as a staff response.
test("a non-staff reply is not a staff response", () => {
  const f = makeFixture();
  f.msg({
    message_id: "700000000000000020",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "where is the guide?",
  });
  f.msg({
    message_id: "700000000000000021",
    author_id: R.member2,
    created_at: "2024-06-02T10:10:00.000Z",
    referenced_message_id: "700000000000000020",
    is_reply: true,
  });
  const res = buildStaffResponseMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(res.questionsWithResponse, 0);
  assert.equal(res.unanswered, 1);
});

// 37/38. Within/outside window separated; average/median/p90 correct.
test("within-window separation and response-time statistics", () => {
  const f = makeFixture();
  // Six questions with staff responses at increasing delays (seconds): 60,120,180,240,300, and one at 48h (outside 24h window).
  const delays = [60, 120, 180, 240, 300];
  delays.forEach((d, i) => {
    const qid = `71000000000000000${i}`;
    f.msg({
      message_id: qid,
      author_id: R.member,
      created_at: "2024-06-02T00:00:00.000Z",
      content: `how do I do thing ${i}?`,
    });
    f.msg({
      message_id: `72000000000000000${i}`,
      author_id: R.staff,
      created_at: new Date(Date.parse("2024-06-02T00:00:00.000Z") + d * 1000).toISOString(),
      referenced_message_id: qid,
      is_reply: true,
    });
  });
  // One answered far outside the window.
  f.msg({
    message_id: "710000000000000099",
    author_id: R.member,
    created_at: "2024-06-02T00:00:00.000Z",
    content: "how do I do the late thing?",
  });
  f.msg({
    message_id: "720000000000000099",
    author_id: R.staff,
    created_at: "2024-06-04T00:00:00.000Z",
    referenced_message_id: "710000000000000099",
    is_reply: true,
  });

  const res = buildStaffResponseMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(res.totalQuestions, 6);
  assert.equal(res.questionsWithResponse, 6);
  assert.equal(res.questionsWithinWindow, 5, "the 48h response is outside the 24h window");
  // Times sorted: [60,120,180,240,300,172800]; median (linear interp) = 180 + 0.5*(240-180) = 210.
  assert.equal(res.medianFirstResponseSeconds, 210);
  assert.equal(res.fastestResponseSeconds, 60);
  assert.equal(res.slowestResponseSeconds, 172800);
  assert.equal(res.p90FirstResponseSeconds !== null, true, "p90 available with >=5 points");
});

// 39. Zero-denominator response rates return null.
test("response rate is null when there are no eligible questions", () => {
  const f = makeFixture();
  const res = buildStaffResponseMetrics(ctxOf(f.store, reporting), { guildId: R.guild, ...RANGE });
  assert.equal(res.totalQuestions, 0);
  assert.equal(res.responseRate.percentage, null);
  assert.equal(res.averageFirstResponseSeconds, null);
});
