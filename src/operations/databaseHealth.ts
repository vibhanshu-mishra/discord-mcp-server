/**
 * Read-only SQLite health inspection. Opens the database in read-only mode (never
 * migrating or modifying it), runs an integrity check, and reports schema and
 * content statistics. It never returns message content — only counts, timestamps,
 * and a stored-content yes/no/unknown indicator.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { MIGRATIONS } from "../analytics/migrations.js";
import { CliError, EXIT } from "../cli/exitCodes.js";

const REQUIRED_TABLES = [
  "guilds",
  "channels",
  "members",
  "messages",
  "attachments",
  "reactions",
  "voice_sessions",
  "sync_runs",
] as const;

const REQUIRED_INDEXES = [
  "idx_messages_created",
  "idx_messages_referenced",
  "idx_messages_guild_channel_created",
  "idx_reactions_message",
  "idx_channels_parent",
] as const;

/** The highest schema version this build knows how to run. */
export function latestSchemaVersion(): number {
  return Math.max(0, ...MIGRATIONS.map((m) => m.version));
}

export interface DatabaseHealthReport {
  exists: boolean;
  fileSizeBytes: number | null;
  integrityOk: boolean;
  integrityDetail: string;
  schemaVersion: number;
  latestKnownVersion: number;
  migrationsCurrent: boolean;
  unsupportedFutureVersion: boolean;
  tableCounts: Record<string, number>;
  missingTables: string[];
  missingIndexes: string[];
  openVoiceSessions: number;
  latestSync: { status: string; completedAt: string | null } | null;
  oldestMessageAt: string | null;
  newestMessageAt: string | null;
  /** Whether readable message content is stored: yes / no / unknown. */
  contentStored: "yes" | "no" | "unknown";
}

/** Opens the database read-only. @throws {CliError} with the database exit code. */
export function openReadOnly(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    throw new CliError(`Database file does not exist at the configured path.`, EXIT.DATABASE);
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new CliError(
      `Cannot open the database (read-only): ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DATABASE,
    );
  }
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/**
 * Inspects the database at `dbPath` without modifying it. When the file is
 * missing, returns a report with `exists: false`.
 */
export function inspectDatabase(dbPath: string): DatabaseHealthReport {
  const exists = dbPath === ":memory:" || existsSync(dbPath);
  const empty: DatabaseHealthReport = {
    exists: false,
    fileSizeBytes: null,
    integrityOk: false,
    integrityDetail: "database file not found",
    schemaVersion: 0,
    latestKnownVersion: latestSchemaVersion(),
    migrationsCurrent: false,
    unsupportedFutureVersion: false,
    tableCounts: {},
    missingTables: [...REQUIRED_TABLES],
    missingIndexes: [...REQUIRED_INDEXES],
    openVoiceSessions: 0,
    latestSync: null,
    oldestMessageAt: null,
    newestMessageAt: null,
    contentStored: "unknown",
  };
  if (!exists) return empty;

  const db = openReadOnly(dbPath);
  try {
    const fileSizeBytes = dbPath === ":memory:" ? null : statSync(dbPath).size;
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    const integrityOk = integrity.integrity_check === "ok";

    const schemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    const latestKnownVersion = latestSchemaVersion();

    const existingTables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      ).map((r) => r.name),
    );
    const existingIndexes = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
      ).map((r) => r.name),
    );
    const missingTables = REQUIRED_TABLES.filter((t) => !existingTables.has(t));
    const missingIndexes = REQUIRED_INDEXES.filter((i) => !existingIndexes.has(i));

    const tableCounts: Record<string, number> = {};
    for (const t of REQUIRED_TABLES) if (existingTables.has(t)) tableCounts[t] = count(db, t);

    const openVoiceSessions = existingTables.has("voice_sessions")
      ? (
          db.prepare("SELECT COUNT(*) AS c FROM voice_sessions WHERE is_open = 1").get() as {
            c: number;
          }
        ).c
      : 0;

    let latestSync: DatabaseHealthReport["latestSync"] = null;
    if (existingTables.has("sync_runs")) {
      const row = db
        .prepare("SELECT status, completed_at FROM sync_runs ORDER BY started_at DESC LIMIT 1")
        .get() as { status: string; completed_at: string | null } | undefined;
      if (row) latestSync = { status: row.status, completedAt: row.completed_at };
    }

    let oldestMessageAt: string | null = null;
    let newestMessageAt: string | null = null;
    let contentStored: DatabaseHealthReport["contentStored"] = "unknown";
    if (existingTables.has("messages")) {
      const range = db
        .prepare(
          "SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest, COUNT(*) AS total FROM messages",
        )
        .get() as { oldest: string | null; newest: string | null; total: number };
      oldestMessageAt = range.oldest;
      newestMessageAt = range.newest;
      if (range.total > 0) {
        const withContent = (
          db
            .prepare("SELECT EXISTS(SELECT 1 FROM messages WHERE content IS NOT NULL) AS e")
            .get() as { e: number }
        ).e;
        contentStored = withContent ? "yes" : "no";
      }
    }

    return {
      exists: true,
      fileSizeBytes,
      integrityOk,
      integrityDetail: integrity.integrity_check,
      schemaVersion,
      latestKnownVersion,
      migrationsCurrent: schemaVersion === latestKnownVersion,
      unsupportedFutureVersion: schemaVersion > latestKnownVersion,
      tableCounts,
      missingTables,
      missingIndexes,
      openVoiceSessions,
      latestSync,
      oldestMessageAt,
      newestMessageAt,
      contentStored,
    };
  } finally {
    db.close();
  }
}
