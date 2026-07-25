import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeedbackSignals, classify } from "../src/analytics/qualitative/feedbackSignals.js";
import { makeQualFixture, makeQualCtx, Q } from "./qualitative-helpers.js";

const RANGE = { guildId: Q.guild, startDate: "2024-06-08", endDate: "2024-06-14" };
let seq = 0;
const id = () => `72000000000000${String(1000 + seq++)}`;
const at = (day: string, min: number) =>
  `2024-06-${day}T10:${String(min).padStart(2, "0")}:00.000Z`;

// 35-41. Each category detected.
test("each feedback category is detected by its phrases", () => {
  assert.deepEqual(
    classify("can we add a dark mode").map((c) => c.category),
    ["request"],
  ); // 35
  assert.ok(classify("this is broken and throws an error").some((c) => c.category === "problem")); // 36
  assert.ok(classify("I am blocked and cannot continue").some((c) => c.category === "blocker")); // 37
  assert.ok(
    classify("I am confused and not sure what to do").some((c) => c.category === "confusion"),
  ); // 38
  assert.ok(classify("that worked, thank you").some((c) => c.category === "positive_outcome")); // 39
  assert.ok(classify("I suggest we recommend a new idea").some((c) => c.category === "suggestion")); // 40
  assert.ok(classify("please help, I need help").some((c) => c.category === "help_request")); // 41
});

// 42/43. Multiple signals + matched reasons.
test("a message can match multiple categories and returns matched reasons", () => {
  const res = classify("this is broken, can we please add a fix?");
  const cats = res.map((c) => c.category);
  assert.ok(cats.includes("problem"));
  assert.ok(cats.includes("request"));
  assert.ok(res.find((c) => c.category === "problem")!.matched.includes("broken")); // 43
});

// 44. Deleted and bot messages are excluded.
test("deleted and bot messages are excluded from signal counts", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: "keep",
    author_id: Q.member1,
    content: "this is broken",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: "botmsg",
    author_id: "600000000000000099",
    author_is_bot: true,
    content: "this is broken",
    created_at: at("08", 2),
  });
  f.msg({
    message_id: "del",
    author_id: Q.member2,
    content: "this is broken too",
    created_at: at("08", 3),
  });
  f.repo.markMessageDeleted("del");
  const res = buildFeedbackSignals(makeQualCtx(f), RANGE);
  const problem = res.categories.find((c) => c.category === "problem")!;
  assert.equal(problem.count, 1, "only the live member message counts");
});

// 45. Previous-period trends.
test("previous-period trend is computed", () => {
  const f = makeQualFixture();
  // Current week: 2 problems.
  f.msg({ message_id: id(), author_id: Q.member1, content: "broken now", created_at: at("08", 1) });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "error today",
    created_at: at("09", 1),
  });
  // Previous week (06-01..06-08): 1 problem.
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "broken before",
    created_at: at("02", 1),
  });
  const res = buildFeedbackSignals(makeQualCtx(f), RANGE);
  const problem = res.categories.find((c) => c.category === "problem")!;
  assert.equal(problem.count, 2);
  assert.equal(problem.changeVsPreviousPeriod.previous, 1);
  assert.equal(problem.changeVsPreviousPeriod.absoluteChange, 1);
});

// Distinct member/channel counts and staff filtering.
test("distinct counts are correct and staff excluded by default", () => {
  const f = makeQualFixture();
  f.channel(Q.channel2);
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    channel_id: Q.channel,
    content: "this is broken",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    channel_id: Q.channel2,
    content: "another error",
    created_at: at("08", 2),
  });
  f.msg({
    message_id: id(),
    author_id: Q.staff1,
    content: "staff error report",
    created_at: at("08", 3),
  });
  const def = buildFeedbackSignals(makeQualCtx(f), RANGE).categories.find(
    (c) => c.category === "problem",
  )!;
  assert.equal(def.count, 2, "staff excluded by default");
  assert.equal(def.distinctMemberCount, 2);
  assert.equal(def.distinctChannelCount, 2);
  const withStaff = buildFeedbackSignals(makeQualCtx(f), {
    ...RANGE,
    includeStaff: true,
  }).categories.find((c) => c.category === "problem")!;
  assert.equal(withStaff.count, 3);
});
