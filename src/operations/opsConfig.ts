/**
 * Operational configuration: filesystem locations and retention settings used by
 * the CLI and operations layer. Reuses the analytics database path from the
 * existing analytics config; adds only lock/backup/export locations and the
 * (manual-only) retention default. Never reads or exposes the Discord token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAnalyticsConfig } from "../analytics/config.js";

/** The application version from package.json (for backup manifests, doctor, etc.). */
export function getAppVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const DEFAULT_LOCK_PATH = "data/discord-analytics.lock";
export const DEFAULT_BACKUP_DIR = "backups";
export const DEFAULT_EXPORT_DIR = "exports";

export interface OperationsConfig {
  /** SQLite database path (shared with the analytics runtime). */
  dbPath: string;
  lockPath: string;
  backupDir: string;
  exportDir: string;
  /** Default retention cutoff in days; 0 (default) means retention is disabled. */
  retentionDays: number;
}

function trimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/** Resolves operational paths and retention, applying safe defaults. */
export function getOperationsConfig(): OperationsConfig {
  const dbPath = getAnalyticsConfig().dbPath;
  const retentionRaw = trimmed("DISCORD_ANALYTICS_RETENTION_DAYS");
  let retentionDays = 0;
  if (retentionRaw !== undefined) {
    const n = Number(retentionRaw);
    if (Number.isInteger(n) && n >= 0) retentionDays = n;
  }
  return {
    dbPath,
    lockPath: trimmed("DISCORD_ANALYTICS_LOCK_PATH") ?? DEFAULT_LOCK_PATH,
    backupDir: trimmed("DISCORD_ANALYTICS_BACKUP_DIR") ?? DEFAULT_BACKUP_DIR,
    exportDir: trimmed("DISCORD_ANALYTICS_EXPORT_DIR") ?? DEFAULT_EXPORT_DIR,
    retentionDays,
  };
}
