/**
 * `prune` — manual, privacy-focused retention. Defaults to a DRY RUN; actual
 * deletion requires an explicit `--confirm`. It validates the cutoff, takes a
 * backup first (unless `--no-backup`, which is warned), acquires the exclusive
 * writer lock, deletes inside a transaction (cascading to attachments/reactions,
 * preserving open voice sessions and metadata), and runs an integrity check
 * afterwards. It never auto-runs and is intentionally not an MCP tool.
 */
import { EXIT, CliError } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import { acquireLock } from "../../operations/processLock.js";
import { createBackup } from "../../operations/backup.js";
import { openDatabase, closeDatabase } from "../../analytics/database.js";
import {
  cutoffBoundary,
  computePruneCounts,
  executePrune,
  integrityCheck,
} from "../../operations/retention.js";

function defaultCutoffFromRetention(retentionDays: number, now = new Date()): string | null {
  if (retentionDays <= 0) return null;
  return new Date(now.getTime() - retentionDays * 86_400_000).toISOString().slice(0, 10);
}

export async function run(args: Args): Promise<number> {
  const ops = getOperationsConfig();
  const json = args.bool("json");

  const beforeArg = args.get("before");
  const cutoffDate = beforeArg ?? defaultCutoffFromRetention(ops.retentionDays);
  if (!cutoffDate) {
    throw new CliError(
      "No cutoff: pass --before YYYY-MM-DD (DISCORD_ANALYTICS_RETENTION_DAYS=0 disables the default).",
      EXIT.INVALID_ARG,
    );
  }
  const cutoffIso = cutoffBoundary(cutoffDate);
  if (!cutoffIso)
    throw new CliError(
      `Invalid --before date "${cutoffDate}" (expected YYYY-MM-DD).`,
      EXIT.INVALID_ARG,
    );

  const confirm = args.bool("confirm");
  const noBackup = args.bool("no-backup");

  // ── Dry run (default) ──
  if (!confirm) {
    const db = openDatabase(ops.dbPath);
    try {
      const counts = computePruneCounts(db, cutoffIso);
      if (json)
        printJson({
          dryRun: true,
          cutoffDate,
          counts,
          note: "guild/channel/member metadata and open voice sessions are preserved",
        });
      else {
        printLine(`[dry-run] Prune before ${cutoffDate} would remove:`);
        printLine(`  messages:        ${counts.messages}`);
        printLine(`  attachments:     ${counts.attachments}`);
        printLine(`  reactions:       ${counts.reactions}`);
        printLine(`  voice sessions:  ${counts.voiceSessions} (open sessions preserved)`);
        printLine(`  sync runs:       ${counts.syncRuns}`);
        printLine(
          `Guild, channel, and member metadata are retained. Re-run with --confirm to delete.`,
        );
      }
    } finally {
      closeDatabase(db);
    }
    return EXIT.SUCCESS;
  }

  // ── Actual deletion ──
  if (noBackup) printLine("WARNING: --no-backup supplied; deleting WITHOUT a safety backup.");

  const lock = acquireLock(ops.lockPath, ops.dbPath, "prune");
  let backupFile: string | null = null;
  try {
    if (!noBackup) {
      const backup = createBackup(ops.dbPath, ops.backupDir, {});
      backupFile = backup.backupPath;
      printLine(`Safety backup created: ${backupFile}`);
    }
    const db = openDatabase(ops.dbPath);
    try {
      const counts = executePrune(db, cutoffIso);
      const integrity = integrityCheck(db);
      if (!integrity.ok)
        throw new CliError(`Post-prune integrity check failed: ${integrity.detail}`, EXIT.DATABASE);
      if (json)
        printJson({
          dryRun: false,
          cutoffDate,
          counts,
          backupFile,
          integrity: integrity.detail,
          vacuumRecommended: counts.messages > 0,
        });
      else {
        printLine(`Pruned records before ${cutoffDate}:`);
        printLine(
          `  messages ${counts.messages}, attachments ${counts.attachments}, reactions ${counts.reactions}, voice ${counts.voiceSessions}, sync-runs ${counts.syncRuns}`,
        );
        printLine(`Integrity check: ${integrity.detail}.`);
        if (counts.messages > 0)
          printLine(
            "Recommendation: reclaim space with a manual VACUUM when convenient (not run automatically).",
          );
      }
    } finally {
      closeDatabase(db);
    }
  } finally {
    lock.release();
  }
  return EXIT.SUCCESS;
}
