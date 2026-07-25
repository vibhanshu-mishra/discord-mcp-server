import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChannelPacket,
  buildQualitativePacket,
} from "../src/analytics/qualitative/analysisPacket.js";
import { makeQualFixture, makeQualCtx, makeQualConfig, Q } from "./qualitative-helpers.js";

const RANGE = { startDate: "2024-06-08", endDate: "2024-06-14" };
let seq = 0;
const id = () => `75000000000000${String(1000 + seq++)}`;
const at = (day: string, min: number) =>
  `2024-06-${day}T10:${String(min).padStart(2, "0")}:00.000Z`;

function seedRich(f: ReturnType<typeof makeQualFixture>) {
  // Topic-supporting, questions, feedback, high-reply, high-reaction, recent.
  f.msg({
    message_id: "topic1",
    author_id: Q.member1,
    content: "deploy failed on staging",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: "topic2",
    author_id: Q.member2,
    content: "deploy failed again today",
    created_at: at("08", 2),
  });
  f.msg({
    message_id: "q1",
    author_id: Q.member1,
    content: "how do I reset my password?",
    created_at: at("08", 3),
  });
  f.msg({
    message_id: "fb1",
    author_id: Q.member2,
    content: "this is broken and throws an error",
    created_at: at("08", 4),
  });
  f.msg({
    message_id: "popular",
    author_id: Q.member3,
    content: "everyone please read the announcement",
    created_at: at("08", 5),
  });
  f.react("popular", Q.member1);
  f.react("popular", Q.member2);
  f.msg({
    message_id: "replied",
    author_id: Q.member1,
    content: "what does the team think of the plan",
    created_at: at("09", 1),
  });
  f.msg({
    message_id: "r1",
    author_id: Q.member2,
    content: "I like it",
    created_at: at("09", 2),
    referenced_message_id: "replied",
  });
  f.msg({
    message_id: "recent1",
    author_id: Q.member3,
    content: "final message of the week here",
    created_at: at("13", 1),
  });
}

// 54/55. Channel packet has all sections; sampling is balanced and deterministic.
test("channel packet contains all deterministic sections and a balanced sample", () => {
  const f = makeQualFixture();
  seedRich(f);
  const res = buildChannelPacket(makeQualCtx(f), {
    guildId: Q.guild,
    channelId: Q.channel,
    ...RANGE,
  });
  for (const key of [
    "channel",
    "totals",
    "candidateQuestions",
    "topicCandidates",
    "feedbackSignalCounts",
    "mostActiveHours",
    "evidenceSample",
    "limitations",
  ]) {
    assert.ok(key in res, `missing ${key}`);
  }
  assert.ok(res.totals.totalMessages >= 8);
  const reasons = new Set(res.evidenceSample.map((e) => e.reason));
  assert.ok(reasons.size >= 3, "sample spans multiple buckets, not just first/last"); // 55
  // Deterministic: two runs identical.
  const again = buildChannelPacket(makeQualCtx(f), {
    guildId: Q.guild,
    channelId: Q.channel,
    ...RANGE,
  });
  assert.deepEqual(
    res.evidenceSample.map((e) => e.messageId),
    again.evidenceSample.map((e) => e.messageId),
  );
});

// 57. Evidence limits are enforced.
test("channel packet respects the maximum_messages evidence bound", () => {
  const f = makeQualFixture();
  seedRich(f);
  const res = buildChannelPacket(makeQualCtx(f), {
    guildId: Q.guild,
    channelId: Q.channel,
    ...RANGE,
    maximumMessages: 3,
  });
  assert.ok(res.evidenceSample.length <= 3);
});

// 56. Global packet includes topics, recurring questions, signals, Phase 3 metrics.
test("global packet combines lexical analysis and reused Phase 3 metrics", () => {
  const f = makeQualFixture();
  seedRich(f);
  // Add a similar question to form a recurring group.
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "how do I reset my password now",
    created_at: at("08", 6),
  });
  const res = buildQualitativePacket(makeQualCtx(f), { guildId: Q.guild, ...RANGE });
  assert.ok("topicCandidates" in res);
  assert.ok("recurringQuestions" in res);
  assert.ok("feedbackSignals" in res);
  assert.ok("conversationHealth" in res);
  assert.ok("staffResponse" in res.conversationHealth);
  assert.ok("trainingCadence" in res.conversationHealth);
  assert.ok("officeHours" in res.conversationHealth);
});

// 58. Data-quality warnings are complete.
test("global packet reports data-quality warnings", () => {
  const f = makeQualFixture(false); // content storage disabled
  f.msg({ message_id: id(), author_id: Q.member1, content: "x", created_at: at("08", 1) });
  const res = buildQualitativePacket(makeQualCtx(f, { storeContent: false }), {
    guildId: Q.guild,
    ...RANGE,
  });
  const w = res.dataQualityWarnings.join(" | ");
  assert.ok(w.includes("content storage is disabled"));
  assert.ok(w.toLowerCase().includes("lexical"));
});

// 59. No persuasive prose — output is structured data only, no free-text summary field.
test("packets contain no AI-generated prose field", () => {
  const f = makeQualFixture();
  seedRich(f);
  const res = buildQualitativePacket(makeQualCtx(f), { guildId: Q.guild, ...RANGE });
  assert.ok(!("summary" in res) && !("narrative" in res) && !("prose" in res));
  assert.equal(typeof res.methodology.note, "string");
});

// Evidence never leaks content when output disabled (even if requested).
test("global packet evidence is withheld when content output is disabled", () => {
  const f = makeQualFixture();
  seedRich(f);
  const res = buildQualitativePacket(
    makeQualCtx(f, { qcfg: makeQualConfig({ allowContentOutput: false }) }),
    {
      guildId: Q.guild,
      ...RANGE,
      includeEvidence: true,
    },
  );
  assert.equal(res.evidence, undefined, "no evidence packet without content output");
});
