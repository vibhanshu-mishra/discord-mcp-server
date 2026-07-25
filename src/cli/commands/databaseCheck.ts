/**
 * `db-check` — a read-only database health report (integrity, schema/migrations,
 * table counts, open voice sessions, latest sync, message time range, stored-
 * content indicator, file size). It never modifies data and never returns message
 * content. `--clear-stale-lock` performs the explicit stale-lock recovery.
 */
import { EXIT } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import { inspectDatabase } from "../../operations/databaseHealth.js";
import { clearStaleLock, readLock, isStale } from "../../operations/processLock.js";

export async function run(args: Args): Promise<number> {
  const ops = getOperationsConfig();
  const json = args.bool("json");

  if (args.bool("clear-stale-lock")) {
    const result = clearStaleLock(ops.lockPath, args.bool("force"));
    if (json)
      printJson({
        action: "clear-stale-lock",
        ...result,
        info: result.info
          ? { pid: result.info.pid, kind: result.info.kind, hostname: result.info.hostname }
          : null,
      });
    else
      printLine(
        result.cleared ? `Lock cleared: ${result.reason}.` : `Not cleared: ${result.reason}.`,
      );
    return result.cleared ? EXIT.SUCCESS : EXIT.LOCK;
  }

  const health = inspectDatabase(ops.dbPath);
  const lock = readLock(ops.lockPath);
  const lockState = !lock ? "none" : isStale(lock) ? "stale" : "live";

  if (json) {
    printJson({ ...health, lock: lockState });
  } else {
    printLine(`Database: ${health.exists ? "present" : "not found"}`);
    if (health.exists) {
      printLine(
        `  integrity:        ${health.integrityOk ? "ok" : `FAILED (${health.integrityDetail})`}`,
      );
      printLine(
        `  schema version:   v${health.schemaVersion} (latest known v${health.latestKnownVersion})${health.unsupportedFutureVersion ? " — UNSUPPORTED FUTURE VERSION" : ""}`,
      );
      printLine(`  migrations:       ${health.migrationsCurrent ? "current" : "behind"}`);
      printLine(`  file size:        ${health.fileSizeBytes ?? "n/a"} bytes`);
      printLine(`  content stored:   ${health.contentStored}`);
      printLine(`  open voice:       ${health.openVoiceSessions}`);
      printLine(
        `  latest sync:      ${health.latestSync ? `${health.latestSync.status} @ ${health.latestSync.completedAt ?? "n/a"}` : "none"}`,
      );
      printLine(
        `  messages:         ${health.tableCounts.messages ?? 0} (oldest ${health.oldestMessageAt ?? "n/a"}, newest ${health.newestMessageAt ?? "n/a"})`,
      );
      printLine(
        `  tables:           ${Object.entries(health.tableCounts)
          .map(([t, c]) => `${t}=${c}`)
          .join(", ")}`,
      );
      if (health.missingTables.length)
        printLine(`  MISSING tables:   ${health.missingTables.join(", ")}`);
      if (health.missingIndexes.length)
        printLine(`  MISSING indexes:  ${health.missingIndexes.join(", ")}`);
    }
    printLine(`  lock:             ${lockState}`);
  }

  if (!health.exists) return EXIT.DATABASE;
  if (!health.integrityOk || health.unsupportedFutureVersion || health.missingTables.length)
    return EXIT.DATABASE;
  return EXIT.SUCCESS;
}
