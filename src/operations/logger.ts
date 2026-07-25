/**
 * Central operational logger. Concise `info` output by default; level controlled
 * by `DISCORD_MCP_LOG_LEVEL`. Every message passes through a redaction step that
 * removes the Discord token, collapses the home directory to `~`, and strips URL
 * query strings — so tokens, absolute private paths, and signed URLs never land
 * in logs. Message content is never passed to the logger by design.
 *
 * All output goes to stderr, keeping stdout clean for machine-readable results.
 */
import { homedir } from "node:os";

export type LogLevel = "error" | "warning" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 };

function configuredLevel(): LogLevel {
  const raw = process.env.DISCORD_MCP_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "error" || raw === "warning" || raw === "info" || raw === "debug") return raw;
  return "info";
}

/** Removes the Discord token, home directory, and URL query strings from text. */
export function redact(text: string): string {
  let out = text;
  const token = process.env.DISCORD_TOKEN?.trim();
  if (token && token.length >= 8) out = out.split(token).join("***");
  const home = homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  // Strip query strings / fragments from any URL to avoid signed tokens.
  out = out.replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1");
  return out;
}

export interface Logger {
  error(msg: string): void;
  warning(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
}

/**
 * Creates a logger. `json` mode emits one JSON object per line; otherwise a
 * concise `LEVEL message` line. `sink` is injectable for tests.
 */
export function createLogger(opts: { json?: boolean; sink?: (line: string) => void } = {}): Logger {
  const level = configuredLevel();
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line + "\n"));
  const emit = (lvl: LogLevel, msg: string) => {
    if (ORDER[lvl] > ORDER[level]) return;
    const safe = redact(msg);
    sink(
      opts.json ? JSON.stringify({ level: lvl, message: safe }) : `${lvl.toUpperCase()} ${safe}`,
    );
  };
  return {
    error: (m) => emit("error", m),
    warning: (m) => emit("warning", m),
    info: (m) => emit("info", m),
    debug: (m) => emit("debug", m),
  };
}
