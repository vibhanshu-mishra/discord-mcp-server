/**
 * `doctor` — diagnoses configuration and local readiness WITHOUT connecting to
 * Discord by default. An explicit `--online` flag is required before any Discord
 * connection is attempted, and even then only read operations are performed
 * (auth, visibility, history read) — never a write. The Discord token is never
 * printed: only "configured" or "missing".
 */
import { existsSync, accessSync, constants as FS } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { arch, platform, version as nodeVersion } from "node:process";
import { EXIT, type ExitCode } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import { inspectDatabase } from "../../operations/databaseHealth.js";
import { readLock, isStale } from "../../operations/processLock.js";
import { validateAnalyticsConfig, DEFAULT_DB_PATH } from "../../analytics/config.js";
import { validateReportingConfig } from "../../analytics/reporting/config.js";
import { validateQualitativeConfig } from "../../analytics/qualitative/config.js";
import { isReadOnlyMode } from "../../readonly.js";

export type CheckStatus = "PASS" | "WARNING" | "FAIL" | "SKIPPED";
export interface Check {
  category: string;
  name: string;
  status: CheckStatus;
  detail: string;
}

const SNOWFLAKE = /^\d{17,20}$/;

function gitIgnored(path: string): boolean | null {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
    return true;
  } catch (err) {
    // exit 1 = not ignored; other = git unavailable / not a repo.
    const code = (err as { status?: number }).status;
    return code === 1 ? false : null;
  }
}

function gitTracked(path: string): boolean | null {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", path], { stdio: "ignore" });
    return true;
  } catch (err) {
    const code = (err as { status?: number }).status;
    return code === 1 ? false : null;
  }
}

function dirWritable(dir: string): "writable" | "creatable" | "blocked" {
  if (existsSync(dir)) {
    try {
      accessSync(dir, FS.W_OK);
      return "writable";
    } catch {
      return "blocked";
    }
  }
  const parent = dirname(dir) || ".";
  try {
    accessSync(existsSync(parent) ? parent : ".", FS.W_OK);
    return "creatable";
  } catch {
    return "blocked";
  }
}

/** Collects all OFFLINE diagnostic checks. Never connects to Discord. */
export function collectDoctorChecks(): Check[] {
  const checks: Check[] = [];
  const add = (category: string, name: string, status: CheckStatus, detail: string) =>
    checks.push({ category, name, status, detail });

  // ── Runtime ──
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  add("runtime", "node-version", major >= 22 ? "PASS" : "FAIL", `${nodeVersion} (require >= 22)`);
  add("runtime", "platform", "PASS", `${platform} ${arch}`);
  add(
    "runtime",
    "build",
    existsSync("dist/index.js") ? "PASS" : "WARNING",
    existsSync("dist/index.js") ? "dist present" : "run `npm run build` first",
  );
  let sqliteOk = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:sqlite");
  } catch {
    sqliteOk = false;
  }
  add(
    "runtime",
    "node:sqlite",
    sqliteOk ? "PASS" : "FAIL",
    sqliteOk ? "available" : "missing (need Node with node:sqlite)",
  );

  // ── Configuration ──
  const { config: analytics, errors: analyticsErrors } = validateAnalyticsConfig();
  const { config: reporting, errors: reportingErrors } = validateReportingConfig();
  const { config: qualitative, errors: qualErrors } = validateQualitativeConfig();
  const ops = getOperationsConfig();

  add(
    "config",
    "env-file",
    existsSync(".env") ? "PASS" : "WARNING",
    existsSync(".env") ? "found" : "no .env (run `init-config`)",
  );
  const hasToken = (process.env.DISCORD_TOKEN?.trim().length ?? 0) > 0;
  add(
    "config",
    "discord-token",
    hasToken ? "PASS" : "WARNING",
    hasToken ? "configured" : "missing",
  );
  add(
    "config",
    "read-only-mode",
    isReadOnlyMode() ? "PASS" : "WARNING",
    isReadOnlyMode() ? "enabled (safe default)" : "DISABLED — Discord write tools are exposed",
  );
  add("config", "analytics-enabled", "PASS", analytics.enabled ? "enabled" : "disabled");
  add("config", "content-storage", "PASS", analytics.storeMessageContent ? "enabled" : "disabled");
  add(
    "config",
    "content-output",
    qualitative.allowContentOutput ? "WARNING" : "PASS",
    qualitative.allowContentOutput
      ? "ENABLED — excerpts may be returned through MCP"
      : "disabled (safe default)",
  );
  const msgIntent = !/^(false|0|no|off)$/i.test((process.env.DISCORD_MESSAGE_CONTENT ?? "").trim());
  add("config", "message-content-intent", "PASS", msgIntent ? "requested" : "not requested");

  const allowedRaw = (process.env.DISCORD_ALLOWED_GUILDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const badAllowed = allowedRaw.filter((g) => !SNOWFLAKE.test(g));
  add(
    "config",
    "allowed-guilds",
    badAllowed.length ? "FAIL" : "PASS",
    badAllowed.length
      ? `${badAllowed.length} invalid guild ID(s)`
      : allowedRaw.length
        ? `${allowedRaw.length} configured`
        : "none (all guilds allowed)",
  );
  add(
    "config",
    "analytics-guild-intersection",
    analytics.enabled && analytics.guildIds.length === 0 ? "WARNING" : "PASS",
    `${analytics.guildIds.length} guild(s) authorised by BOTH lists`,
  );
  add(
    "config",
    "database-path",
    analytics.dbPath ? "PASS" : "FAIL",
    analytics.dbPath === DEFAULT_DB_PATH ? "default" : "custom path configured",
  );
  const idErrors = [...reportingErrors, ...qualErrors].filter((e) => /snowflake|invalid/i.test(e));
  add(
    "config",
    "configured-ids",
    idErrors.length ? "WARNING" : "PASS",
    idErrors.length ? `${idErrors.length} invalid ID(s) ignored` : "valid",
  );
  const tzError = reportingErrors.find((e) => /IANA|time zone/i.test(e));
  add(
    "config",
    "timezone",
    tzError ? "WARNING" : "PASS",
    tzError ? "invalid; using UTC" : reporting.timezone,
  );

  // Unsafe combinations.
  const unsafe: string[] = [];
  if (!isReadOnlyMode()) unsafe.push("Discord writes enabled");
  if (qualitative.allowContentOutput && analytics.storeMessageContent)
    unsafe.push("content stored AND output enabled");
  if (analytics.collectBotDms) unsafe.push("bot DMs collection enabled");
  add(
    "config",
    "unsafe-combinations",
    unsafe.length ? "WARNING" : "PASS",
    unsafe.length ? unsafe.join("; ") : "none detected",
  );
  if (analyticsErrors.length)
    add("config", "analytics-config", "WARNING", `${analyticsErrors.length} config note(s)`);

  // ── Filesystem ──
  const dbDir = dirname(analytics.dbPath) || ".";
  for (const [name, dir] of [
    ["database-dir", dbDir],
    ["export-dir", ops.exportDir],
    ["backup-dir", ops.backupDir],
  ] as const) {
    const state = dirWritable(dir);
    add("filesystem", name, state === "blocked" ? "FAIL" : "PASS", state);
  }
  const gitIgnDb = gitIgnored(DEFAULT_DB_PATH);
  add(
    "filesystem",
    "db-git-ignored",
    gitIgnDb === null ? "SKIPPED" : gitIgnDb ? "PASS" : "FAIL",
    gitIgnDb === null ? "git unavailable" : gitIgnDb ? "ignored" : "NOT ignored",
  );
  const gitIgnExport = gitIgnored(`${ops.exportDir}/x`);
  add(
    "filesystem",
    "export-git-ignored",
    gitIgnExport === null ? "SKIPPED" : gitIgnExport ? "PASS" : "WARNING",
    gitIgnExport === null ? "git unavailable" : gitIgnExport ? "ignored" : "NOT ignored",
  );
  const envTracked = gitTracked(".env");
  add(
    "filesystem",
    "env-not-tracked",
    envTracked === null ? "SKIPPED" : envTracked ? "FAIL" : "PASS",
    envTracked === null
      ? "git unavailable"
      : envTracked
        ? "TRACKED (remove from git!)"
        : "not tracked",
  );
  const dbTracked = gitTracked(analytics.dbPath);
  add(
    "filesystem",
    "db-not-tracked",
    dbTracked === null ? "SKIPPED" : dbTracked ? "FAIL" : "PASS",
    dbTracked === null
      ? "git unavailable"
      : dbTracked
        ? "TRACKED (remove from git!)"
        : "not tracked",
  );

  // ── Database (only when it exists) ──
  if (existsSync(analytics.dbPath)) {
    try {
      const health = inspectDatabase(analytics.dbPath);
      add("database", "integrity", health.integrityOk ? "PASS" : "FAIL", health.integrityDetail);
      add(
        "database",
        "schema-version",
        health.unsupportedFutureVersion ? "FAIL" : "PASS",
        `v${health.schemaVersion} (latest known v${health.latestKnownVersion})`,
      );
      add(
        "database",
        "migrations",
        health.migrationsCurrent || health.unsupportedFutureVersion ? "PASS" : "WARNING",
        health.migrationsCurrent
          ? "current"
          : "behind — run the server or a write command to migrate",
      );
      add(
        "database",
        "required-tables",
        health.missingTables.length ? "FAIL" : "PASS",
        health.missingTables.length ? `missing: ${health.missingTables.join(", ")}` : "present",
      );
      add(
        "database",
        "required-indexes",
        health.missingIndexes.length ? "WARNING" : "PASS",
        health.missingIndexes.length ? `missing: ${health.missingIndexes.join(", ")}` : "present",
      );
      add(
        "database",
        "open-voice-sessions",
        health.openVoiceSessions > 0 ? "WARNING" : "PASS",
        `${health.openVoiceSessions} open session(s)`,
      );
    } catch (err) {
      add("database", "open", "FAIL", err instanceof Error ? err.message : String(err));
    }
  } else {
    add("database", "exists", "SKIPPED", "no database yet (run a sync to create it)");
  }

  // ── Lock ──
  const lock = readLock(ops.lockPath);
  if (!lock) add("lock", "process-lock", "PASS", "no active lock");
  else if (isStale(lock))
    add(
      "lock",
      "process-lock",
      "WARNING",
      `stale lock present (pid ${lock.pid}); recover with db-check --clear-stale-lock`,
    );
  else add("lock", "process-lock", "PASS", `held by ${lock.kind} (pid ${lock.pid})`);

  return checks;
}

/** Aggregates a check list into a summary and an exit code. */
export function summarise(checks: Check[]): {
  counts: Record<CheckStatus, number>;
  exit: ExitCode;
} {
  const counts: Record<CheckStatus, number> = { PASS: 0, WARNING: 0, FAIL: 0, SKIPPED: 0 };
  for (const c of checks) counts[c.status]++;
  const dbFail = checks.some((c) => c.category === "database" && c.status === "FAIL");
  const anyFail = counts.FAIL > 0;
  const exit: ExitCode = dbFail ? EXIT.DATABASE : anyFail ? EXIT.CONFIG : EXIT.SUCCESS;
  return { counts, exit };
}

export async function run(args: Args): Promise<number> {
  const checks = collectDoctorChecks();

  if (args.bool("online")) {
    checks.push(...(await runOnlineChecks()));
  }

  const { counts, exit } = summarise(checks);
  if (args.bool("json")) {
    printJson({ checks, summary: counts, online: args.bool("online") });
  } else {
    let lastCat = "";
    for (const c of checks) {
      if (c.category !== lastCat) {
        printLine(`\n[${c.category}]`);
        lastCat = c.category;
      }
      printLine(`  ${c.status.padEnd(8)} ${c.name} — ${c.detail}`);
    }
    printLine(
      `\nSummary: ${counts.PASS} pass, ${counts.WARNING} warning, ${counts.FAIL} fail, ${counts.SKIPPED} skipped`,
    );
  }
  return exit;
}

/**
 * ONLINE checks (only invoked with `--online`). Connects using the shared client
 * and performs READ operations only. Imported lazily so the offline path never
 * touches the Discord client.
 */
async function runOnlineChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    checks.push({ category: "online", name, status, detail });
  const { config: analytics } = validateAnalyticsConfig();
  try {
    const { discord, ensureConnected } = await import("../../client.js");
    await ensureConnected();
    add("authentication", "PASS", `connected as ${discord.user?.tag ?? "bot"}`);
    for (const guildId of analytics.guildIds) {
      const guild = await discord.guilds.fetch(guildId).catch(() => null);
      add(
        "guild-visibility",
        guild ? "PASS" : "FAIL",
        guild ? `visible: ${guild.name}` : `guild ${guildId} not visible`,
      );
    }
    if (analytics.guildIds.length === 0)
      add("guild-visibility", "SKIPPED", "no analytics guilds configured");
  } catch (err) {
    add("authentication", "FAIL", err instanceof Error ? err.message : String(err));
  }
  return checks;
}
