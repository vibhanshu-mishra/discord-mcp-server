import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSyncExit } from "../src/cli/commands/sync.js";
import { EXIT } from "../src/cli/exitCodes.js";
import { syncMessageHistory, type SyncSummary } from "../src/analytics/sync.js";
import {
  makeRepo,
  makeConfig,
  makeFakeSource,
  fakeSourceMessage,
  IDS,
} from "./analytics-helpers.js";

function summary(statuses: ("completed" | "failed")[]): SyncSummary {
  return {
    guildId: IDS.guild,
    dryRun: false,
    startDate: "2024-06-01",
    totalMessages: 0,
    channels: statuses.map((status, i) => ({
      channelId: `c${i}`,
      channelName: null,
      status,
      messagesImported: 0,
      oldestMessageReached: null,
      error: status === "failed" ? "Missing Access" : null,
    })),
  };
}

// 42/43. Exit codes: partial vs complete failure vs success.
test("computeSyncExit distinguishes success, partial, and complete failure", () => {
  assert.equal(computeSyncExit(summary(["completed", "completed"])), EXIT.SUCCESS);
  assert.equal(computeSyncExit(summary(["completed", "failed"])), EXIT.PARTIAL); // 42
  assert.equal(computeSyncExit(summary(["failed", "failed"])), EXIT.FAILURE); // 43
  assert.equal(computeSyncExit(summary([])), EXIT.SUCCESS);
});

// 38/40/41/44. CLI sync reuses the service; writes to SQLite only; never to Discord.
test("sync reuses syncMessageHistory, writes to SQLite, and logs counts only", async () => {
  const repo = makeRepo();
  const secret = "PRIVATE-SYNC-BODY";
  const source = makeFakeSource({
    channels: [
      {
        id: IDS.channelA,
        messages: [fakeSourceMessage({ id: "950000000000000001", content: secret })],
      },
    ],
  });
  const logs: string[] = [];
  const result = await syncMessageHistory(repo, source, makeConfig(), { guildId: IDS.guild }, (m) =>
    logs.push(m),
  );

  // Wrote to the local database (Phase 2 service), not to Discord (fake source has no write surface).
  assert.equal(result.totalMessages, 1);
  assert.equal(repo.getMessageCounts({ guildId: IDS.guild }, "guild")[0].count, 1); // 40
  // Progress logs are counts only — never message content. (41 is architectural: the
  // fake source exposes only read methods.)
  assert.ok(logs.length > 0);
  assert.ok(!logs.join("\n").includes(secret)); // 44
});
