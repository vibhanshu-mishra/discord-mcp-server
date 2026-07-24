import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  isReadOnlyMode,
  isReadOnlyTool,
  isToolAllowed,
  assertWriteAllowed,
  ReadOnlyModeError,
} from "../src/readonly.js";
import { getAllDefinitions, handleTool } from "../src/tools/index.js";

/** A representative read-only tool and a representative write tool. */
const READ_TOOL = "discord_list_guilds";
const WRITE_TOOL = "discord_send_message";

/** Write tools spanning the modules the guard must cover. */
const WRITE_TOOLS = [
  "discord_send_message", // messages: send
  "discord_reply_message", // messages: reply
  "discord_edit_message", // messages: edit
  "discord_delete_message", // messages: delete
  "discord_ban_member", // moderation
  "discord_kick_member", // moderation
  "discord_add_role", // roles
  "discord_create_channel", // channels
  "discord_create_webhook", // webhooks
  "discord_create_invite", // invites
  "discord_add_reaction", // reactions
  "discord_send_dm", // bot DMs
  "discord_create_scheduled_event", // scheduled events
];

afterEach(() => {
  delete process.env.DISCORD_READ_ONLY;
});

function exposedNames(): Set<string> {
  return new Set(getAllDefinitions().map((d) => d.name));
}

// 1. Read-only mode defaults to true when the variable is missing.
test("read-only mode defaults to true when DISCORD_READ_ONLY is unset", () => {
  delete process.env.DISCORD_READ_ONLY;
  assert.equal(isReadOnlyMode(), true);
});

// 2. DISCORD_READ_ONLY=true exposes normal reading and listing tools.
test("read-only mode exposes read/list tools", () => {
  process.env.DISCORD_READ_ONLY = "true";
  const names = exposedNames();
  assert.ok(names.has(READ_TOOL), "list-guilds tool must be exposed");
  assert.ok(names.has("discord_read_messages"), "read-messages tool must be exposed");
  // Every exposed tool must actually be read-only.
  for (const def of getAllDefinitions()) {
    assert.ok(isReadOnlyTool(def.annotations), `${def.name} exposed but is not read-only`);
  }
});

// 3 + 4. DISCORD_READ_ONLY=true hides send/reply/edit/delete/moderation/role/
// channel/webhook/invite/reaction and other write tools.
test("read-only mode hides every write tool", () => {
  process.env.DISCORD_READ_ONLY = "true";
  const names = exposedNames();
  for (const tool of WRITE_TOOLS) {
    assert.ok(!names.has(tool), `${tool} must be hidden in read-only mode`);
  }
});

// 5. A write operation is rejected by the runtime guard when invoked directly.
test("runtime guard rejects a write tool invoked directly in read-only mode", async () => {
  process.env.DISCORD_READ_ONLY = "true";
  await assert.rejects(() => handleTool(WRITE_TOOL, {}), ReadOnlyModeError);
  // The reusable guard also throws, independent of the registry.
  assert.throws(() => assertWriteAllowed(WRITE_TOOL), ReadOnlyModeError);
  // A read-only tool is always allowed, even in read-only mode.
  assert.equal(isToolAllowed({ annotations: { readOnlyHint: true } }), true);
});

// 6. DISCORD_READ_ONLY=false preserves the original tool registration behaviour.
test("DISCORD_READ_ONLY=false exposes every tool, including write tools", () => {
  process.env.DISCORD_READ_ONLY = "false";
  const names = exposedNames();
  assert.ok(names.has(READ_TOOL), "read tools still present when writes enabled");
  for (const tool of WRITE_TOOLS) {
    assert.ok(names.has(tool), `${tool} must be exposed when read-only mode is off`);
  }
  // The guard does not block writes when read-only mode is off.
  assert.doesNotThrow(() => assertWriteAllowed(WRITE_TOOL));
});

// 7. Invalid values safely fall back to read-only mode.
test("invalid DISCORD_READ_ONLY values fall back to read-only", () => {
  for (const value of ["banana", "", "  ", "truee", "1a", "enabled"]) {
    process.env.DISCORD_READ_ONLY = value;
    assert.equal(isReadOnlyMode(), true, `value ${JSON.stringify(value)} must stay read-only`);
    assert.ok(!exposedNames().has(WRITE_TOOL), `writes hidden for value ${JSON.stringify(value)}`);
  }
});

// Recognised "off" values all disable read-only mode.
test("recognised off-values disable read-only mode", () => {
  for (const value of ["false", "0", "no", "off", "OFF", "False"]) {
    process.env.DISCORD_READ_ONLY = value;
    assert.equal(isReadOnlyMode(), false, `value ${JSON.stringify(value)} must disable read-only`);
  }
});
