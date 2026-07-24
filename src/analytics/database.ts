/**
 * Opens and migrates the local SQLite analytics database using Node's built-in
 * `node:sqlite` engine (no native build step, ships with Node 24). The database
 * is fully initialised — pragmas set and all migrations applied — before it is
 * handed back, so no caller can write to an unmigrated schema.
 *
 * This module never contacts Discord. It only manages a local file.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";

/** Applies pending migrations, tracking the applied version in `user_version`. */
export function runMigrations(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  let current = row?.user_version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      current = migration.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Analytics migration ${migration.version} (${migration.name}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }
  return current;
}

/**
 * Opens (creating if needed) the analytics database at `dbPath`, sets safe
 * pragmas, and runs migrations. Pass `:memory:` in tests for an isolated DB.
 * @throws {Error} A clear, secret-free error if the database cannot be opened or migrated.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (err) {
      throw new Error(
        `Cannot create analytics database directory for "${dbPath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new Error(
      `Cannot open analytics database at "${dbPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }

  try {
    // WAL improves concurrent read/write; foreign_keys and a busy timeout guard
    // integrity and transient locks. NORMAL sync is durable enough for analytics.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    runMigrations(db);
  } catch (err) {
    db.close();
    throw err instanceof Error ? err : new Error(String(err), { cause: err });
  }

  return db;
}

/** Closes the database, swallowing "already closed" errors. */
export function closeDatabase(db: DatabaseSync | null | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closed or never opened — nothing to do.
  }
}
