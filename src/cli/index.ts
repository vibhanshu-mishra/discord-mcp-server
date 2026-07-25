#!/usr/bin/env node
/**
 * Generic CLI entry point: `node dist/cli/index.js <command> [options]`.
 *
 * Loads `.env` (via dotenv) but does NOT construct the Discord client — commands
 * that need Discord import it lazily, so offline commands never open a connection.
 * Every command returns a documented exit code; errors are sanitised (no token,
 * no message content) before printing.
 */
import "dotenv/config";
import { EXIT, CliError } from "./exitCodes.js";
import { parseArgs, printLine } from "./output.js";
import { redact } from "../operations/logger.js";

type Command = (args: import("./output.js").Args) => Promise<number>;

const COMMANDS: Record<string, { load: () => Promise<{ run: Command }>; summary: string }> = {
  doctor: {
    load: () => import("./commands/doctor.js"),
    summary: "Diagnose configuration and local readiness (offline; --online to check Discord).",
  },
  "init-config": {
    load: () => import("./commands/initConfig.js"),
    summary: "Create a safe first-run .env scaffold (never overwrites without --force).",
  },
  "db-check": {
    load: () => import("./commands/databaseCheck.js"),
    summary: "Read-only database health report (--json, --clear-stale-lock).",
  },
  sync: {
    load: () => import("./commands/sync.js"),
    summary: "Import Discord history into the local database (--guild-id, --start-date).",
  },
  backup: {
    load: () => import("./commands/backup.js"),
    summary: "Create a verified, consistent database backup (--output-dir, --dry-run).",
  },
  export: {
    load: () => import("./commands/export.js"),
    summary: "Export a privacy-safe report (--report, --guild-id, --start-date, --format).",
  },
  prune: {
    load: () => import("./commands/prune.js"),
    summary: "Delete old records (dry-run by default; --confirm to delete, --before DATE).",
  },
};

function printHelp(): void {
  printLine("Discord MCP Server — operations CLI\n");
  printLine("Usage: node dist/cli/index.js <command> [options]\n");
  printLine("Commands:");
  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    printLine(`  ${name.padEnd(14)} ${summary}`);
  }
  printLine("\nGlobal options: --json (machine-readable where supported), --help");
  printLine(
    "\nExit codes: 0 success, 1 failure, 2 invalid argument, 3 config, 4 database, 5 discord, 6 lock, 7 partial",
  );
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return command && command !== "help" && command !== "--help" && command !== "-h"
      ? EXIT.INVALID_ARG
      : EXIT.SUCCESS;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    printLine(`Unknown command: ${command}`);
    printLine("Run `node dist/cli/index.js --help` for usage.");
    return EXIT.INVALID_ARG;
  }

  const args = parseArgs(rest);
  if (args.bool("help")) {
    printLine(`${command}: ${entry.summary}`);
    return EXIT.SUCCESS;
  }

  try {
    const mod = await entry.load();
    return await mod.run(args);
  } catch (err) {
    if (err instanceof CliError) {
      printLine(`Error: ${redact(err.message)}`);
      return err.code;
    }
    printLine(`Error: ${redact(err instanceof Error ? err.message : String(err))}`);
    return EXIT.FAILURE;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Last-resort guard: never leak a stack with paths/config.
    process.stderr.write(`Fatal: ${redact(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(EXIT.FAILURE);
  });
