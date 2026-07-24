import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserActivity } from "../src/analytics/reporting/userActivity.js";
import { makeFixture, makeReporting, ctxOf, R } from "./reporting-helpers.js";

const RANGE = { startDate: "2024-06-01", endDate: "2024-06-07" };

// Invented users: Community Owner (R.owner), Member One (R.member), Member Two (R.member2).

// 23/24/25. Message and reply counts, first-response metrics for a supplied user.
test("user activity counts messages, unique reply targets, and first responses", () => {
  const f = makeFixture();
  f.member(R.owner, { username: "community-owner", display: "Community Owner" });
  // Two member questions.
  f.msg({
    message_id: "800000000000000001",
    author_id: R.member,
    created_at: "2024-06-02T10:00:00.000Z",
    content: "how do I A?",
  });
  f.msg({
    message_id: "800000000000000002",
    author_id: R.member2,
    created_at: "2024-06-02T11:00:00.000Z",
    content: "how do I B?",
  });
  // The Community Owner replies to both (first responder), 15 and 45 min later.
  f.msg({
    message_id: "800000000000000003",
    author_id: R.owner,
    created_at: "2024-06-02T10:15:00.000Z",
    referenced_message_id: "800000000000000001",
    is_reply: true,
  });
  f.msg({
    message_id: "800000000000000004",
    author_id: R.owner,
    created_at: "2024-06-02T11:45:00.000Z",
    referenced_message_id: "800000000000000002",
    is_reply: true,
  });

  const res = buildUserActivity(ctxOf(f.store, makeReporting()), {
    guildId: R.guild,
    userId: R.owner,
    ...RANGE,
  });
  assert.equal(res.userId, R.owner);
  assert.equal(res.totalMessages, 2); // 23
  assert.equal(res.directRepliesSent, 2);
  assert.equal(res.uniqueMembersRepliedTo, 2); // 24
  assert.equal(res.candidateQuestionsAnswered, 2); // 25
  assert.equal(res.medianFirstResponseSecondsWhenFirst, 1800); // median of 900 and 2700
});

// The generic tool works for ANY supplied user, not a specially-configured one.
test("user activity works for any supplied user, independent of configuration", () => {
  const f = makeFixture();
  // A plain member (Member One) who is NOT in the staff/primary configuration.
  f.msg({
    message_id: "800000000000000010",
    author_id: R.member,
    created_at: "2024-06-02T09:00:00.000Z",
    content: "hello there",
  });
  f.msg({
    message_id: "800000000000000011",
    author_id: R.member,
    created_at: "2024-06-03T09:00:00.000Z",
    content: "another message",
  });
  // Primary user unset — the tool still reports on the supplied user.
  const res = buildUserActivity(ctxOf(f.store, makeReporting({ primaryUserId: null })), {
    guildId: R.guild,
    userId: R.member,
    ...RANGE,
  });
  assert.equal(res.userId, R.member);
  assert.equal(res.totalMessages, 2);
  assert.equal(res.activeDays, 2);
});
