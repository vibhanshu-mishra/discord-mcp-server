import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecurringQuestions } from "../src/analytics/qualitative/recurringQuestions.js";
import { makeQualFixture, makeQualCtx, makeQualConfig, Q } from "./qualitative-helpers.js";

const RANGE = { guildId: Q.guild, startDate: "2024-06-01", endDate: "2024-06-14" };
let seq = 0;
const id = () => `71000000000000${String(1000 + seq++)}`;
const at = (min: number) => `2024-06-05T10:${String(min).padStart(2, "0")}:00.000Z`;

// 26/29/30. Similar questions group; one message in one group; min size 2.
test("similar questions group together and a message joins only one group", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: "q1",
    author_id: Q.member1,
    content: "how do I reset my password?",
    created_at: at(1),
  });
  f.msg({
    message_id: "q2",
    author_id: Q.member2,
    content: "how do I reset my password please",
    created_at: at(2),
  });
  f.msg({
    message_id: "q3",
    author_id: Q.member3,
    content: "how do I reset the password again",
    created_at: at(3),
  });
  const res = buildRecurringQuestions(makeQualCtx(f), { ...RANGE, similarityThreshold: 0.4 });
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0].questionCount, 3); // 26/30
  const allIds = res.groups.flatMap((g) => g.evidenceMessageIds);
  assert.equal(new Set(allIds).size, allIds.length, "no message appears in two groups"); // 29
});

// 27. Unrelated questions stay separate (become their own too-small groups → dropped).
test("unrelated questions do not group", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "how do I reset my password?",
    created_at: at(1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "where is the billing invoice page?",
    created_at: at(2),
  });
  const res = buildRecurringQuestions(makeQualCtx(f), { ...RANGE, similarityThreshold: 0.5 });
  assert.equal(res.groups.length, 0, "each unique question is alone → no group of >=2");
});

// 28. Similarity threshold is honoured.
test("a higher threshold splits borderline questions", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "how do I reset my password?",
    created_at: at(1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "how do I change my password?",
    created_at: at(2),
  });
  const low = buildRecurringQuestions(makeQualCtx(f), { ...RANGE, similarityThreshold: 0.3 });
  assert.equal(low.groups.length, 1, "loose threshold groups them");
  const high = buildRecurringQuestions(makeQualCtx(f), { ...RANGE, similarityThreshold: 0.9 });
  assert.equal(high.groups.length, 0, "strict threshold keeps them apart");
});

// 31/32. Answered/unanswered counts and response-time metrics.
test("answered and unanswered counts and median response time are correct", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: "qa",
    author_id: Q.member1,
    content: "how do I reset my password today?",
    created_at: at(1),
  });
  f.msg({
    message_id: "qb",
    author_id: Q.member2,
    content: "how do I reset my password now?",
    created_at: at(2),
  });
  // Staff replies to qa 10 minutes later (answered); qb has no reply.
  f.msg({
    message_id: "sa",
    author_id: Q.staff1,
    content: "here is how",
    created_at: at(11),
    referenced_message_id: "qa",
    is_reply: true,
  });
  const res = buildRecurringQuestions(makeQualCtx(f), { ...RANGE, similarityThreshold: 0.4 });
  const g = res.groups[0];
  assert.equal(g.questionCount, 2);
  assert.equal(g.answeredCount, 1); // 31
  assert.equal(g.unansweredCount, 1);
  assert.equal(g.medianStaffResponseSeconds, 600); // 32 (10 min)
});

// 33. Deterministic ordering (repeated runs identical).
test("ordering is deterministic across runs", () => {
  const f = makeQualFixture();
  for (let i = 0; i < 3; i++)
    f.msg({
      message_id: id(),
      author_id: Q.member1,
      content: "how do I reset my password?",
      created_at: at(i + 1),
    });
  for (let i = 0; i < 2; i++)
    f.msg({
      message_id: id(),
      author_id: Q.member2,
      content: "where is the billing page located?",
      created_at: at(i + 10),
    });
  const a = buildRecurringQuestions(makeQualCtx(f), {
    ...RANGE,
    similarityThreshold: 0.4,
  }).groups.map((g) => g.groupId + g.label);
  const b = buildRecurringQuestions(makeQualCtx(f), {
    ...RANGE,
    similarityThreshold: 0.4,
  }).groups.map((g) => g.groupId + g.label);
  assert.deepEqual(a, b);
});

// 34. Content-disabled mode reports a limitation.
test("content storage disabled reports a limitation and no groups", () => {
  const f = makeQualFixture(false);
  f.msg({ message_id: id(), author_id: Q.member1, content: "how do I reset?", created_at: at(1) });
  const res = buildRecurringQuestions(makeQualCtx(f, { storeContent: false }), RANGE);
  assert.equal(res.groups.length, 0);
  assert.ok(res.limitations.some((l) => l.toLowerCase().includes("content storage is disabled")));
});

// Evidence excerpts only when content output enabled.
test("evidence excerpts appear only when content output is enabled", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "how do I reset my password?",
    created_at: at(1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "how do I reset my password now",
    created_at: at(2),
  });
  const off = buildRecurringQuestions(
    makeQualCtx(f, { qcfg: makeQualConfig({ allowContentOutput: false }) }),
    { ...RANGE, similarityThreshold: 0.4, includeEvidence: true },
  );
  assert.equal(off.groups[0].evidence![0].excerpt, null);
  const on = buildRecurringQuestions(
    makeQualCtx(f, { qcfg: makeQualConfig({ allowContentOutput: true }) }),
    { ...RANGE, similarityThreshold: 0.4, includeEvidence: true },
  );
  assert.ok(
    on.groups[0].evidence![0].excerpt && on.groups[0].evidence![0].excerpt.includes("reset"),
  );
});
