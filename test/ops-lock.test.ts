import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { acquireLock, readLock, isStale, clearStaleLock } from "../src/operations/processLock.js";
import { CliError } from "../src/cli/exitCodes.js";
import { makeTempDir, cleanup, FAKE_TOKEN } from "./ops-helpers.js";

let dir = "";
afterEach(() => {
  if (dir) cleanup(dir);
  dir = "";
});

// 28/29. First writer acquires; second is rejected with the lock exit code.
test("first writer acquires, second is rejected", () => {
  dir = makeTempDir();
  const lockPath = join(dir, "a.lock");
  const first = acquireLock(lockPath, "/tmp/db.sqlite", "sync");
  assert.ok(existsSync(lockPath));
  try {
    acquireLock(lockPath, "/tmp/db.sqlite", "prune");
    assert.fail("second acquire should have thrown");
  } catch (err) {
    assert.ok(err instanceof CliError);
    assert.equal((err as CliError).code, 6);
  }
  first.release();
  assert.ok(!existsSync(lockPath), "release removes the lock"); // 31
});

// 30. Lock metadata contains no secret.
test("lock metadata contains no token or database path", () => {
  dir = makeTempDir();
  const lockPath = join(dir, "b.lock");
  process.env.DISCORD_TOKEN = FAKE_TOKEN;
  const h = acquireLock(lockPath, "/private/secret/path/db.sqlite", "sync");
  const raw = readFileSync(lockPath, "utf8");
  assert.ok(!raw.includes(FAKE_TOKEN), "no token in lock");
  assert.ok(!raw.includes("/private/secret/path"), "no raw db path (only a hash)");
  const info = JSON.parse(raw);
  assert.equal(typeof info.dbPathHash, "string");
  assert.equal(info.kind, "sync");
  h.release();
});

// 33/34/35. A live lock is not cleared; a stale lock is detected and clearable.
test("live lock is not cleared; stale lock is detected and cleared explicitly", () => {
  dir = makeTempDir();
  const lockPath = join(dir, "c.lock");

  // A live lock (our own PID) must not be cleared.
  const live = acquireLock(lockPath, "/tmp/db.sqlite", "collector");
  assert.equal(isStale(live.info), false);
  const notCleared = clearStaleLock(lockPath);
  assert.equal(notCleared.cleared, false); // 33
  live.release();

  // A stale lock: same host, a PID that is not alive.
  const stale = {
    pid: 2_000_000_000,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    dbPathHash: "abc",
    kind: "sync",
  };
  writeFileSync(lockPath, JSON.stringify(stale));
  assert.equal(isStale(readLock(lockPath)!), true); // 34
  const cleared = clearStaleLock(lockPath);
  assert.equal(cleared.cleared, true); // 35
  assert.ok(!existsSync(lockPath));
});

// A lock from another host is treated as live (cannot verify remotely).
test("a lock from another host is treated as live", () => {
  dir = makeTempDir();
  const lockPath = join(dir, "d.lock");
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 1,
      startedAt: new Date().toISOString(),
      hostname: "some-other-host",
      dbPathHash: "x",
      kind: "collector",
    }),
  );
  assert.equal(isStale(readLock(lockPath)!), false);
  assert.equal(clearStaleLock(lockPath).cleared, false);
});

// 37. Sync and prune use the same lock policy (same lock path/kind mechanism).
test("write commands share one lock so a second writer is blocked", () => {
  dir = makeTempDir();
  const lockPath = join(dir, "e.lock");
  const sync = acquireLock(lockPath, "/tmp/db.sqlite", "sync");
  assert.throws(() => acquireLock(lockPath, "/tmp/db.sqlite", "prune"), CliError);
  sync.release();
  // After release, prune can take it.
  const prune = acquireLock(lockPath, "/tmp/db.sqlite", "prune");
  prune.release();
});
