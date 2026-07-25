import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBackup } from "../src/operations/backup.js";
import { CliError } from "../src/cli/exitCodes.js";
import { makeTempDir, cleanup, seedTempDb, FAKE_TOKEN, SECRET_CONTENT } from "./ops-helpers.js";

let dir = "";
afterEach(() => {
  if (dir) cleanup(dir);
  dir = "";
});

// 46. Deterministic, collision-safe filenames.
test("backup filenames are deterministic and collision-safe", () => {
  dir = makeTempDir();
  const db = seedTempDb(dir);
  const out = join(dir, "backups");
  const a = createBackup(db, out, { now: new Date("2025-01-01T00:00:00.000Z") });
  assert.match(a.backupPath, /analytics-2025-01-01T00-00-00-000Z\.sqlite$/);
  // A different instant → a different, non-colliding name.
  const b = createBackup(db, out, { now: new Date("2025-01-01T00:00:01.000Z") });
  assert.notEqual(a.backupPath, b.backupPath);
});

// 47/48. The backup is consistent and passes verification.
test("backup is verified (opens read-only and integrity-checks)", () => {
  dir = makeTempDir();
  const db = seedTempDb(dir);
  const r = createBackup(db, join(dir, "backups"), {});
  assert.ok(existsSync(r.backupPath));
  const verify = new DatabaseSync(r.backupPath, { readOnly: true });
  const integrity = verify.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, "ok");
  const count = verify.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
  assert.ok(count.c > 0, "backup contains the seeded rows");
  verify.close();
});

// 50. Manifest contains no token, content, or private absolute path.
test("manifest is secret-free", () => {
  dir = makeTempDir();
  process.env.DISCORD_TOKEN = FAKE_TOKEN;
  const db = seedTempDb(dir);
  const r = createBackup(db, join(dir, "backups"), {});
  const m = JSON.stringify(r.manifest);
  assert.ok(!m.includes(FAKE_TOKEN));
  assert.ok(!m.includes(SECRET_CONTENT));
  assert.ok(!m.includes(dir), "no absolute temp/home path in manifest");
  assert.equal(r.manifest?.sourceDatabaseBasename, "analytics.sqlite");
  assert.equal(r.manifest?.contentStorage, "yes");
});

// 49/51. Dry-run writes nothing; a failed backup leaves no file.
test("dry-run writes nothing and missing-source fails cleanly", () => {
  dir = makeTempDir();
  const db = seedTempDb(dir);
  const dry = createBackup(db, join(dir, "backups"), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(!existsSync(join(dir, "backups")), "dry-run created no directory/file");

  assert.throws(() => createBackup(join(dir, "nope.sqlite"), join(dir, "backups"), {}), CliError);
  // No stray partial backup remains.
  const files = existsSync(join(dir, "backups")) ? readdirSync(join(dir, "backups")) : [];
  assert.equal(files.length, 0);
});
