/**
 * Shared runtime hook for the capabilities diagnostic. Keeping this separate
 * from module registration avoids an import cycle between discovery and index.
 */
export interface CapabilitySummary {
  readOnlyMode: boolean;
  totalLoadedTools: number;
  discordReadTools: number;
  discordWriteTools: number;
  destructiveTools: number;
  loadedToolsets: string[];
  guildAllowListConfigured: boolean;
  analyticsEnabled: boolean;
}

let provider: (() => CapabilitySummary) | undefined;

/** Registers the registry-owned source of truth once tool loading is complete. */
export function setCapabilityProvider(next: () => CapabilitySummary): void {
  provider = next;
}

/** Returns the current secret-free tool capability summary. */
export function getCapabilities(): CapabilitySummary {
  if (!provider)
    throw new Error("Capabilities are unavailable before the tool registry is initialized.");
  return provider();
}
