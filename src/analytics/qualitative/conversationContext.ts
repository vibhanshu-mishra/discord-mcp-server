/**
 * Conversation context around a target message, assembled ONLY from locally
 * stored data — it never calls Discord to fetch anything missing. Messages before
 * and after (bounded), direct replies, and thread messages are merged, de-duped,
 * and returned in chronological order. Excerpts are opt-in and privacy-gated.
 */
import { Limitations } from "../reporting/types.js";
import { Pseudonymizer } from "./pseudonymizer.js";
import { toEvidence } from "./evidence.js";
import { reportingOf, type QualContext, type AnalysisMessageRow } from "./types.js";

/** Hard bounds so a large thread is never returned in full. */
const MAX_BEFORE = 25;
const MAX_AFTER = 50;
const MAX_THREAD = 50;
const MAX_REPLIES = 50;

export interface ConversationContextParams {
  guildId: string;
  messageId: string;
  messagesBefore?: number;
  messagesAfter?: number;
  includeThread?: boolean;
  includeDirectReplies?: boolean;
  includeReactions?: boolean;
  includeExcerpts?: boolean;
}

export function buildConversationContext(ctx: QualContext, params: ConversationContextParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const before = Math.min(Math.max(params.messagesBefore ?? 5, 0), MAX_BEFORE);
  const after = Math.min(Math.max(params.messagesAfter ?? 10, 0), MAX_AFTER);
  const includeThread = params.includeThread ?? true;
  const includeReplies = params.includeDirectReplies ?? true;
  const includeExcerpts = params.includeExcerpts ?? false;

  const limitations = new Limitations();
  const reason = ctx.policy.disabledReason();
  if (reason && includeExcerpts) limitations.add(reason);

  const target = ctx.qStore.getMessage(params.guildId, params.messageId);
  if (!target) {
    return {
      found: false,
      messageId: params.messageId,
      limitations: [
        "The target message is not in the local database; context cannot be built. This server never fetches from Discord.",
      ],
    };
  }

  const pseudo = new Pseudonymizer(
    cfg,
    ctx.policy.contentAllowed,
    new Set(reporting.staffUserIds),
    reporting.primaryUserId,
  );

  // Gather all context sources, then de-dupe by message ID and sort chronologically.
  const byId = new Map<string, AnalysisMessageRow>();
  const add = (rows: AnalysisMessageRow[]) => {
    for (const r of rows) if (r.message_id !== target.message_id) byId.set(r.message_id, r);
  };

  const window = ctx.qStore.getContextWindow(
    params.guildId,
    target.channel_id,
    target.created_at,
    before,
    after,
  );
  add(window.before);
  add(window.after);

  if (includeReplies)
    add(ctx.qStore.getDirectReplies(params.guildId, params.messageId, MAX_REPLIES));

  let threadIncomplete = false;
  if (includeThread) {
    // A thread started from the target uses the target's message ID as its channel.
    const threadRows = ctx.qStore.getThreadMessages(params.guildId, params.messageId, MAX_THREAD);
    add(threadRows);
    // If the target itself is inside a thread, its own channel is the thread.
    if (target.is_thread === 1)
      add(ctx.qStore.getThreadMessages(params.guildId, target.channel_id, MAX_THREAD));
    threadIncomplete = threadRows.length === MAX_THREAD;
  }

  const contextRows = [...byId.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id),
  );

  // Detect likely-incomplete local history: no messages before a non-oldest target.
  const earliest = ctx.qStore.getEarliestMessageAt(params.guildId);
  if (window.before.length === 0 && earliest !== null && target.created_at > earliest) {
    limitations.add(
      "No earlier messages were found in this channel locally; context before the target may be incomplete.",
    );
  }
  if (threadIncomplete)
    limitations.add("The thread is larger than the returned bound; thread context is truncated.");

  const toItem = (r: AnalysisMessageRow, reason?: string) =>
    toEvidence(r, ctx.policy, pseudo, includeExcerpts, reason ? { reason } : undefined);

  return {
    found: true,
    contentOutputEnabled: ctx.policy.contentAllowed && includeExcerpts,
    target: {
      messageId: target.message_id,
      channelId: target.channel_id,
      parentChannelId: target.parent_channel_id,
      channelName: target.channel_name,
      channelType: target.channel_type,
      isThread: target.is_thread === 1,
      createdAt: target.created_at,
      author: pseudo.identify(target.author_id),
      ...((params.includeReactions ?? true) ? { reactionCount: target.reaction_count } : {}),
      replyCount: target.reply_count,
      excerpt: ctx.policy.excerpt(target.content, includeExcerpts)?.text ?? null,
    },
    contextMessageCount: contextRows.length,
    context: contextRows.map((r) => toItem(r)),
    methodology: {
      bounds: {
        messagesBefore: before,
        messagesAfter: after,
        maxThread: MAX_THREAD,
        maxReplies: MAX_REPLIES,
      },
      note: "Assembled from local storage only; never fetched from Discord. Messages are de-duplicated and chronological.",
    },
    limitations: limitations.list(),
  };
}
