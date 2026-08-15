import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { discord } from "../src/client.js";
import messages from "../src/tools/messages.js";
import channels from "../src/tools/channels.js";
import roles from "../src/tools/roles.js";
import webhooks from "../src/tools/webhooks.js";
import invites from "../src/tools/invites.js";
import scheduledEvents from "../src/tools/scheduledEvents.js";
import dm from "../src/tools/dm.js";

const GUILD = "111111111111111111";
const CHANNEL = "222222222222222222";
const MESSAGE = "333333333333333333";
const USER = "444444444444444444";

afterEach(() => mock.restoreAll());

test("message write handlers call Discord for send, reply, edit, and reaction", async () => {
  const calls: string[] = [];
  const target = {
    id: MESSAGE,
    author: { id: undefined },
    reply: async (content: string) => {
      calls.push(`reply:${content}`);
      return { id: "555555555555555555" };
    },
    edit: async (content: string) => {
      calls.push(`edit:${content}`);
      return { id: MESSAGE };
    },
    react: async (emoji: string) => void calls.push(`react:${emoji}`),
  };
  const channel = {
    guildId: GUILD,
    name: "updates",
    isDMBased: () => false,
    isTextBased: () => true,
    send: async (content: string) => {
      calls.push(`send:${content}`);
      return { id: "555555555555555555" };
    },
    messages: { fetch: async () => target },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);

  await messages.handlers.get("discord_send_message")!({ channel_id: CHANNEL, content: "hello" });
  await messages.handlers.get("discord_reply_message")!({
    channel_id: CHANNEL,
    message_id: MESSAGE,
    content: "reply",
  });
  await messages.handlers.get("discord_edit_message")!({
    channel_id: CHANNEL,
    message_id: MESSAGE,
    content: "edited",
  });
  await messages.handlers.get("discord_add_reaction")!({
    channel_id: CHANNEL,
    message_id: MESSAGE,
    emoji: "👍",
  });

  assert.deepEqual(calls, ["send:hello", "reply:reply", "edit:edited", "react:👍"]);
});

test("a Discord permission failure from a message send propagates without success", async () => {
  const channel = {
    guildId: GUILD,
    name: "restricted",
    isDMBased: () => false,
    isTextBased: () => true,
    send: async () => {
      throw new Error("Missing Permissions");
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);

  await assert.rejects(
    () =>
      messages.handlers.get("discord_send_message")!({ channel_id: CHANNEL, content: "blocked" }),
    /Missing Permissions/,
  );
});

test("channel and role creation handlers call their Discord APIs", async () => {
  const channelCreates: unknown[] = [];
  const roleCreates: unknown[] = [];
  mock.method(
    discord.guilds,
    "fetch",
    async () =>
      ({
        channels: {
          create: async (options: unknown) => {
            channelCreates.push(options);
            return { id: CHANNEL, name: "new-channel" };
          },
        },
        roles: {
          create: async (options: unknown) => {
            roleCreates.push(options);
            return { id: "555555555555555555", name: "new-role" };
          },
        },
      }) as never,
  );

  await channels.handlers.get("discord_create_channel")!({ guild_id: GUILD, name: "new-channel" });
  await roles.handlers.get("discord_create_role")!({ guild_id: GUILD, name: "new-role" });

  assert.equal(channelCreates.length, 1);
  assert.equal(roleCreates.length, 1);
});

test("webhook and invite creation handlers call their Discord APIs", async () => {
  const webhookCreates: unknown[] = [];
  const inviteCreates: unknown[] = [];
  const channel = {
    guildId: GUILD,
    createWebhook: async (options: unknown) => {
      webhookCreates.push(options);
      return { id: "555555555555555555", name: "status", token: "test-token" };
    },
    createInvite: async (options: unknown) => {
      inviteCreates.push(options);
      return { url: "https://discord.gg/example", code: "example", maxAge: 60, maxUses: 1 };
    },
  };
  mock.method(discord.channels, "fetch", async () => channel as never);

  await webhooks.handlers.get("discord_create_webhook")!({ channel_id: CHANNEL, name: "status" });
  await invites.handlers.get("discord_create_invite")!({
    channel_id: CHANNEL,
    max_age: 60,
    max_uses: 1,
  });

  assert.equal(webhookCreates.length, 1);
  assert.equal(inviteCreates.length, 1);
});

test("scheduled event and direct-message handlers call their Discord APIs", async () => {
  const eventCreates: unknown[] = [];
  const directMessages: string[] = [];
  mock.method(
    discord.guilds,
    "fetch",
    async () =>
      ({
        scheduledEvents: {
          create: async (options: unknown) => {
            eventCreates.push(options);
            return { id: "555555555555555555", name: "workshop" };
          },
        },
      }) as never,
  );
  mock.method(
    discord.users,
    "fetch",
    async () =>
      ({
        username: "member",
        send: async (content: string) => {
          directMessages.push(content);
          return { id: "555555555555555555" };
        },
      }) as never,
  );

  await scheduledEvents.handlers.get("discord_create_scheduled_event")!({
    guild_id: GUILD,
    name: "workshop",
    entity_type: "EXTERNAL",
    location: "online",
    scheduled_start_time: "2030-01-01T10:00:00Z",
    scheduled_end_time: "2030-01-01T11:00:00Z",
  });
  await dm.handlers.get("discord_send_dm")!({ user_id: USER, content: "hello" });

  assert.equal(eventCreates.length, 1);
  assert.deepEqual(directMessages, ["hello"]);
});
