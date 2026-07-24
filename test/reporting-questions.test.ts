import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeQuestion, QUESTION_PHRASES } from "../src/analytics/reporting/questions.js";
import { buildStaffResponseMetrics } from "../src/analytics/reporting/responseMetrics.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const RANGE = { startDate: "2024-06-01", endDate: "2024-06-07" };

// 27. Question-mark detection.
test("question-mark detection works", () => {
  assert.ok(looksLikeQuestion("Is this on?"));
  assert.ok(looksLikeQuestion("really??"));
});

// 28. Common question phrases work.
test("common question phrases are detected without a question mark", () => {
  assert.ok(looksLikeQuestion("how do I do this"));
  assert.ok(looksLikeQuestion("Can someone take a look"));
  assert.ok(QUESTION_PHRASES.length > 5);
});

// 29. Ordinary statements are not classified as questions.
test("ordinary statements are not questions", () => {
  assert.ok(!looksLikeQuestion("thanks everyone, that worked great"));
  assert.ok(!looksLikeQuestion("Deploying the new build now."));
});

// 30/31. Staff/bot messages excluded; deleted excluded — checked via the SQL path.
test("member-question detection excludes staff, bots, and deleted messages", () => {
  const f = makeFixture();
  // Member question (counts).
  f.msg({
    message_id: "610000000000000001",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "how do I join?",
  });
  // Staff question (excluded — staff are not "members").
  f.msg({
    message_id: "610000000000000002",
    author_id: R.staff,
    created_at: "2024-06-02T10:05:00.000Z",
    content: "anyone need help?",
  });
  // Bot question (excluded).
  f.msg({
    message_id: "610000000000000003",
    author_id: R.bot,
    author_is_bot: true,
    created_at: "2024-06-02T10:06:00.000Z",
    content: "shall I restart?",
  });
  // Deleted member question (excluded).
  f.msg({
    message_id: "610000000000000004",
    author_id: R.member2,
    created_at: "2024-06-02T10:07:00.000Z",
    content: "where is the doc?",
    is_deleted: undefined,
  });
  f.repo.markMessageDeleted("610000000000000004");
  const ctx = ctxOf(f.store, makeReporting());
  const res = buildStaffResponseMetrics(ctx, { guildId: R.guild, ...RANGE });
  assert.equal(res.totalQuestions, 1, "only the non-deleted member question counts");
});

// 32. Content-disabled mode reports the limitation and does not fabricate questions.
test("content storage disabled: questions are not fabricated and a limitation is reported", () => {
  const f = makeFixture(false); // storeContent = false
  f.msg({
    message_id: "610000000000000010",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "how do I join?",
  });
  const ctx = ctxOf(f.store, makeReporting());
  const res = buildStaffResponseMetrics(ctx, { guildId: R.guild, ...RANGE });
  assert.equal(res.totalQuestions, 0, "no questions detected without content");
  assert.ok(res.limitations.some((l) => l.toLowerCase().includes("content")));
});
