/**
 * Tool registry — aggregates all tool modules and provides a unified interface
 * for listing definitions and routing tool calls to the correct handler.
 *
 * To add a new tool module:
 * 1. Create a new file in this folder (e.g. `onboarding.ts`)
 * 2. Build it with `defineModule([...])` and default-export the result
 * 3. Import and add it to `allToolsets` below (the key is its `DISCORD_MCP_TOOLSETS` name)
 */

import type { ToolModule, ToolDefinition, ToolHandler, ToolResult } from "./types.js";
import {
  isDestructiveTool,
  isReadOnlyMode,
  isToolAllowed,
  mutatesDiscord,
  ReadOnlyModeError,
} from "../readonly.js";
import { allowListActive } from "../client.js";
import { isAnalyticsEnabled } from "../analytics/config.js";
import { setCapabilityProvider, type CapabilitySummary } from "./capabilities.js";

import discovery from "./discovery.js";
import messages from "./messages.js";
import channels from "./channels.js";
import permissions from "./permissions.js";
import members from "./members.js";
import roles from "./roles.js";
import moderation from "./moderation.js";
import screening from "./screening.js";
import stats from "./stats.js";
import forums from "./forums.js";
import webhooks from "./webhooks.js";
import scheduledEvents from "./scheduledEvents.js";
import invites from "./invites.js";
import dm from "./dm.js";
import analytics from "./analytics.js";

/** Every toolset, keyed by the name used in the `DISCORD_MCP_TOOLSETS` env var. */
const allToolsets: Record<string, ToolModule> = {
  discovery,
  messages,
  channels,
  permissions,
  members,
  roles,
  moderation,
  screening,
  stats,
  forums,
  webhooks,
  scheduled_events: scheduledEvents,
  invites,
  dm,
  analytics,
};

/**
 * Selects which toolsets to expose from `DISCORD_MCP_TOOLSETS` (comma-separated,
 * case-insensitive). Unset, empty, or `all` exposes everything; unknown names throw
 * at startup — a typo must not silently expose the full destructive surface.
 */
export function selectModules(): ToolModule[] {
  const raw = process.env.DISCORD_MCP_TOOLSETS?.trim();
  if (!raw) return Object.values(allToolsets);
  const names = [
    ...new Set(
      raw
        .split(",")
        .map((n) => n.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (names.includes("all")) return Object.values(allToolsets);
  const unknown = names.filter((n) => !(n in allToolsets));
  if (unknown.length > 0 || names.length === 0) {
    throw new Error(
      `Invalid DISCORD_MCP_TOOLSETS: unknown toolset(s) ${unknown.map((n) => `"${n}"`).join(", ") || "(none selected)"}. ` +
        `Known: all, ${Object.keys(allToolsets).join(", ")}.`,
    );
  }
  return names.map((n) => allToolsets[n]);
}

const modules: ToolModule[] = selectModules();

/** One O(1) name→handler table merged from every module, built once at load. */
const registry: Map<string, ToolHandler> = (() => {
  const map = new Map<string, ToolHandler>();
  for (const mod of modules) {
    for (const [name, handler] of mod.handlers) {
      if (map.has(name)) throw new Error(`Duplicate tool name across modules: ${name}`);
      map.set(name, handler);
    }
  }
  return map;
})();

/**
 * Every tool definition by name, built once at load. Lets the read-only guard
 * classify any registered tool (via its `readOnlyHint` annotation) at call time,
 * independent of which definitions are currently advertised.
 */
const definitionsByName: Map<string, ToolDefinition> = (() => {
  const map = new Map<string, ToolDefinition>();
  for (const mod of modules) {
    for (const def of mod.definitions) map.set(def.name, def);
  }
  return map;
})();

/** A secret-free summary of the tool surface currently loaded by this server. */
function getCapabilities(): CapabilitySummary {
  const definitions = modules.flatMap((module) => module.definitions);
  return {
    readOnlyMode: isReadOnlyMode(),
    totalLoadedTools: definitions.length,
    discordReadTools: definitions.filter(
      (definition) => definition.annotations?.readOnlyHint === true,
    ).length,
    discordWriteTools: definitions.filter(mutatesDiscord).length,
    destructiveTools: definitions.filter((definition) => isDestructiveTool(definition.annotations))
      .length,
    loadedToolsets: Object.entries(allToolsets)
      .filter(([, toolset]) => modules.includes(toolset))
      .map(([name]) => name),
    guildAllowListConfigured: allowListActive(),
    analyticsEnabled: isAnalyticsEnabled(),
  };
}

setCapabilityProvider(getCapabilities);

/** Strips internal-only fields (`discordWrite`) so they never reach the client. */
function toWireDefinition(def: ToolDefinition): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { discordWrite: _discordWrite, ...wire } = def;
  return wire;
}

/**
 * Returns the tool definitions to advertise on the current tools/list request.
 * While read-only mode is enabled every Discord-mutating tool is hidden — it
 * stays in the source code and registry, it is simply not offered to the client.
 * Local-only analytics writers stay visible because they do not mutate Discord.
 * Read fresh each call so a config change is reflected without a restart.
 */
export function getAllDefinitions(): ToolDefinition[] {
  return modules
    .flatMap((m) => m.definitions)
    .filter((def) => isToolAllowed(def))
    .map(toWireDefinition);
}

/** True if a tool with this name is registered (regardless of read-only mode). */
export function hasTool(name: string): boolean {
  return registry.has(name);
}

/** True when a tool needs a Discord API connection before its handler can run. */
export function requiresDiscordConnection(name: string): boolean {
  return definitionsByName.get(name)?.annotations?.openWorldHint === true;
}

/**
 * Routes a tool call to its handler via the merged registry. Read-only mode is
 * enforced here as a second layer of protection: even if a Discord-write tool
 * were advertised or invoked by name, it is blocked before it can touch Discord.
 * Local-only analytics writers are not Discord writes, so they are allowed.
 * @throws {Error} If no tool owns the given name.
 * @throws {ReadOnlyModeError} If the tool mutates Discord and read-only mode is on.
 */
export async function handleTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const handler = registry.get(name);
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  const def = definitionsByName.get(name);
  if (isReadOnlyMode() && def && mutatesDiscord(def)) {
    throw new ReadOnlyModeError(name);
  }
  return handler(args);
}
