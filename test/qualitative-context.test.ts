import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConversationContext } from "../src/analytics/qualitative/conversationContext.js";
import { makeQualFixture, makeQualCtx, makeQualConfig, Q } from "./qualitative-helpers.js";

let seq = 0;
const id = () => `73000000000000${String(1000 + seq++)}`;
const at = (min: number) => `2024-06-05T10:${String(min).padStart(2, "0")}:00.000Z`;

/** Seeds a channel with N messages around a target and returns the target id. */
function seedChannel(f: ReturnType<typeof makeQualFixture>) {
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const mid = id();
    ids.push(mid);
    f.msg({
      message_id: mid,
      author_id: i % 2 === 0 ? Q.member1 : Q.member2,
      content: `message number ${i}`,
      created_at: at(i + 1),
    });
  }
  return ids;
}

// 46/50. Before/after are bounded and returned chronologically.
test("messages before and after are bounded and chronological", () => {
  const f = makeQualFixture();
  const ids = seedChannel(f);
  const target = ids[10];
  const res = buildConversationContext(makeQualCtx(f), {
    guildId: Q.guild,
    messageId: target,
    messagesBefore: 3,
    messagesAfter: 4,
  }) as { found: true; context: { messageId: string; createdAt: string }[] };
  assert.equal(res.found, true);
  assert.equal(res.context.length, 7);
  const times = res.context.map((c) => c.createdAt);
  assert.deepEqual(times, [...times].sort(), "chronological order"); // 50
  assert.ok(!res.context.some((c) => c.messageId === target), "target excluded from context");
});

// 47/49. Direct replies included; duplicates removed.
test("direct replies are included and de-duplicated with the window", () => {
  const f = makeQualFixture();
  const ids = seedChannel(f);
  const target = ids[10];
  // A reply that is also adjacent (would appear in both sources).
  f.msg({
    message_id: "reply1",
    author_id: Q.member2,
    content: "replying to target",
    created_at: at(21),
    referenced_message_id: target,
  });
  const res = buildConversationContext(makeQualCtx(f), {
    guildId: Q.guild,
    messageId: target,
    messagesAfter: 15,
  }) as {
    context: { messageId: string }[];
  };
  const replyAppearances = res.context.filter((c) => c.messageId === "reply1").length;
  assert.equal(replyAppearances, 1, "reply present exactly once"); // 47/49
});

// 48. Thread context included when requested.
test("thread messages are included when requested", () => {
  const f = makeQualFixture();
  const ids = seedChannel(f);
  const target = ids[5];
  // A thread started from the target (its channel_id == target message id).
  f.channel(target, { isThread: true, parentId: Q.channel });
  f.msg({
    message_id: "t1",
    author_id: Q.member2,
    channel_id: target,
    content: "thread reply one",
    created_at: at(30),
  });
  const res = buildConversationContext(makeQualCtx(f), {
    guildId: Q.guild,
    messageId: target,
    includeThread: true,
  }) as {
    context: { messageId: string }[];
  };
  assert.ok(
    res.context.some((c) => c.messageId === "t1"),
    "thread message present",
  );
});

// 51. Incomplete local history is identified.
test("incomplete local history before the target is flagged", () => {
  const f = makeQualFixture();
  // An earlier message exists in a DIFFERENT channel, but none before the target in THIS channel.
  f.channel(Q.channel2);
  f.msg({
    message_id: "early",
    author_id: Q.member1,
    channel_id: Q.channel2,
    content: "much earlier elsewhere",
    created_at: at(1),
  });
  f.msg({
    message_id: "target",
    author_id: Q.member1,
    channel_id: Q.channel,
    content: "the target message",
    created_at: at(30),
  });
  const res = buildConversationContext(makeQualCtx(f), {
    guildId: Q.guild,
    messageId: "target",
    messagesBefore: 5,
  }) as {
    limitations: string[];
  };
  assert.ok(res.limitations.some((l) => l.toLowerCase().includes("incomplete")));
});

// 52. Excerpts disabled by default.
test("excerpts are disabled by default and content-gate respected", () => {
  const f = makeQualFixture();
  const ids = seedChannel(f);
  const ctx = makeQualCtx(f, { qcfg: makeQualConfig({ allowContentOutput: true }) });
  const res = buildConversationContext(ctx, { guildId: Q.guild, messageId: ids[10] }) as {
    target: { excerpt: string | null };
    context: { excerpt: string | null }[];
  };
  assert.equal(res.target.excerpt, null, "excerpt off by default");
  assert.ok(res.context.every((c) => c.excerpt === null));
});

// Missing target message → clear limitation (never a Discord fetch).
test("a missing target reports incomplete local history without fetching Discord", () => {
  const f = makeQualFixture();
  const res = buildConversationContext(makeQualCtx(f), {
    guildId: Q.guild,
    messageId: "740000000000000000",
  }) as {
    found: boolean;
    limitations: string[];
  };
  assert.equal(res.found, false);
  assert.ok(res.limitations.some((l) => l.includes("never fetches from Discord")));
});
