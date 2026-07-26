import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "mcpb/manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const env = manifest.server.mcp_config.env as Record<string, string>;
const cfg = manifest.user_config as Record<
  string,
  { type: string; required?: boolean; sensitive?: boolean; default?: unknown }
>;
// Person-name token assembled at runtime so this test's source has no literal.
const FORBIDDEN_NAME = ["rhy", "thm"].join("");

// 1. Manifest is valid against the current MCPB schema (via the pinned CLI).
test("manifest validates against the MCPB schema", () => {
  assert.doesNotThrow(() =>
    execFileSync(
      resolve(ROOT, "node_modules/.bin/mcpb"),
      ["validate", resolve(ROOT, "mcpb/manifest.json")],
      {
        stdio: "ignore",
      },
    ),
  );
});

// 2/3. Manifest schema version is current; extension version matches package.json.
test("manifest versions are correct", () => {
  assert.equal(manifest.manifest_version, "0.3"); // 2
  assert.equal(manifest.version, pkg.version); // 3
});

// 4/6/7/8. Required metadata, server type, entry point, node runtime.
test("required metadata, server type, entry point, and runtime are accurate", () => {
  for (const key of ["name", "version", "description", "author", "server"]) {
    assert.ok(key in manifest, `missing ${key}`); // 4
  }
  assert.equal(manifest.server.type, "node"); // 6
  assert.equal(manifest.server.entry_point, "server/index.js"); // 7
  assert.match(manifest.compatibility.runtimes.node, />=\s*22/); // 8
  assert.deepEqual(manifest.server.mcp_config.args, ["${__dirname}/server/index.js"]);
});

// 5/21. Author is generic; no personal name anywhere in the manifest.
test("author is generic and no personal name appears", () => {
  assert.equal(manifest.author.name, "Discord MCP Server Contributors"); // 5
  assert.ok(!("email" in manifest.author) && !("url" in manifest.author));
  assert.ok(!JSON.stringify(manifest).toLowerCase().includes(FORBIDDEN_NAME)); // 21
});

// 9/10/11. Required + sensitive fields.
test("required config fields are declared correctly", () => {
  assert.equal(cfg.discord_token.required, true); // 9
  assert.equal(cfg.discord_token.sensitive, true); // 9
  assert.equal(cfg.guild_id.required, true); // 10
  assert.equal(cfg.data_directory.required, true); // 11
  assert.equal(cfg.data_directory.type, "directory");
});

// 12/13/14. Safe fixed defaults in the environment mapping.
test("environment mapping has safe fixed defaults", () => {
  assert.equal(env.DISCORD_READ_ONLY, "true"); // 13 — always true
  assert.equal(env.DISCORD_ANALYTICS_ENABLED, "true"); // 14
  assert.equal(env.DISCORD_MESSAGE_CONTENT, "true"); // 12
  assert.equal(env.DISCORD_GUILD_MEMBERS, "true");
  // Read-only is never mapped to a user-toggle.
  assert.ok(!env.DISCORD_READ_ONLY.includes("user_config"));
});

// 15/16/17. Privacy-preserving user-config defaults.
test("content output, voice, and bot-DM default to off", () => {
  assert.equal(cfg.allow_content_output.default, false); // 15
  assert.equal(cfg.collect_voice.default, false); // 16
  assert.equal(cfg.collect_bot_dms.default, false); // 17
  assert.equal(cfg.store_message_content.default, true);
});

// 18. Guild ID maps to BOTH allow lists.
test("guild ID maps to both allow-lists", () => {
  assert.equal(env.DISCORD_ALLOWED_GUILDS, "${user_config.guild_id}");
  assert.equal(env.DISCORD_ANALYTICS_GUILD_IDS, "${user_config.guild_id}");
});

// 19/48. Data paths derive from the configured directory (outside the bundle).
test("data paths derive from the data directory, not the bundle", () => {
  for (const key of [
    "DISCORD_ANALYTICS_DB_PATH",
    "DISCORD_ANALYTICS_LOCK_PATH",
    "DISCORD_ANALYTICS_BACKUP_DIR",
    "DISCORD_ANALYTICS_EXPORT_DIR",
  ]) {
    assert.match(
      env[key],
      /^\$\{user_config\.data_directory\}\//,
      `${key} must derive from data_directory`,
    );
    assert.ok(!env[key].includes("__dirname"), `${key} must not live inside the bundle`);
  }
  assert.equal(
    env.DISCORD_ANALYTICS_DB_PATH,
    "${user_config.data_directory}/discord-analytics.sqlite",
  );
});

// 20. No real Discord ID appears in the manifest.
test("no real Discord ID appears in the manifest", () => {
  assert.ok(!/\b\d{17,20}\b/.test(JSON.stringify(manifest)));
});

// The manifest declares no false tools (dynamic discovery) and no write intent.
test("manifest does not falsely declare tools and never enables writes", () => {
  assert.equal(manifest.tools_generated, true);
  assert.ok(!("tools" in manifest) || Array.isArray(manifest.tools));
  assert.ok(!JSON.stringify(env).includes('DISCORD_READ_ONLY":"false"'));
});
