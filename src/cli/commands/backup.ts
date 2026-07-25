/**
 * `backup` — creates a consistent, verified SQLite backup with a secret-free
 * manifest. It reads the source (a consistent WAL snapshot) and never writes to
 * it, so it does not take the exclusive writer lock. Never contacts Discord.
 */
import { EXIT, type ExitCode } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import { createBackup } from "../../operations/backup.js";

export async function run(args: Args): Promise<number> {
  const ops = getOperationsConfig();
  const outputDir = args.get("output-dir") ?? ops.backupDir;
  const dryRun = args.bool("dry-run");
  const json = args.bool("json");

  const result = createBackup(ops.dbPath, outputDir, { dryRun });

  if (json) {
    printJson({
      dryRun: result.dryRun,
      backupFile: result.backupPath,
      manifestFile: result.manifestPath,
      manifest: result.manifest,
    });
  } else if (result.dryRun) {
    printLine(`[dry-run] would write backup ${result.backupPath} (+ manifest); no files written.`);
  } else {
    printLine(`Backup created: ${result.backupPath}`);
    printLine(`  size:   ${result.manifest?.backupSizeBytes} bytes`);
    printLine(`  schema: v${result.manifest?.schemaVersion}`);
    printLine(`  manifest: ${result.manifestPath}`);
  }
  return EXIT.SUCCESS as ExitCode;
}
