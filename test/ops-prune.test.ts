import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, closeDatabase } from "../src/analytics/database.js";
import {
  cutoffBoundary,
  computePruneCounts,
  executePrune,
  integrityCheck,
} from "../src/operations/retention.js";
import analyticsModule from "../src/tools/analytics.js";
import { EXIT } from "../src/cli/exitCodes.js";
import { makeTempDir, cleanup, seedTempDb, runCli } from "./ops-helpers.js";

let dir = "";
afterEach(() => {
  if (dir) cleanup(dir);
  dir = "";
});

const CUTOFF = cutoffBoundary("2025-01-01")!;

// 65. Invalid cutoff dates are rejected.
test("cutoffBoundary rejects invalid dates", () => {
  assert.equal(cutoffBoundary("2025-13-40"), null);
  assert.equal(cutoffBoundary("nope"), null);
  assert.ok(cutoffBoundary("2025-01-01"));
});

// 66/67/68/69/72/73. Prune counts, deletion, cascade, open-voice preservation, integrity.
test("prune removes only old records, cascades, and preserves open voice + integrity", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir, { withOpenVoice: true });
  const db = openDatabase(dbPath);
  try {
    const counts = computePruneCounts(db, CUTOFF);
    assert.deepEqual(counts, {
      messages: 1,
      attachments: 1,
      reactions: 1,
      voiceSessions: 0,
      syncRuns: 0,
    }); // 66

    const before = {
      messages: (db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c,
      voice: (db.prepare("SELECT COUNT(*) c FROM voice_sessions").get() as { c: number }).c,
    };
    executePrune(db, CUTOFF);

    const afterMessages = (db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
    assert.equal(afterMessages, before.messages - 1, "only the old message removed"); // 67
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM attachments").get() as { c: number }).c,
      0,
      "orphan attachment removed",
    ); // 68
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM reactions").get() as { c: number }).c,
      0,
      "orphan reaction removed",
    ); // 68
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM voice_sessions").get() as { c: number }).c,
      before.voice,
      "open voice session preserved",
    ); // 69
    // Recent messages remain.
    assert.ok(
      (
        db.prepare("SELECT COUNT(*) c FROM messages WHERE created_at >= ?").get(CUTOFF) as {
          c: number;
        }
      ).c >= 2,
    );
    assert.equal(integrityCheck(db).ok, true); // 73
  } finally {
    closeDatabase(db);
  }
});

// 76. Prune is not available as an MCP tool.
test("no MCP tool exposes deletion/prune", () => {
  const names = analyticsModule.definitions.map((d) => d.name);
  assert.ok(!names.some((n) => /prune|delete|purge|retention/i.test(n)));
});

// 63/64/70/71/74/75. CLI: dry-run default, confirm required, backup-before, no-backup warning, retention 0.
test("prune CLI: dry-run default, confirm deletes with a backup, retention 0 disables default", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir);
  const env = {
    DISCORD_ANALYTICS_DB_PATH: dbPath,
    DISCORD_ANALYTICS_BACKUP_DIR: join(dir, "backups"),
    DISCORD_ANALYTICS_LOCK_PATH: join(dir, "p.lock"),
    DISCORD_ANALYTICS_RETENTION_DAYS: "0",
  };

  // Default is dry-run: nothing deleted, no backup.
  const dry = runCli(["prune", "--before", "2025-01-01"], env);
  assert.equal(dry.status, EXIT.SUCCESS); // 63
  assert.ok(!existsSync(join(dir, "backups")), "dry-run made no backup");

  // Retention 0 + no --before → no default cutoff.
  const noCutoff = runCli(["prune"], env);
  assert.equal(noCutoff.status, EXIT.INVALID_ARG); // 74/75

  // --confirm deletes AND makes a safety backup first.
  const confirmed = runCli(["prune", "--before", "2025-01-01", "--confirm"], env);
  assert.equal(confirmed.status, EXIT.SUCCESS); // 64
  assert.ok(
    readdirSync(join(dir, "backups")).some((f) => f.endsWith(".sqlite")),
    "safety backup created before delete",
  ); // 70

  // --no-backup warns explicitly.
  const noBackup = runCli(["prune", "--before", "2030-01-01", "--confirm", "--no-backup"], env);
  assert.equal(noBackup.status, EXIT.SUCCESS);
  assert.match(noBackup.stdout, /WARNING: --no-backup/); // 71
});
