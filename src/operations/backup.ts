/**
 * Consistent SQLite backups via `VACUUM INTO`, which reads a consistent snapshot
 * even while a live collector is writing (WAL) and never modifies the source. The
 * result is verified (opened read-only + integrity check) and accompanied by a
 * secret-free manifest. A failed backup removes any incomplete file.
 *
 * Backups never contact Discord and never contain tokens, message content,
 * environment values, or absolute home-directory paths.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { getAppVersion } from "./opsConfig.js";
import { CliError, EXIT } from "../cli/exitCodes.js";

export interface BackupManifest {
  backupTimestamp: string;
  appVersion: string;
  schemaVersion: number;
  sourceDatabaseBasename: string;
  backupFilename: string;
  backupSizeBytes: number;
  contentStorage: "yes" | "no" | "unknown";
  checksumSha256: string;
}

export interface BackupResult {
  dryRun: boolean;
  backupPath: string;
  manifestPath: string;
  manifest: BackupManifest | null;
}

/** A filesystem-safe, sortable timestamp (no colons). */
function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function contentStorageOf(db: DatabaseSync): "yes" | "no" | "unknown" {
  const total = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
  if (total === 0) return "unknown";
  const withContent = (
    db.prepare("SELECT EXISTS(SELECT 1 FROM messages WHERE content IS NOT NULL) AS e").get() as {
      e: number;
    }
  ).e;
  return withContent ? "yes" : "no";
}

/**
 * Creates a consistent backup of `dbPath` in `outputDir`. With `dryRun`, only the
 * planned target path is returned and nothing is written.
 * @throws {CliError} on database/backup failure.
 */
export function createBackup(
  dbPath: string,
  outputDir: string,
  opts: { dryRun?: boolean; now?: Date } = {},
): BackupResult {
  if (!existsSync(dbPath)) {
    throw new CliError("Cannot back up: the database file does not exist.", EXIT.DATABASE);
  }
  const filename = `${basename(dbPath).replace(/\.[^.]+$/, "")}-${stamp(opts.now)}.sqlite`;
  const backupPath = join(outputDir, filename);
  const manifestPath = `${backupPath}.manifest.json`;

  if (opts.dryRun) {
    return { dryRun: true, backupPath, manifestPath, manifest: null };
  }

  try {
    mkdirSync(outputDir, { recursive: true });
  } catch (err) {
    throw new CliError(
      `Cannot create the backup directory: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DATABASE,
    );
  }
  if (existsSync(backupPath)) {
    throw new CliError(
      "A backup with this name already exists; refusing to overwrite.",
      EXIT.DATABASE,
    );
  }

  // Read source content-storage flag and schema, then snapshot it.
  let schemaVersion: number;
  let contentStorage: "yes" | "no" | "unknown";
  const source = new DatabaseSync(dbPath); // read-write, but VACUUM INTO does not modify the source
  try {
    schemaVersion = (source.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    contentStorage = contentStorageOf(source);
    const escaped = backupPath.replace(/'/g, "''");
    source.exec(`VACUUM INTO '${escaped}'`);
  } catch (err) {
    if (existsSync(backupPath)) tryUnlink(backupPath);
    throw new CliError(
      `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DATABASE,
    );
  } finally {
    source.close();
  }

  // Verify the backup opens read-only and passes an integrity check.
  try {
    const verify = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = verify.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      if (integrity.integrity_check !== "ok") throw new Error("integrity check did not return ok");
    } finally {
      verify.close();
    }
  } catch (err) {
    tryUnlink(backupPath);
    throw new CliError(
      `Backup verification failed: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.DATABASE,
    );
  }

  const backupSizeBytes = statSync(backupPath).size;
  const checksumSha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
  const manifest: BackupManifest = {
    backupTimestamp: (opts.now ?? new Date()).toISOString(),
    appVersion: getAppVersion(),
    schemaVersion,
    sourceDatabaseBasename: basename(dbPath),
    backupFilename: filename,
    backupSizeBytes,
    contentStorage,
    checksumSha256,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { dryRun: false, backupPath, manifestPath, manifest };
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* nothing to clean up */
  }
}
