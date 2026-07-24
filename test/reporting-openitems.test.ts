import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUnansweredQuestions,
  buildUnacknowledgedMessages,
} from "../src/analytics/reporting/openItems.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const NOW = "2024-06-10T00:00:00.000Z";
const reporting = makeReporting({
  staffUserIds: [R.staff],
  responseWindowHours: 24,
  acknowledgementWindowHours: 24,
});

// ─── Unanswered questions ────────────────────────────────────────────────────

// 40. New questions inside the response window are not prematurely overdue.
test("a question younger than the response window is not overdue", () => {
  const f = makeFixture();
  // Question 2 hours before "now" — younger than the 24h window.
  f.msg({
    message_id: "900000000000000001",
    author_id: R.member,
    created_at: "2024-06-09T22:00:00.000Z",
    content: "how do I X?",
  });
  const res = buildUnansweredQuestions(ctxOf(f.store, reporting, NOW), { guildId: R.guild });
  assert.equal(res.count, 0);
});

// 41/43. Old unanswered questions are returned, oldest first.
test("old unanswered questions are returned oldest-first", () => {
  const f = makeFixture();
  f.msg({
    message_id: "900000000000000002",
    author_id: R.member,
    created_at: "2024-06-05T10:00:00.000Z",
    content: "how do I A?",
  });
  f.msg({
    message_id: "900000000000000003",
    author_id: R.member,
    created_at: "2024-06-03T10:00:00.000Z",
    content: "how do I B?",
  });
  const res = buildUnansweredQuestions(ctxOf(f.store, reporting, NOW), { guildId: R.guild });
  assert.equal(res.count, 2);
  assert.equal(res.questions[0].messageId, "900000000000000003", "oldest first"); // 43
});

// 42. Answered questions are excluded.
test("answered questions are excluded from unanswered", () => {
  const f = makeFixture();
  f.msg({
    message_id: "900000000000000010",
    author_id: R.member,
    created_at: "2024-06-03T10:00:00.000Z",
    content: "how do I A?",
  });
  f.msg({
    message_id: "900000000000000011",
    author_id: R.staff,
    created_at: "2024-06-03T10:30:00.000Z",
    referenced_message_id: "900000000000000010",
    is_reply: true,
  });
  const res = buildUnansweredQuestions(ctxOf(f.store, reporting, NOW), { guildId: R.guild });
  assert.equal(res.count, 0);
});

// 44/45. Excerpts opt-in and capped at 240 chars.
test("excerpts are opt-in and capped at 240 characters", () => {
  const f = makeFixture();
  const long = "how do I " + "x".repeat(500) + "?";
  f.msg({
    message_id: "900000000000000020",
    author_id: R.member,
    created_at: "2024-06-03T10:00:00.000Z",
    content: long,
  });
  const off = buildUnansweredQuestions(ctxOf(f.store, reporting, NOW), { guildId: R.guild });
  assert.equal(off.questions[0].excerpt, null, "excerpt disabled by default"); // 44
  const on = buildUnansweredQuestions(ctxOf(f.store, reporting, NOW), {
    guildId: R.guild,
    includeExcerpt: true,
  });
  assert.equal(on.questions[0].excerpt!.length, 240); // 45
});

// ─── Unacknowledged messages ─────────────────────────────────────────────────

// 46/47/48/49. Acknowledgement signals.
test("staff reply, reaction, and thread response acknowledge; non-staff reaction does not", () => {
  const base = (mid: string) => ({
    message_id: mid,
    author_id: R.member,
    created_at: "2024-06-03T10:00:00.000Z",
    content: "please look at this",
  });
  // (a) staff direct reply → acknowledged
  const a = makeFixture();
  a.msg(base("910000000000000001"));
  a.msg({
    message_id: "910000000000000002",
    author_id: R.staff,
    created_at: "2024-06-03T10:10:00.000Z",
    referenced_message_id: "910000000000000001",
    is_reply: true,
  });
  assert.equal(
    buildUnacknowledgedMessages(ctxOf(a.store, reporting, NOW), { guildId: R.guild }).count,
    0,
  ); // 46

  // (b) staff reaction within the window → acknowledged
  const b = makeFixture();
  b.msg(base("910000000000000010"));
  b.react("910000000000000010", R.staff, { observedAt: "2024-06-03T10:15:00.000Z" });
  assert.equal(
    buildUnacknowledgedMessages(ctxOf(b.store, reporting, NOW), { guildId: R.guild }).count,
    0,
  ); // 47

  // (c) staff thread response → acknowledged
  const c = makeFixture();
  c.msg(base("910000000000000020"));
  c.channel("910000000000000020", { isThread: true, parentId: R.channel });
  c.msg({
    message_id: "910000000000000021",
    author_id: R.staff,
    channel_id: "910000000000000020",
    created_at: "2024-06-03T10:30:00.000Z",
    content: "looking",
  });
  assert.equal(
    buildUnacknowledgedMessages(ctxOf(c.store, reporting, NOW), { guildId: R.guild }).count,
    0,
  ); // 48

  // (d) only a non-staff reaction → still unacknowledged
  const d = makeFixture();
  d.msg(base("910000000000000030"));
  d.react("910000000000000030", R.member2);
  assert.equal(
    buildUnacknowledgedMessages(ctxOf(d.store, reporting, NOW), { guildId: R.guild }).count,
    1,
  ); // 49
});

// 50/51. Filters and deleted-message exclusion.
test("message filters (questions/attachments/all) and deleted exclusion work", () => {
  const f = makeFixture();
  f.msg({
    message_id: "920000000000000001",
    author_id: R.member,
    created_at: "2024-06-03T10:00:00.000Z",
    content: "how do I A?",
  }); // question
  f.msg({
    message_id: "920000000000000002",
    author_id: R.member,
    created_at: "2024-06-03T10:01:00.000Z",
    content: "here is a file",
    attachment_count: 2,
  }); // attachment
  f.msg({
    message_id: "920000000000000003",
    author_id: R.member,
    created_at: "2024-06-03T10:02:00.000Z",
    content: "just chatting",
  }); // neither
  f.msg({
    message_id: "920000000000000004",
    author_id: R.member,
    created_at: "2024-06-03T10:03:00.000Z",
    content: "how do I deleted?",
  });
  f.repo.markMessageDeleted("920000000000000004"); // deleted → excluded

  const ctx = ctxOf(f.store, reporting, NOW);
  assert.equal(
    buildUnacknowledgedMessages(ctx, { guildId: R.guild, messageFilter: "all" }).count,
    3,
  ); // 51 (deleted excluded)
  assert.equal(
    buildUnacknowledgedMessages(ctx, { guildId: R.guild, messageFilter: "questions" }).count,
    1,
  ); // 50
  assert.equal(
    buildUnacknowledgedMessages(ctx, { guildId: R.guild, messageFilter: "attachments" }).count,
    1,
  ); // 50
});
