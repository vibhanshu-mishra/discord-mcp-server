/**
 * Member engagement report: raw, auditable per-member metrics for a date range.
 * No composite "engagement score" is computed — only counts that can be verified.
 */
import { buildPeriod, Limitations, type ReportContext } from "./types.js";

export interface MemberEngagementParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  memberIds?: string[];
  includeBots?: boolean;
  includeStaff?: boolean;
  limit?: number;
  sortBy?: string;
}

const SORT_FIELDS: Record<string, (r: MemberRow) => number | string> = {
  messages: (r) => r.messagesSent,
  active_days: (r) => r.activeDays,
  replies_sent: (r) => r.directRepliesSent,
  replies_received: (r) => r.directRepliesReceived,
  reactions_received: (r) => r.reactionsReceived,
  questions_asked: (r) => r.candidateQuestionsAsked,
  last_activity: (r) => r.lastActivity ?? "",
};

interface MemberRow {
  userId: string;
  username: string | null;
  displayName: string | null;
  isStaff: boolean;
  isBot: boolean;
  messagesSent: number;
  activeDays: number;
  distinctChannels: number;
  directRepliesSent: number;
  uniqueMembersRepliedTo: number;
  directRepliesReceived: number;
  uniqueMembersReplying: number;
  reactionsReceived: number;
  candidateQuestionsAsked: number;
  candidateUnansweredQuestions: number;
  firstActivity: string | null;
  lastActivity: string | null;
}

export function buildMemberEngagement(ctx: ReportContext, params: MemberEngagementParams) {
  const { store, reporting } = ctx;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const staffSet = new Set(reporting.staffUserIds);
  const limitations = new Limitations();
  limitations.addIf(
    !store.storeContent,
    "Message content storage is disabled: candidate-question counts are unavailable and reported as 0.",
  );

  const rows = store.getMemberEngagement(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    period.offsetSeconds,
    {
      channelIds: params.channelIds,
      memberIds: params.memberIds,
      includeBots: params.includeBots ?? false,
      staffIds: reporting.staffUserIds,
    },
  );

  const includeStaff = params.includeStaff ?? true;
  let members: MemberRow[] = rows
    .filter((r) => includeStaff || !staffSet.has(r.user_id))
    .map((r) => ({
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      isStaff: staffSet.has(r.user_id),
      isBot: r.is_bot === 1,
      messagesSent: r.messages,
      activeDays: r.active_days,
      distinctChannels: r.distinct_channels,
      directRepliesSent: r.replies_sent,
      uniqueMembersRepliedTo: r.unique_replied_to,
      directRepliesReceived: r.replies_received,
      uniqueMembersReplying: r.unique_repliers,
      reactionsReceived: r.reactions_received,
      candidateQuestionsAsked: r.questions_asked,
      candidateUnansweredQuestions: r.unanswered_questions,
      firstActivity: r.first_activity,
      lastActivity: r.last_activity,
    }));

  const sortKey = SORT_FIELDS[params.sortBy ?? "messages"] ?? SORT_FIELDS.messages;
  members.sort((a, b) => {
    const av = sortKey(a);
    const bv = sortKey(b);
    return av < bv ? 1 : av > bv ? -1 : 0; // descending
  });
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 1000);
  members = members.slice(0, limit);

  return {
    period,
    methodology: {
      member:
        "Non-bot users with at least one stored message in the range (staff optionally included).",
      directReply: "A stored message whose referenced_message_id points at another stored message.",
      candidateQuestion:
        "A member message containing '?' or a known question phrase (requires stored content).",
      note: "Raw counts only; no engagement score is assigned in this phase.",
    },
    memberCount: members.length,
    members,
    limitations: limitations.list(),
  };
}
