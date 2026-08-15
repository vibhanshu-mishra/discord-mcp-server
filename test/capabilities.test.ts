import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { handleTool } from "../src/tools/index.js";

afterEach(() => {
  delete process.env.DISCORD_READ_ONLY;
  delete process.env.DISCORD_ALLOWED_GUILDS;
  delete process.env.DISCORD_ANALYTICS_ENABLED;
});

test("capabilities diagnostic reports loaded write-mode inventory without private configuration", async () => {
  process.env.DISCORD_READ_ONLY = "false";
  process.env.DISCORD_ALLOWED_GUILDS = "111111111111111111";
  process.env.DISCORD_ANALYTICS_ENABLED = "true";
  const result = await handleTool("discord_get_capabilities", {});
  const data = result.structuredContent as Record<string, unknown>;
  assert.equal(data.readOnlyMode, false);
  assert.equal(data.discordWriteTools, 65);
  assert.equal(data.destructiveTools, 18);
  assert.equal(data.guildAllowListConfigured, true);
  assert.equal(data.analyticsEnabled, true);
  assert.ok(Array.isArray(data.loadedToolsets));
  assert.ok((data.loadedToolsets as string[]).includes("analytics"));
  assert.equal(
    JSON.stringify(data).match(/111111111111111111/g),
    null,
    "must not expose guild IDs",
  );
});
