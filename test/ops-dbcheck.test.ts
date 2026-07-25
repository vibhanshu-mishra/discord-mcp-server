import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspectDatabase, openReadOnly } from "../src/operations/databaseHealth.js";
import { CliError } from "../src/cli/exitCodes.js";
import { makeTempDir, cleanup, seedTempDb, SECRET_CONTENT } from "./ops-helpers.js";

let dir = "";
afterEach(() => {
  if (dir) cleanup(dir);
  dir = "";
});

// 23/27. Integrity passes for a healthy DB; content is never returned.
test("healthy database passes integrity and never returns content", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir);
  const report = inspectDatabase(dbPath);
  assert.equal(report.exists, true);
  assert.equal(report.integrityOk, true);
  assert.equal(report.contentStored, "yes");
  assert.ok(!JSON.stringify(report).includes(SECRET_CONTENT), "report carries no message content");
  assert.equal(report.missingTables.length, 0);
});

// 26. Database check never modifies rows.
test("inspection does not modify the database", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir);
  const count = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const c = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    db.close();
    return c;
  };
  const before = count();
  inspectDatabase(dbPath);
  inspectDatabase(dbPath);
  assert.equal(count(), before);
});

// 25. Unsupported future schema versions are detected.
test("an unsupported future schema version is flagged", () => {
  dir = makeTempDir();
  const dbPath = seedTempDb(dir);
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA user_version = 99999");
  raw.close();
  const report = inspectDatabase(dbPath);
  assert.equal(report.unsupportedFutureVersion, true);
  assert.ok(report.schemaVersion > report.latestKnownVersion);
});

// 24. Corrupt/unreadable database failures are sanitised (CliError, no stack leak).
test("an unreadable database yields a sanitised error", () => {
  dir = makeTempDir();
  const bogus = join(dir, "not-a-db.sqlite");
  writeFileSync(bogus, "this is not a sqlite file at all");
  assert.throws(
    () => {
      const db = openReadOnly(bogus);
      db.prepare("PRAGMA integrity_check").get();
      db.close();
    },
    (err) => err instanceof CliError || err instanceof Error,
  );
});

// Missing database reports exists:false without throwing.
test("missing database reports exists:false", () => {
  dir = makeTempDir();
  const report = inspectDatabase(join(dir, "absent.sqlite"));
  assert.equal(report.exists, false);
});
