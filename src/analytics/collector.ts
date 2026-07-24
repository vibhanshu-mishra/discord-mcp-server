/**
 * Live analytics collector: subscribes to the shared discord.js client's gateway
 * events and records them locally. It is strictly READ-ONLY toward Discord — it
 * never sends, replies, reacts, acknowledges, or edits anything.
 *
 * Every handler is wrapped so a recoverable error is logged (without message
 * content) and swallowed: analytics must never break the Discord MCP tools.
 * Unauthorised guilds are ignored, and DMs are ignored unless explicitly enabled.
 */
import {
  Events,
  type Client,
  type ClientEvents,
  type Message,
  type PartialMessage,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type VoiceState,
  type ThreadChannel,
} from "discord.js";
import type { AnalyticsConfig } from "./types.js";
import type { AnalyticsRepository, MessageInput } from "./repository.js";
import { handleVoiceStateChange, type VoiceStateLike } from "./voice.js";
import { isAnalyticsGuildAuthorised } from "./config.js";

/** Maps a discord.js message to the repository's content-agnostic input shape. */
function toMessageInput(m: Message | PartialMessage): MessageInput | null {
  if (!m.id || !m.createdAt) return null;
  const channel = m.channel;
  const parentId =
    channel && "parentId" in channel && channel.isThread?.() ? (channel.parentId ?? null) : null;
  const attachmentCount = m.attachments?.size ?? 0;
  const reactionCount = m.reactions
    ? [...m.reactions.cache.values()].reduce((s, r) => s + (r.count ?? 0), 0)
    : 0;
  return {
    message_id: m.id,
    guild_id: m.guildId ?? null,
    channel_id: m.channelId,
    parent_channel_id: parentId,
    author_id: m.author?.id ?? null,
    content: m.content ?? null,
    created_at: m.createdAt.toISOString(),
    edited_at: m.editedAt ? m.editedAt.toISOString() : null,
    referenced_message_id: m.reference?.messageId ?? null,
    is_reply: Boolean(m.reference?.messageId),
    is_pinned: Boolean(m.pinned),
    author_is_bot: m.author?.bot ?? false,
    message_type: m.type ?? null,
    attachment_count: attachmentCount,
    reaction_count: reactionCount,
  };
}

export class LiveCollector {
  private started = false;
  /** Detach callbacks kept so `stop()` removes exactly what `start()` attached. */
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly client: Client,
    private readonly repo: AnalyticsRepository,
    private readonly config: AnalyticsConfig,
  ) {}

  /** Guild authorisation gate reused by every handler. */
  private authorised = (guildId: string | null): guildId is string =>
    guildId !== null && isAnalyticsGuildAuthorised(guildId, this.config);

  /** Wraps a handler so it can never throw into the gateway or break the MCP. */
  private safe<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      try {
        fn(...args);
      } catch (err) {
        // Never log message content — only the event name and error message.
        console.error(
          `[analytics] ${name} handler error:`,
          err instanceof Error ? err.message : err,
        );
      }
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    const add = <K extends keyof ClientEvents>(
      event: K,
      listener: (...args: ClientEvents[K]) => void,
    ): void => {
      this.client.on(event, listener);
      this.disposers.push(() => this.client.off(event, listener));
    };

    add(
      Events.MessageCreate,
      this.safe("MessageCreate", (message) => this.onMessage(message)),
    );
    add(
      Events.MessageUpdate,
      this.safe("MessageUpdate", (_old, updated) => {
        if (updated) this.onMessage(updated as Message);
      }),
    );
    add(
      Events.MessageDelete,
      this.safe("MessageDelete", (message: Message | PartialMessage) => {
        const guildId = message.guildId ?? null;
        if (guildId !== null && !this.authorised(guildId)) return;
        if (guildId === null && !this.config.collectBotDms) return;
        if (message.id) this.repo.markMessageDeleted(message.id);
      }),
    );
    add(
      Events.MessageReactionAdd,
      this.safe("MessageReactionAdd", (reaction, user) => this.onReaction(reaction, user, "add")),
    );
    add(
      Events.MessageReactionRemove,
      this.safe("MessageReactionRemove", (reaction, user) =>
        this.onReaction(reaction, user, "remove"),
      ),
    );
    add(
      Events.ThreadCreate,
      this.safe("ThreadCreate", (thread) => this.onThread(thread)),
    );
    add(
      Events.ThreadUpdate,
      this.safe("ThreadUpdate", (_old, thread) => {
        if (thread) this.onThread(thread as ThreadChannel);
      }),
    );
    add(
      Events.VoiceStateUpdate,
      this.safe("VoiceStateUpdate", (oldState, newState) => this.onVoice(oldState, newState)),
    );
  }

  stop(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.started = false;
  }

  // ─── Handlers ─────────────────────────────────────────────────────────────

  private onMessage(message: Message): void {
    const guildId = message.guildId ?? null;
    if (guildId === null) {
      // DM to the bot — never a guild message; only stored when explicitly enabled.
      if (!this.config.collectBotDms) return;
    } else if (!this.authorised(guildId)) {
      return;
    }
    const input = toMessageInput(message);
    if (!input) return;

    this.repo.transaction(() => {
      if (guildId) {
        this.repo.upsertGuild(guildId, message.guild?.name ?? null);
        const channel = message.channel;
        if (channel && "name" in channel) {
          this.repo.upsertChannel({
            channel_id: message.channelId,
            guild_id: guildId,
            parent_channel_id: input.parent_channel_id ?? null,
            name: (channel as { name: string | null }).name ?? null,
            type: channel.type,
            is_thread: channel.isThread?.() ?? false,
          });
        }
        if (message.author) {
          this.repo.upsertMember({
            user_id: message.author.id,
            guild_id: guildId,
            username: message.author.username ?? null,
            display_name: message.member?.displayName ?? message.author.globalName ?? null,
            is_bot: message.author.bot,
          });
        }
      }
      this.repo.upsertMessage(input);
      for (const a of message.attachments?.values() ?? []) {
        this.repo.upsertAttachment({
          attachment_id: a.id,
          message_id: message.id,
          filename: a.name ?? null,
          content_type: a.contentType ?? null,
          size: a.size ?? null,
          url: a.url ?? null,
          proxy_url: a.proxyURL ?? null,
          width: a.width ?? null,
          height: a.height ?? null,
        });
      }
    });
  }

  private onReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
    kind: "add" | "remove",
  ): void {
    const guildId = reaction.message.guildId ?? null;
    if (guildId !== null && !this.authorised(guildId)) return;
    if (guildId === null && !this.config.collectBotDms) return;
    const messageId = reaction.message.id;
    if (!messageId) return;
    const emoji = { id: reaction.emoji.id ?? null, name: reaction.emoji.name ?? null };
    if (kind === "add") {
      this.repo.insertReaction({
        message_id: messageId,
        emoji_id: emoji.id,
        emoji_name: emoji.name,
        user_id: user.id ?? null,
        reactor_is_bot: Boolean(user.bot),
      });
    } else {
      this.repo.removeReaction(messageId, emoji, user.id ?? null);
    }
  }

  private onThread(thread: ThreadChannel): void {
    const guildId = thread.guildId ?? null;
    if (!this.authorised(guildId)) return;
    this.repo.upsertChannel({
      channel_id: thread.id,
      guild_id: thread.guildId,
      parent_channel_id: thread.parentId ?? null,
      name: thread.name ?? null,
      type: thread.type,
      is_thread: true,
      is_archived: thread.archived ?? false,
    });
  }

  private onVoice(oldState: VoiceState, newState: VoiceState): void {
    const toLike = (s: VoiceState): VoiceStateLike | null =>
      s.member
        ? {
            guildId: s.guild?.id ?? null,
            channelId: s.channelId ?? null,
            userId: s.member.id,
            isBot: s.member.user?.bot ?? false,
          }
        : null;
    handleVoiceStateChange(this.repo, toLike(oldState), toLike(newState), {
      isAuthorised: (g) => isAnalyticsGuildAuthorised(g, this.config),
      collectVoice: this.config.collectVoice,
    });
  }
}
