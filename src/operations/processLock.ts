/**
 * A generic, atomic file lock preventing two writers (live collector, CLI sync,
 * or prune) from using the same database at once. The lock file is created with
 * an exclusive `wx` open so acquisition is atomic. It stores enough metadata to
 * distinguish a stale lock from a live one WITHOUT relying only on the PID
 * (which the OS can reuse): process ID, start time, hostname, a hash of the
 * database path, and the command/kind.
 *
 * Locks are never auto-deleted when they look stale — the operator is told, and
 * clearing requires an explicit, confirmed action. Read-only reporting/export
 * commands do not take this lock. Crash note: a hard crash (SIGKILL, power loss)
 * can leave a lock behind; the stale-detection + explicit `--clear-stale-lock`
 * recovery path handles that case.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { CliError, EXIT } from "../cli/exitCodes.js";

export interface LockInfo {
  pid: number;
  startedAt: string;
  hostname: string;
  /** Hash of the absolute database path (never the path itself, no secrets). */
  dbPathHash: string;
  /** The command/process type holding the lock (e.g. "sync", "prune", "collector"). */
  kind: string;
}

export interface LockHandle {
  path: string;
  info: LockInfo;
  release(): void;
}

function dbHash(dbPath: string): string {
  return createHash("sha256").update(dbPath).digest("hex").slice(0, 16);
}

/** True when the given PID is a live process on this host. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads and parses a lock file, or null if absent/unparseable. */
export function readLock(lockPath: string): LockInfo | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
    if (typeof parsed.pid === "number" && typeof parsed.hostname === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decides whether an existing lock is demonstrably stale. Only a same-host lock
 * whose PID is no longer alive is considered stale. A lock from a different host
 * cannot be verified remotely and is treated as LIVE (fail safe).
 */
export function isStale(info: LockInfo): boolean {
  if (info.hostname !== hostname()) return false;
  return !pidAlive(info.pid);
}

/**
 * Atomically acquires the lock for `kind`. Refuses when a lock already exists
 * (whether live or stale — stale locks are reported, never silently removed).
 * @throws {CliError} with the lock exit code when another writer holds it.
 */
export function acquireLock(lockPath: string, dbPath: string, kind: string): LockHandle {
  const existing = readLock(lockPath);
  if (existing) {
    const staleNote = isStale(existing)
      ? " The existing lock appears STALE (same host, dead PID); recover with `db-check --clear-stale-lock`."
      : "";
    throw new CliError(
      `Another writer holds the database lock (kind: ${existing.kind}, pid: ${existing.pid}, host: ${existing.hostname}).${staleNote}`,
      EXIT.LOCK,
    );
  }

  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    dbPathHash: dbHash(dbPath),
    kind,
  };

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // directory may already exist
  }

  let fd: number;
  try {
    fd = openSync(lockPath, "wx"); // exclusive create — atomic
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError("Another writer acquired the database lock concurrently.", EXIT.LOCK);
    }
    throw new CliError(
      `Cannot create the lock file: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.LOCK,
    );
  }
  writeSync(fd, JSON.stringify(info, null, 2));
  closeSync(fd);

  let released = false;
  return {
    path: lockPath,
    info,
    release() {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours (guards against clobbering a
      // lock another process created after a crash cleared ours).
      const current = readLock(lockPath);
      if (current && current.pid === info.pid && current.startedAt === info.startedAt) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/**
 * Clears a lock ONLY when it is demonstrably stale, unless `force` is set.
 * Returns what happened so the caller can report it.
 */
export function clearStaleLock(
  lockPath: string,
  force = false,
): { cleared: boolean; reason: string; info: LockInfo | null } {
  const info = readLock(lockPath);
  if (!info) return { cleared: false, reason: "no lock file present", info: null };
  if (!force && !isStale(info)) {
    return { cleared: false, reason: "the lock appears LIVE and was not cleared", info };
  }
  try {
    unlinkSync(lockPath);
  } catch (err) {
    return {
      cleared: false,
      reason: `could not remove the lock file: ${err instanceof Error ? err.message : String(err)}`,
      info,
    };
  }
  return { cleared: true, reason: force ? "cleared (forced)" : "cleared (stale)", info };
}
