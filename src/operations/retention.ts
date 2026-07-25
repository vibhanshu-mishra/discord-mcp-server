/**
 * Manual, privacy-focused retention: deletes analytics records older than a
 * cutoff date inside a single transaction, cascading to dependent attachments and
 * reactions so nothing is orphaned. Guild, channel, and member metadata are
 * preserved; open voice sessions and any record newer than the cutoff are never
 * deleted. This is CLI-only — deletion is intentionally not exposed as an MCP tool.
 */
import type { DatabaseSync } from "node:sqlite";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PruneCounts {
  messages: number;
  attachments: number;
  reactions: number;
  voiceSessions: number;
  syncRuns: number;
}

/** Validates a YYYY-MM-DD cutoff and returns its UTC lower bound, or null. */
export function cutoffBoundary(date: string): string | null {
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  return `${date}T00:00:00.000Z`;
}

/** Counts the records that a prune before `cutoffIso` would remove (read-only). */
export function computePruneCounts(db: DatabaseSync, cutoffIso: string): PruneCounts {
  const scalar = (sql: string, param: string): number =>
    (db.prepare(sql).get(param) as { c: number }).c;
  const messages = scalar("SELECT COUNT(*) AS c FROM messages WHERE created_at < ?", cutoffIso);
  const attachments = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM attachments
          WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ?)`,
      )
      .get(cutoffIso) as { c: number }
  ).c;
  const reactions = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM reactions
          WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ?)`,
      )
      .get(cutoffIso) as { c: number }
  ).c;
  const voiceSessions = (
    db
      .prepare("SELECT COUNT(*) AS c FROM voice_sessions WHERE joined_at < ? AND is_open = 0")
      .get(cutoffIso) as { c: number }
  ).c;
  const syncRuns = scalar("SELECT COUNT(*) AS c FROM sync_runs WHERE started_at < ?", cutoffIso);
  return { messages, attachments, reactions, voiceSessions, syncRuns };
}

/**
 * Deletes records older than `cutoffIso` inside a transaction, cascading to
 * dependent attachments/reactions first so none are orphaned. Open voice sessions
 * are preserved. Rolls back on any error.
 */
export function executePrune(db: DatabaseSync, cutoffIso: string): PruneCounts {
  const counts = computePruneCounts(db, cutoffIso);
  db.exec("BEGIN");
  try {
    db.prepare(
      `DELETE FROM attachments
        WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ?)`,
    ).run(cutoffIso);
    db.prepare(
      `DELETE FROM reactions
        WHERE message_id IN (SELECT message_id FROM messages WHERE created_at < ?)`,
    ).run(cutoffIso);
    db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoffIso);
    db.prepare("DELETE FROM voice_sessions WHERE joined_at < ? AND is_open = 0").run(cutoffIso);
    db.prepare("DELETE FROM sync_runs WHERE started_at < ?").run(cutoffIso);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err instanceof Error ? err : new Error(String(err));
  }
  return counts;
}

/** Runs an integrity check and returns whether it passed and the raw result. */
export function integrityCheck(db: DatabaseSync): { ok: boolean; detail: string } {
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  return { ok: row.integrity_check === "ok", detail: row.integrity_check };
}
