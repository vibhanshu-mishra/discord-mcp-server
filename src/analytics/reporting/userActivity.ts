/**
 * User activity report: how often a given user posts, who they reply to, and how
 * fast they are as a first responder. Works for ANY user ID in the authorised
 * guild — the user is supplied as a parameter, not read from configuration.
 */
import { buildPeriod, Limitations, type ReportContext } from "./types.js";
import { median } from "./stats.js";

export interface UserActivityParams {
  guildId: string;
  /** The Discord user ID to report on (required). */
  userId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  includeDailyBreakdown?: boolean;
  includeChannelBreakdown?: boolean;
}

/** Builds the activity report for a single supplied user over a date range. */
export function buildUserActivity(ctx: ReportContext, params: UserActivityParams) {
  const { store, reporting } = ctx;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const limitations = new Limitations();
  const userId = params.userId;

  // The user's own engagement row (messages, active days, replies, questions…).
  const [row] = store.getMemberEngagement(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    period.offsetSeconds,
    {
      channelIds: params.channelIds,
      memberIds: [userId],
      includeBots: true,
      staffIds: reporting.staffUserIds,
    },
  );

  // Candidate member questions where this user was the FIRST staff responder.
  const questions = store.getCandidateQuestions(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: params.channelIds,
      staffIds: reporting.staffUserIds,
    },
  );
  const answeredFirst = questions.filter(
    (q) => q.first_responder_id === userId && q.first_response_at,
  );
  const responseTimes = answeredFirst.map((q) =>
    Math.max(0, Math.round((Date.parse(q.first_response_at!) - Date.parse(q.created_at)) / 1000)),
  );

  const reactions = store.getReactionTotals(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    userId,
  );

  limitations.addIf(
    !store.storeContent,
    "Message content storage is disabled: candidate-question answer counts are unavailable.",
  );

  return {
    period,
    userId,
    totalMessages: row?.messages ?? 0,
    activeDays: row?.active_days ?? 0,
    distinctChannels: row?.distinct_channels ?? 0,
    directRepliesSent: row?.replies_sent ?? 0,
    uniqueMembersRepliedTo: row?.unique_replied_to ?? 0,
    directRepliesReceived: row?.replies_received ?? 0,
    uniqueMembersReplied: row?.unique_repliers ?? 0,
    reactionsGiven: reactions.given,
    reactionsReceived: reactions.received,
    candidateQuestionsAnswered: answeredFirst.length,
    medianFirstResponseSecondsWhenFirst: median(responseTimes),
    dailyBreakdown:
      params.includeDailyBreakdown === false
        ? undefined
        : store.getDailyMessageCounts(
            params.guildId,
            period.startUtc,
            period.endUtcExclusive,
            userId,
            period.offsetSeconds,
          ),
    channelBreakdown:
      params.includeChannelBreakdown === false
        ? undefined
        : store.getChannelMessageCounts(
            params.guildId,
            period.startUtc,
            period.endUtcExclusive,
            userId,
          ),
    methodology: {
      answeredQuestion:
        "A candidate member question whose FIRST staff responder was the selected user.",
      note: "Message content is never included; only counts and timings.",
    },
    limitations: limitations.list(),
  };
}
