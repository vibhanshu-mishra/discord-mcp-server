import { test } from "node:test";
import assert from "node:assert/strict";
import { syncMessageHistory } from "../src/analytics/sync.js";
import {
  makeRepo,
  makeConfig,
  makeFakeSource,
  fakeSourceMessage,
  IDS,
} from "./analytics-helpers.js";

/** Builds N messages dated day-by-day going back from a base date. */
function messagesAcrossDays(prefix: string, count: number): ReturnType<typeof fakeSourceMessage>[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return fakeSourceMessage({ id: `${prefix}${day}`, createdAt: `2024-06-${day}T12:00:00.000Z` });
  });
}

// 11. Re-running a historical sync is idempotent (no duplicate rows).
test("re-running a sync imports the same rows without duplicating them", async () => {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [{ id: IDS.channelA, messages: messagesAcrossDays("80000000000000010", 5) }],
  });
  const first = await syncMessageHistory(repo, source, makeConfig(), { guildId: IDS.guild });
  const second = await syncMessageHistory(repo, source, makeConfig(), { guildId: IDS.guild });
  assert.equal(first.totalMessages, 5);
  assert.equal(second.totalMessages, 5);
  const counts = repo.getMessageCounts({ guildId: IDS.guild }, "guild");
  assert.equal(counts[0].count, 5, "still five rows after two syncs");
});

// 12. History sync stops at the requested start date.
test("sync stops at the requested start date", async () => {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [{ id: IDS.channelA, messages: messagesAcrossDays("80000000000000020", 10) }],
  });
  // Keep only messages on/after 2024-06-06 (days 06..10 => 5 messages).
  const summary = await syncMessageHistory(repo, source, makeConfig(), {
    guildId: IDS.guild,
    startDate: "2024-06-06",
  });
  assert.equal(summary.totalMessages, 5);
  const rows = repo.getMessageCounts({ guildId: IDS.guild }, "day");
  assert.ok(
    rows.every((r) => (r.group ?? "") >= "2024-06-06"),
    "no message older than the start date was stored",
  );
});

// 13. A maximum-message safety limit is respected.
test("sync respects the per-channel message cap", async () => {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [{ id: IDS.channelA, messages: messagesAcrossDays("80000000000000030", 30) }],
  });
  const summary = await syncMessageHistory(repo, source, makeConfig({ syncPageLimit: 7 }), {
    guildId: IDS.guild,
    maxMessagesPerChannel: 10,
  });
  assert.equal(summary.totalMessages, 10, "cap enforced across pages");
});

// 14. One failed channel does not cancel the other channels.
test("a failing channel is isolated; others still sync", async () => {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [
      { id: IDS.channelA, messages: messagesAcrossDays("80000000000000040", 3) },
      { id: IDS.channelB, messages: messagesAcrossDays("80000000000000050", 4) },
    ],
    failChannels: [IDS.channelA],
  });
  const summary = await syncMessageHistory(repo, source, makeConfig(), { guildId: IDS.guild });
  const byChannel = Object.fromEntries(summary.channels.map((c) => [c.channelId, c]));
  assert.equal(byChannel[IDS.channelA].status, "failed");
  assert.equal(byChannel[IDS.channelB].status, "completed");
  assert.equal(byChannel[IDS.channelB].messagesImported, 4);
  // The failure is recorded as its own sync-run result.
  const failedRuns = repo.getSyncRuns({ guildId: IDS.guild, status: "failed" });
  assert.equal(failedRuns.length, 1);
  assert.equal(failedRuns[0].channel_id, IDS.channelA);
});

// 27. History synchronisation never calls a Discord write method, and never
// leaks message content into progress logs.
test("sync never writes to Discord and never logs content", async () => {
  const repo = makeRepo();
  const secret = "TOP-SECRET-COMMUNITY-TEXT";
  const source = makeFakeSource({
    channels: [
      {
        id: IDS.channelA,
        messages: [fakeSourceMessage({ id: "80000000000000060", content: secret })],
      },
    ],
  });
  const logs: string[] = [];
  await syncMessageHistory(repo, source, makeConfig(), { guildId: IDS.guild }, (m) => logs.push(m));
  // The fake source exposes only read methods; there is no write surface to call.
  // Progress logs must be counts only — never the message body.
  assert.ok(logs.length > 0, "progress was logged");
  assert.ok(!logs.join("\n").includes(secret), "message content must never appear in logs");
  // And the content was in fact stored locally (proving we had it but didn't log it).
  assert.equal(repo.getMessage("80000000000000060")?.content, secret);
});

// dry-run estimates without writing.
test("dry-run counts messages without writing rows", async () => {
  const repo = makeRepo();
  const source = makeFakeSource({
    channels: [{ id: IDS.channelA, messages: messagesAcrossDays("80000000000000070", 6) }],
  });
  const summary = await syncMessageHistory(repo, source, makeConfig(), {
    guildId: IDS.guild,
    dryRun: true,
  });
  assert.equal(summary.totalMessages, 6);
  assert.equal(summary.dryRun, true);
  assert.equal(repo.getMessageCounts({ guildId: IDS.guild }, "guild").length, 0, "nothing written");
});
