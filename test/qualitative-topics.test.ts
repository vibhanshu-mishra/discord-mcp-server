import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopicCandidates } from "../src/analytics/qualitative/topicCandidates.js";
import {
  makeQualFixture,
  makeQualCtx,
  makeQualConfig,
  makeReportingConfig,
  Q,
} from "./qualitative-helpers.js";

const RANGE = { guildId: Q.guild, startDate: "2024-06-08", endDate: "2024-06-14" };
let seq = 0;
const id = () => `70000000000000${String(1000 + seq++)}`;
const at = (day: string, min: number) =>
  `2024-06-${day}T10:${String(min).padStart(2, "0")}:00.000Z`;

// 13/18/19. Repeated bigram → topic candidate with correct distinct counts.
test("a repeated bigram becomes a topic candidate with distinct counts", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "the deploy failed on staging",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed again for me",
    created_at: at("08", 2),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "another deploy failed today",
    created_at: at("09", 1),
  });
  const res = buildTopicCandidates(makeQualCtx(f), RANGE);
  const topic = res.topics.find((t) => t.label === "deploy failed")!;
  assert.ok(topic, "deploy failed detected"); // 13
  assert.equal(topic.supportingMessageCount, 3); // 18
  assert.equal(topic.distinctMemberCount, 2); // 19
});

// 14. Low-information messages are ignored.
test("low-information messages do not create topics", () => {
  const f = makeQualFixture();
  ["thanks", "ok", "yes", "👍"].forEach((c, i) =>
    f.msg({ message_id: id(), author_id: Q.member1, content: c, created_at: at("08", i + 1) }),
  );
  const res = buildTopicCandidates(makeQualCtx(f), RANGE);
  assert.equal(res.topics.length, 0);
});

// 15/16/17. Bots and staff excluded by default; staff inclusion works.
test("bot and staff messages are excluded by default; include_staff adds staff", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed here",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed there",
    created_at: at("08", 2),
  });
  f.msg({
    message_id: id(),
    author_id: "600000000000000099",
    author_is_bot: true,
    content: "deploy failed bot",
    created_at: at("08", 3),
  });
  f.msg({
    message_id: id(),
    author_id: Q.staff1,
    content: "deploy failed staff",
    created_at: at("08", 4),
  });
  const ctx = makeQualCtx(f);
  const def = buildTopicCandidates(ctx, RANGE).topics.find((t) => t.label === "deploy failed")!;
  assert.equal(def.supportingMessageCount, 2, "bot + staff excluded by default"); // 15/16
  const withStaff = buildTopicCandidates(ctx, { ...RANGE, includeStaff: true }).topics.find(
    (t) => t.label === "deploy failed",
  )!;
  assert.equal(withStaff.supportingMessageCount, 3, "staff included, bot still excluded"); // 17
});

// 20. Distinct-channel counts.
test("distinct-channel counts are correct", () => {
  const f = makeQualFixture();
  f.channel(Q.channel2);
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    channel_id: Q.channel,
    content: "deploy failed one",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    channel_id: Q.channel2,
    content: "deploy failed two",
    created_at: at("08", 2),
  });
  const t = buildTopicCandidates(makeQualCtx(f), RANGE).topics.find(
    (x) => x.label === "deploy failed",
  )!;
  assert.equal(t.distinctChannelCount, 2);
});

// 21. Near-duplicate labels (unigram subsumed by bigram) are deduplicated.
test("unigram subsumed by a bigram is deduplicated", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed once",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed twice",
    created_at: at("08", 2),
  });
  const labels = buildTopicCandidates(makeQualCtx(f), RANGE).topics.map((t) => t.label);
  assert.ok(labels.includes("deploy failed"));
  assert.ok(!labels.includes("deploy"), "the subsumed unigram is dropped");
  assert.ok(!labels.includes("failed"));
});

// 22. Minimum-message threshold.
test("minimum_messages threshold is honoured", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed a",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed b",
    created_at: at("08", 2),
  });
  const res = buildTopicCandidates(makeQualCtx(f), { ...RANGE, minimumMessages: 3 });
  assert.ok(!res.topics.some((t) => t.label === "deploy failed"));
});

// 23. Topic limit.
test("topic_limit caps the number of candidates", () => {
  const f = makeQualFixture();
  const words = ["alpha bravo", "charlie delta", "echo foxtrot", "golf hotel"];
  words.forEach((w, wi) => {
    for (let k = 0; k < 2; k++)
      f.msg({
        message_id: id(),
        author_id: k === 0 ? Q.member1 : Q.member2,
        content: `${w} discussion`,
        created_at: at("08", wi * 2 + k + 1),
      });
  });
  const res = buildTopicCandidates(makeQualCtx(f), { ...RANGE, topicLimit: 2 });
  assert.equal(res.topics.length, 2);
});

// 24/25. Previous-period comparison; zero previous does not produce infinity.
test("previous-period comparison works and zero previous yields null change", () => {
  const f = makeQualFixture();
  // Current week (06-08..): 2 messages.
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed now",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed today",
    created_at: at("09", 1),
  });
  // Previous week (06-01..06-08): 1 message.
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed before",
    created_at: at("02", 1),
  });
  const withPrev = buildTopicCandidates(makeQualCtx(f), RANGE).topics.find(
    (t) => t.label === "deploy failed",
  )!;
  assert.equal(withPrev.currentPeriodCount, 2);
  assert.equal(withPrev.previousPeriodCount, 1);
  assert.equal(withPrev.change!.absoluteChange, 1);
  assert.equal(withPrev.change!.percentageChange, 100);

  // A brand-new topic with zero previous → null percentage change (no infinity).
  const f2 = makeQualFixture();
  f2.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "brand new topic here",
    created_at: at("08", 1),
  });
  f2.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "brand new topic again",
    created_at: at("09", 1),
  });
  const fresh = buildTopicCandidates(makeQualCtx(f2), RANGE).topics.find(
    (t) => t.label === "brand new",
  )!;
  assert.equal(fresh.previousPeriodCount, 0);
  assert.equal(fresh.change!.percentageChange, null);
});

// content-disabled mode reports a limitation and returns no topics.
test("content storage disabled reports a limitation and no topics", () => {
  const f = makeQualFixture(false);
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed",
    created_at: at("08", 1),
  });
  const res = buildTopicCandidates(makeQualCtx(f, { storeContent: false }), RANGE);
  assert.equal(res.topics.length, 0);
  assert.ok(res.limitations.some((l) => l.toLowerCase().includes("content storage is disabled")));
});

// Uses generic config: no reliance on env.
test("respects an explicit reporting/qual config", () => {
  const f = makeQualFixture();
  f.msg({
    message_id: id(),
    author_id: Q.member1,
    content: "deploy failed x",
    created_at: at("08", 1),
  });
  f.msg({
    message_id: id(),
    author_id: Q.member2,
    content: "deploy failed y",
    created_at: at("08", 2),
  });
  const ctx = makeQualCtx(f, {
    qcfg: makeQualConfig({ topicMinMessages: 2 }),
    reporting: makeReportingConfig(),
  });
  assert.ok(buildTopicCandidates(ctx, RANGE).topics.length >= 1);
});
