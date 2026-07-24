/**
 * Open-item reports: candidate UNANSWERED questions and candidate UNACKNOWLEDGED
 * member messages. Both are explicitly heuristic candidates for human review, and
 * both refuse to fabricate results when message content is unavailable.
 */
import { Limitations, excerptOf, type ReportContext } from "./types.js";
import { resolveDateRange } from "./dateRange.js";

function hoursAgoIso(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3600 * 1000).toISOString();
}

function optionalRange(startDate: string | undefined, endDate: string | undefined, tz: string) {
  if (!startDate && !endDate) return { startUtc: null, endUtcExclusive: null };
  // When only one bound is given, widen the other to an open end.
  const s = startDate ?? "1970-01-01";
  const e = endDate ?? "9999-12-31";
  const r = resolveDateRange(s, e, tz);
  return {
    startUtc: startDate ? r.startUtc : null,
    endUtcExclusive: endDate ? r.endUtcExclusive : null,
  };
}

// ─── Unanswered candidate questions ──────────────────────────────────────────

export interface UnansweredParams {
  guildId: string;
  startDate?: string;
  endDate?: string;
  channelIds?: string[];
  memberIds?: string[];
  minimumAgeHours?: number;
  responseWindowHours?: number;
  limit?: number;
  includeExcerpt?: boolean;
}

export function buildUnansweredQuestions(ctx: ReportContext, params: UnansweredParams) {
  const { store, reporting } = ctx;
  const now = ctx.now ?? new Date();
  const responseWindow = params.responseWindowHours ?? reporting.responseWindowHours;
  // Never flag a question overdue before the response window has elapsed.
  const minAge = Math.max(params.minimumAgeHours ?? responseWindow, responseWindow);
  const olderThanIso = hoursAgoIso(now, minAge);
  const { startUtc, endUtcExclusive } = optionalRange(
    params.startDate,
    params.endDate,
    reporting.timezone,
  );
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const limitations = new Limitations();
  limitations.addIf(
    !store.storeContent,
    "Message content storage is disabled: questions cannot be detected, so no candidates are returned.",
  );
  limitations.addIf(
    reporting.staffUserIds.length === 0,
    "No staff user IDs are configured; every question with no reply is treated as unanswered.",
  );

  const rows = store.getUnansweredQuestions(params.guildId, startUtc, endUtcExclusive, {
    channelIds: params.channelIds,
    memberIds: params.memberIds,
    staffIds: reporting.staffUserIds,
    olderThanIso,
    limit,
  });

  const questions = rows.map((r) => {
    const ageHours = Math.round(((now.getTime() - Date.parse(r.created_at)) / 3600000) * 100) / 100;
    const detectionReason = r.content
      ? r.content.includes("?")
        ? "question_mark"
        : "question_phrase"
      : "content_unavailable";
    return {
      messageId: r.message_id,
      channelId: r.channel_id,
      parentChannelId: r.parent_channel_id,
      authorId: r.author_id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at,
      ageHours,
      detectionReason,
      isThread: r.is_thread === 1,
      directReplies: r.direct_replies,
      staffReplies: r.staff_replies,
      hasStaffReaction: r.has_staff_reaction === 1,
      contentAvailable: r.content !== null,
      excerpt: excerptOf(r.content, params.includeExcerpt ?? false, store.storeContent),
    };
  });

  return {
    minimumAgeHours: minAge,
    responseWindowHours: responseWindow,
    methodology: {
      candidate:
        "Member message with '?' or a question phrase, older than the minimum age, not deleted.",
      open: "No staff direct reply, thread response, or thread-from-question was found.",
      sort: "Oldest unresolved questions first.",
    },
    count: questions.length,
    questions,
    limitations: limitations.list(),
  };
}

// ─── Unacknowledged candidate messages ───────────────────────────────────────

export interface UnacknowledgedParams {
  guildId: string;
  startDate?: string;
  endDate?: string;
  channelIds?: string[];
  memberIds?: string[];
  minimumAgeHours?: number;
  acknowledgementWindowHours?: number;
  messageFilter?: "questions" | "attachments" | "all";
  limit?: number;
  includeExcerpt?: boolean;
}

export function buildUnacknowledgedMessages(ctx: ReportContext, params: UnacknowledgedParams) {
  const { store, reporting } = ctx;
  const now = ctx.now ?? new Date();
  const ackWindow = params.acknowledgementWindowHours ?? reporting.acknowledgementWindowHours;
  const minAge = Math.max(params.minimumAgeHours ?? ackWindow, ackWindow);
  const olderThanIso = hoursAgoIso(now, minAge);
  const { startUtc, endUtcExclusive } = optionalRange(
    params.startDate,
    params.endDate,
    reporting.timezone,
  );
  const filter = params.messageFilter ?? "all";
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);

  const limitations = new Limitations();
  limitations.addIf(
    !store.storeContent && filter === "questions",
    "Message content storage is disabled: the 'questions' filter cannot detect questions.",
  );
  limitations.addIf(
    reporting.staffUserIds.length === 0,
    "No staff user IDs are configured; nothing can count as a staff acknowledgement.",
  );
  limitations.add(
    "Results are heuristic CANDIDATE unacknowledged messages requiring human review.",
  );

  const rows = store.getUnacknowledgedMessages(params.guildId, startUtc, endUtcExclusive, {
    channelIds: params.channelIds,
    memberIds: params.memberIds,
    staffIds: reporting.staffUserIds,
    olderThanIso,
    ackWindowHours: ackWindow,
    filter,
    limit,
  });

  const messages = rows.map((r) => {
    const ageHours = Math.round(((now.getTime() - Date.parse(r.created_at)) / 3600000) * 100) / 100;
    return {
      messageId: r.message_id,
      channelId: r.channel_id,
      authorId: r.author_id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at,
      ageHours,
      appearsToBeQuestion: r.is_question === 1,
      attachmentCount: r.attachment_count,
      directReplyCount: r.direct_replies,
      staffReactionCount: r.staff_reactions,
      staffThreadResponseCount: r.staff_thread_responses,
      reason:
        "No staff reply, staff reaction, or staff thread response within the acknowledgement window.",
      contentAvailable: r.content !== null,
      excerpt: excerptOf(r.content, params.includeExcerpt ?? false, store.storeContent),
    };
  });

  return {
    label: "candidate_unacknowledged_messages",
    acknowledgementWindowHours: ackWindow,
    minimumAgeHours: minAge,
    messageFilter: filter,
    methodology: {
      candidate: "Non-staff member message older than the acknowledgement window, not deleted.",
      acknowledged:
        "A staff direct reply, staff reaction, or staff thread response within the window.",
    },
    count: messages.length,
    messages,
    limitations: limitations.list(),
  };
}
