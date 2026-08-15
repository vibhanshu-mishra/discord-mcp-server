import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
// The bundle runs the compiled dist/index.js; this test exercises the SAME entry
// module from source via tsx (network-free, no Discord connection is made).
const ENTRY = resolve(ROOT, "src/index.ts");

interface Rpc {
  id?: number;
  result?: {
    tools?: { name: string }[];
    serverInfo?: unknown;
    capabilities?: unknown;
    structuredContent?: Record<string, unknown>;
  };
}

/** Starts the stdio server, sends initialize + tools/list, returns parsed replies. */
function startAndQuery(readOnly = false): Promise<{
  init?: Rpc;
  tools?: Rpc;
  capabilities?: Rpc;
  stderr: string;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), "mcpb-rt-"));
  const env = {
    ...process.env,
    DISCORD_TOKEN: "FAKE.TOKEN.NOT.REAL.1234567890",
    DISCORD_READ_ONLY: String(readOnly),
    DISCORD_ANALYTICS_ENABLED: "true",
    DISCORD_MCP_TOOLSETS: "",
    DISCORD_ALLOWED_GUILDS: "111111111111111111",
    DISCORD_ANALYTICS_GUILD_IDS: "111111111111111111",
    DISCORD_ANALYTICS_DB_PATH: join(dataDir, "discord-analytics.sqlite"),
    DISCORD_ANALYTICS_LOCK_PATH: join(dataDir, "discord-analytics.lock"),
    DISCORD_ANALYTICS_BACKUP_DIR: join(dataDir, "backups"),
    DISCORD_ANALYTICS_EXPORT_DIR: join(dataDir, "exports"),
  };
  return new Promise((resolvePromise) => {
    const child = spawn("node", ["--import", "tsx", ENTRY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "discord_get_capabilities", arguments: {} },
    });
    setTimeout(() => {
      child.kill("SIGTERM");
      const msgs = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l) as Rpc;
          } catch {
            return null;
          }
        })
        .filter((m): m is Rpc => m !== null);
      rmSync(dataDir, { recursive: true, force: true });
      resolvePromise({
        init: msgs.find((m) => m.id === 1),
        tools: msgs.find((m) => m.id === 2),
        capabilities: msgs.find((m) => m.id === 3),
        stderr,
      });
    }, 5000);
  });
}

// 41/42/43/45. Standard bundle runtime starts in write mode and lists all tools.
test("standard bundle runtime starts over stdio with every Discord write tool", async () => {
  const { init, tools, capabilities } = await startAndQuery();
  assert.ok(init?.result, "initialize responded"); // 41/42
  const names = tools?.result?.tools?.map((t) => t.name) ?? [];
  assert.ok(names.length > 0, "tools/list returned tools"); // 43
  assert.ok(names.includes("discord_analytics_status"), "analytics tools available"); // 45
  assert.ok(names.includes("discord_get_topic_candidates"), "qualitative tools available"); // 50 (gates enforced inside)
  assert.ok(names.includes("discord_get_capabilities"), "capabilities diagnostic available");
  assert.equal(names.filter((name) => name.startsWith("discord_")).length, 117);
  for (const writeTool of [
    "discord_send_message",
    "discord_create_forum_post",
    "discord_create_scheduled_event",
    "discord_create_channel",
    "discord_create_role",
    "discord_ban_member",
    "discord_create_webhook",
    "discord_create_invite",
    "discord_send_dm",
  ]) {
    assert.ok(names.includes(writeTool), `${writeTool} must be available in the standard bundle`);
  }
  const summary = capabilities?.result?.structuredContent;
  assert.ok(summary, "capabilities diagnostic returned structured data");
  assert.equal(summary.discordWriteTools, 65);
  assert.equal(summary.totalLoadedTools, 117);
  assert.deepEqual(summary.loadedToolsets, [
    "discovery",
    "messages",
    "channels",
    "permissions",
    "members",
    "roles",
    "moderation",
    "screening",
    "stats",
    "forums",
    "webhooks",
    "scheduled_events",
    "invites",
    "dm",
    "analytics",
  ]);
});

// 44. Discord write tools remain unavailable in read-only mode.
test("Discord write tools are unavailable in read-only mode", async () => {
  const { tools } = await startAndQuery(true);
  const names = tools?.result?.tools?.map((t) => t.name) ?? [];
  for (const w of [
    "discord_send_message",
    "discord_delete_message",
    "discord_ban_member",
    "discord_add_reaction",
  ]) {
    assert.ok(!names.includes(w), `${w} must be hidden in read-only mode`);
  }
});

test("Discord write tools are available when the bundle runtime enables writes", async () => {
  const { init, tools } = await startAndQuery(false);
  assert.ok(init?.result, "initialize responded");
  const names = tools?.result?.tools?.map((tool) => tool.name) ?? [];
  for (const writeTool of [
    "discord_send_message",
    "discord_edit_message",
    "discord_add_reaction",
    "discord_ban_member",
    "discord_create_webhook",
  ]) {
    assert.ok(names.includes(writeTool), `${writeTool} must be available in write mode`);
  }
});
