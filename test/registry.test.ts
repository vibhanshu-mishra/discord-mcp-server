import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModules, hasTool } from "../src/tools/index.js";
import { assertAllowedGuild, isGuildAllowed } from "../src/client.js";
import { isDestructiveTool, mutatesDiscord } from "../src/readonly.js";

test("every Discord mutation has explicit classification, a handler, and accurate destructive metadata", () => {
  delete process.env.DISCORD_MCP_TOOLSETS;
  const modules = selectModules();
  const definitions = modules.flatMap((module) => module.definitions);

  const discordWrites = definitions.filter(mutatesDiscord);
  assert.ok(discordWrites.length > 0, "the registry must include Discord write tools");

  for (const definition of discordWrites) {
    assert.equal(
      definition.discordWrite,
      true,
      `${definition.name} must explicitly declare discordWrite: true`,
    );
    assert.equal(
      definition.annotations?.readOnlyHint,
      false,
      `${definition.name} must advertise its Discord mutation side effect`,
    );
    const owner = modules.find((module) => module.definitions.includes(definition));
    assert.ok(owner, `${definition.name} must be owned by a selected toolset`);
    assert.ok(
      owner.handlers.has(definition.name),
      `${definition.name} must route to a real handler`,
    );
  }

  for (const definition of definitions.filter((item) => isDestructiveTool(item.annotations))) {
    assert.equal(
      definition.discordWrite,
      true,
      `${definition.name} is destructive and must be a Discord write`,
    );
    assert.equal(
      definition.annotations?.destructiveHint,
      true,
      `${definition.name} must retain destructiveHint: true`,
    );
  }
});

test("each write-capable toolset selects its write tools without enabling other toolsets", () => {
  const representatives: Record<string, string> = {
    messages: "discord_send_message",
    channels: "discord_create_channel",
    permissions: "discord_set_role_permission",
    members: "discord_ban_member",
    roles: "discord_create_role",
    screening: "discord_update_membership_screening",
    forums: "discord_create_forum_channel",
    webhooks: "discord_create_webhook",
    scheduled_events: "discord_create_scheduled_event",
    invites: "discord_create_invite",
    dm: "discord_send_dm",
  };
  for (const [toolset, writeTool] of Object.entries(representatives)) {
    process.env.DISCORD_MCP_TOOLSETS = toolset;
    const selected = selectModules();
    assert.equal(selected.length, 1, `${toolset} must select exactly one module`);
    assert.ok(
      selected[0].definitions.some((definition) => definition.name === writeTool),
      `${writeTool} must remain reachable through DISCORD_MCP_TOOLSETS=${toolset}`,
    );
    assert.ok(selected[0].handlers.has(writeTool), `${writeTool} must retain a handler`);
  }
  delete process.env.DISCORD_MCP_TOOLSETS;
});

test("selectModules exposes everything when unset or `all`", () => {
  delete process.env.DISCORD_MCP_TOOLSETS;
  const all = selectModules().length;
  process.env.DISCORD_MCP_TOOLSETS = "all";
  assert.equal(selectModules().length, all);
  delete process.env.DISCORD_MCP_TOOLSETS;
});

test("selectModules picks exactly the listed toolsets, case-insensitive", () => {
  process.env.DISCORD_MCP_TOOLSETS = "Discovery, MESSAGES";
  try {
    const selected = selectModules();
    assert.equal(selected.length, 2);
    const names = selected.flatMap((m) => m.definitions.map((d) => d.name));
    assert.ok(names.includes("discord_list_guilds"), "discovery toolset selected");
    assert.ok(names.includes("discord_read_messages"), "messages toolset selected");
    assert.ok(!names.includes("discord_ban_member"), "destructive member tools must be gated off");
  } finally {
    delete process.env.DISCORD_MCP_TOOLSETS;
  }
});

test("selectModules fails fast on unknown or empty selections", () => {
  for (const value of ["messsages", "discovery messages", ",,"]) {
    process.env.DISCORD_MCP_TOOLSETS = value;
    try {
      assert.throws(() => selectModules(), /Invalid DISCORD_MCP_TOOLSETS/, value);
    } finally {
      delete process.env.DISCORD_MCP_TOOLSETS;
    }
  }
});

function assertStrictObjectSchemas(node: unknown, tool: string, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertStrictObjectSchemas(v, tool, `${path}[${i}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const schema = node as Record<string, unknown>;
  if (schema.type === "object" && schema.properties !== undefined) {
    assert.equal(
      schema.additionalProperties,
      false,
      `${tool} at ${path}: object schema must advertise additionalProperties: false`,
    );
  }
  for (const [key, value] of Object.entries(schema)) {
    assertStrictObjectSchemas(value, tool, `${path}.${key}`);
  }
}

test("every tool's inputSchema forbids unknown keys at every nesting level", () => {
  delete process.env.DISCORD_MCP_TOOLSETS;
  for (const mod of selectModules()) {
    for (const def of mod.definitions) {
      assert.equal(
        (def.inputSchema as Record<string, unknown>).additionalProperties,
        false,
        `${def.name} root must advertise additionalProperties: false`,
      );
      assertStrictObjectSchemas(def.inputSchema, def.name, "inputSchema");
    }
  }
});

test("hasTool reflects the registry", () => {
  assert.ok(hasTool("discord_list_guilds"));
  assert.ok(!hasTool("discord_nonexistent"));
});

test("assertAllowedGuild enforces the allow-list lazily and ignores null", () => {
  process.env.DISCORD_ALLOWED_GUILDS = "111111111111111111";
  try {
    assert.ok(isGuildAllowed("111111111111111111"));
    assert.throws(() => assertAllowedGuild("222222222222222222"), /allow-list/);
    assertAllowedGuild(null);
    assertAllowedGuild(undefined);
  } finally {
    delete process.env.DISCORD_ALLOWED_GUILDS;
  }
  assertAllowedGuild("222222222222222222");
});
