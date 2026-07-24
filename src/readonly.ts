/**
 * Centralised read-only mode — the single source of truth for whether Discord
 * write operations are allowed, and for classifying a tool as read-only,
 * write-capable, or destructive.
 *
 * Read-only mode is controlled by the `DISCORD_READ_ONLY` environment variable
 * and defaults to ON (read-only) whenever the value is missing or unrecognised.
 * This is a fail-safe default: a typo or an empty value keeps the server safe.
 *
 * Tool classification reuses the MCP annotations every tool already declares
 * (`readOnlyHint` / `destructiveHint` in {@link ToolAnnotations}) rather than
 * guessing from names, so there is one authoritative place that decides which
 * tools may run while read-only mode is enabled.
 */
import type { ToolAnnotations, ToolDefinition } from "./tools/types.js";

/** Values (case-insensitive) that turn read-only mode OFF. Anything else stays ON. */
const OFF_PATTERN = /^(false|0|no|off)$/i;

/**
 * True when the server is in read-only mode. Read fresh from the environment on
 * every call so tests (and a live config reload) observe changes immediately.
 *
 * Defaults to `true` when `DISCORD_READ_ONLY` is missing. Only the explicit
 * off-values (`false`, `0`, `no`, `off`) disable it; every other value —
 * including typos and empty strings — safely falls back to read-only.
 */
export function isReadOnlyMode(): boolean {
  const raw = process.env.DISCORD_READ_ONLY;
  if (raw === undefined) return true;
  return !OFF_PATTERN.test(raw.trim());
}

/**
 * True only when a tool is explicitly marked read-only via its `readOnlyHint`
 * annotation. Fail-closed: a tool that omits the hint is treated as
 * write-capable, so a newly added tool without metadata is blocked, not exposed.
 */
export function isReadOnlyTool(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true;
}

/** True when a tool performs irreversible changes (ban, kick, prune, delete…). */
export function isDestructiveTool(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.destructiveHint === true;
}

/**
 * Should this tool be exposed and allowed right now? A read-only tool is always
 * allowed; a write-capable tool is allowed only when read-only mode is off.
 */
export function isToolAllowed(def: Pick<ToolDefinition, "annotations">): boolean {
  return isReadOnlyTool(def.annotations) || !isReadOnlyMode();
}

/**
 * Thrown by {@link assertWriteAllowed} when a write operation is attempted while
 * read-only mode is enabled. Carries the offending tool name for clear errors.
 */
export class ReadOnlyModeError extends Error {
  constructor(public readonly toolName: string) {
    super(
      `Blocked: "${toolName}" is a write operation, but the server is in read-only mode ` +
        `(DISCORD_READ_ONLY is enabled). No changes were made to Discord. ` +
        `To allow write tools, restart the server with DISCORD_READ_ONLY=false.`,
    );
    this.name = "ReadOnlyModeError";
  }
}

/**
 * Reusable runtime guard for write-capable tools: throws {@link ReadOnlyModeError}
 * when read-only mode is enabled. Call this at the top of any write handler, or
 * rely on the central check in `handleTool`, which invokes it for every call.
 */
export function assertWriteAllowed(toolName: string): void {
  if (isReadOnlyMode()) throw new ReadOnlyModeError(toolName);
}
