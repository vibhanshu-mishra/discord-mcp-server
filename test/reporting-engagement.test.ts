import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMemberEngagement } from "../src/analytics/reporting/memberEngagement.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const RANGE = { startDate: "2024-06-01", endDate: "2024-06-07" };

function seedBasic() {
  const f = makeFixture();
  f.member(R.member, { username: "alice" });
  f.member(R.member2, { username: "bob" });
  f.member(R.bot, { isBot: true });
  // Alice: 2 messages across 2 days, 2 channels.
  f.channel(R.channel2);
  f.msg({
    message_id: "600000000000000001",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
  });
  f.msg({
    message_id: "600000000000000002",
    author_id: R.member,
    channel_id: R.channel2,
    created_at: "2024-06-03T10:00:00.000Z",
  });
  // Bob replies to Alice's first message.
  f.msg({
    message_id: "600000000000000003",
    author_id: R.member2,
    created_at: "2024-06-03T11:00:00.000Z",
    referenced_message_id: "600000000000000001",
    is_reply: true,
  });
  // Bob reacts to Alice's message (reaction received by Alice).
  f.react("600000000000000001", R.member2);
  // A bot message (should be excluded by default).
  f.msg({
    message_id: "600000000000000004",
    author_id: R.bot,
    author_is_bot: true,
    created_at: "2024-06-02T12:00:00.000Z",
  });
  return f;
}

// 14/15/17/18/19/20/21. Core counts.
test("engagement counts are correct and bots are excluded by default", () => {
  const f = seedBasic();
  const ctx = ctxOf(f.store, makeReporting());
  const res = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE });
  const alice = res.members.find((m) => m.userId === R.member)!;
  const bob = res.members.find((m) => m.userId === R.member2)!;
  assert.ok(!res.members.some((m) => m.userId === R.bot), "bot excluded by default"); // 15

  assert.equal(alice.messagesSent, 2); // 14
  assert.equal(alice.activeDays, 2); // 17
  assert.equal(alice.distinctChannels, 2); // 18
  assert.equal(alice.directRepliesReceived, 1); // 19
  assert.equal(alice.uniqueMembersReplying, 1); // 20
  assert.equal(alice.reactionsReceived, 1); // 21
  assert.equal(bob.directRepliesSent, 1); // 19
  assert.equal(bob.uniqueMembersRepliedTo, 1); // 20
});

// 15 (opposite). include_bots surfaces bot authors.
test("include_bots includes bot authors", () => {
  const f = seedBasic();
  const ctx = ctxOf(f.store, makeReporting());
  const res = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE, includeBots: true });
  assert.ok(
    res.members.some((m) => m.userId === R.bot),
    "bot present when include_bots=true",
  );
});

// 16. Staff inclusion / exclusion.
test("staff can be included or excluded", () => {
  const f = seedBasic();
  f.member(R.staff);
  f.msg({
    message_id: "600000000000000010",
    author_id: R.staff,
    created_at: "2024-06-02T09:00:00.000Z",
  });
  const ctx = ctxOf(f.store, makeReporting());
  const withStaff = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE, includeStaff: true });
  assert.ok(withStaff.members.some((m) => m.userId === R.staff && m.isStaff));
  const noStaff = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE, includeStaff: false });
  assert.ok(!noStaff.members.some((m) => m.userId === R.staff));
});

// 21 (dedup). Duplicate reactions count once.
test("reactions received are de-duplicated", () => {
  const f = seedBasic();
  f.react("600000000000000001", R.member2); // same (message,user) again — ignored
  const ctx = ctxOf(f.store, makeReporting());
  const alice = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE }).members.find(
    (m) => m.userId === R.member,
  )!;
  assert.equal(alice.reactionsReceived, 1);
});

// 22. Sorting and result limits work.
test("sort_by and limit work", () => {
  const f = seedBasic();
  const ctx = ctxOf(f.store, makeReporting());
  const byMessages = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE, sortBy: "messages" });
  assert.equal(byMessages.members[0].userId, R.member, "Alice has the most messages");
  const limited = buildMemberEngagement(ctx, { guildId: R.guild, ...RANGE, limit: 1 });
  assert.equal(limited.members.length, 1);
});
