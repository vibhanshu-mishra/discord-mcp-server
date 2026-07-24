/**
 * Deterministic weekly metrics: one structured report combining community
 * activity, primary-user activity, response health, acknowledgement health,
 * training cadence, and office hours — with previous-week comparisons. No prose,
 * no judgement ("good"/"bad"), just numbers, ratios, and data-quality warnings.
 *
 * The primary-user section is optional: it appears only when
 * DISCORD_ANALYTICS_PRIMARY_USER_ID is configured; otherwise it is marked
 * unconfigured with a clear note (never a fabricated user).
 */
import { type ReportContext } from "./types.js";
import { mostRecentCompletedWeek, previousWeek, resolveWeek, type WeekRange } from "./dateRange.js";
import { ratio, compare } from "./stats.js";
import { buildUserActivity } from "./userActivity.js";
import { buildStaffResponseMetrics } from "./responseMetrics.js";
import { buildUnacknowledgedMessages } from "./openItems.js";
import { buildTrainingCadence } from "./trainingCadence.js";
import { buildOfficeHourMetrics } from "./officeHours.js";

export interface WeeklyMetricsParams {
  guildId: string;
  weekStartDate?: string;
  comparePreviousWeek?: boolean;
  resourceChannelIds?: string[];
  officeHourChannelIds?: string[];
  excludeStaffFromMemberMetrics?: boolean;
  /** Whether live collection is currently attached (surfaced as a warning). */
  collectionActive?: boolean;
}

/** The numbers extracted for one week, used for the report and for comparison. */
interface WeekBundle {
  memberMessages: number;
  staffMessages: number;
  activeMembers: number;
  newMembers: number;
  returningMembers: number;
  distinctChannels: number;
  primaryUserMessages: number;
  primaryUserActiveDays: number;
  primaryUserDirectReplies: number;
  primaryUserUniqueRepliedTo: number;
  questionsPrimaryUserAnswered: number;
  questions: number;
  questionsWithResponse: number;
  questionsWithinWindow: number;
  unanswered: number;
  responseRatePct: number | null;
  medianResponseSeconds: number | null;
  eligibleMessages: number;
  unacknowledged: number;
  uniqueAttendees: number;
  totalSessions: number;
  attendanceMinutes: number;
  averageAttendanceSeconds: number | null;
  repeatAttendees: number;
  incompleteSessions: number;
}

function computeBundle(
  ctx: ReportContext,
  params: WeeklyMetricsParams,
  week: WeekRange,
): WeekBundle {
  const { store, reporting } = ctx;
  const guildId = params.guildId;
  const totals = store.getMessageTotals(
    guildId,
    week.startUtc,
    week.endUtcExclusive,
    reporting.staffUserIds,
  );
  const active = store.getActiveMembers(
    guildId,
    week.startUtc,
    week.endUtcExclusive,
    reporting.staffUserIds,
  );
  const newMembers = active.filter(
    (m) => m.first_ever >= week.startUtc && m.first_ever < week.endUtcExclusive,
  );

  // Primary-user activity is only computed when a primary user is configured.
  const primaryUser = reporting.primaryUserId
    ? buildUserActivity(ctx, {
        guildId,
        userId: reporting.primaryUserId,
        startDate: week.localStartDate,
        endDate: week.localEndDate,
        includeDailyBreakdown: false,
        includeChannelBreakdown: false,
      })
    : null;
  const response = buildStaffResponseMetrics(ctx, {
    guildId,
    startDate: week.localStartDate,
    endDate: week.localEndDate,
    includePerStaffBreakdown: false,
    includeChannelBreakdown: false,
  });
  const ack = buildUnacknowledgedMessages(ctx, {
    guildId,
    startDate: week.localStartDate,
    endDate: week.localEndDate,
    messageFilter: "all",
    limit: 1000,
  });
  const office = buildOfficeHourMetrics(ctx, {
    guildId,
    startDate: week.localStartDate,
    endDate: week.localEndDate,
    voiceChannelIds: params.officeHourChannelIds,
    includeMemberBreakdown: false,
    includeDailyBreakdown: false,
  });

  return {
    memberMessages: totals.memberMessages,
    staffMessages: totals.staffMessages,
    activeMembers: active.length,
    newMembers: newMembers.length,
    returningMembers: active.length - newMembers.length,
    distinctChannels: totals.distinctChannels,
    primaryUserMessages: primaryUser?.totalMessages ?? 0,
    primaryUserActiveDays: primaryUser?.activeDays ?? 0,
    primaryUserDirectReplies: primaryUser?.directRepliesSent ?? 0,
    primaryUserUniqueRepliedTo: primaryUser?.uniqueMembersRepliedTo ?? 0,
    questionsPrimaryUserAnswered: primaryUser?.candidateQuestionsAnswered ?? 0,
    questions: response.totalQuestions,
    questionsWithResponse: response.questionsWithResponse,
    questionsWithinWindow: response.questionsWithinWindow,
    unanswered: response.unanswered,
    responseRatePct: response.responseRate.percentage,
    medianResponseSeconds: response.medianFirstResponseSeconds,
    eligibleMessages: totals.memberMessages,
    unacknowledged: ack.count,
    uniqueAttendees: office.uniqueAttendees,
    totalSessions: office.totalSessions,
    attendanceMinutes: office.totalAttendanceMinutes,
    averageAttendanceSeconds: office.averageSessionSeconds,
    repeatAttendees: office.repeatAttendees,
    incompleteSessions: office.incompleteSessionCount,
  };
}

export function buildWeeklyMetrics(ctx: ReportContext, params: WeeklyMetricsParams) {
  const { store, reporting } = ctx;
  const now = ctx.now ?? new Date();
  const tz = reporting.timezone;

  const week = params.weekStartDate
    ? resolveWeek(params.weekStartDate, tz, reporting.weekStart)
    : mostRecentCompletedWeek(now, tz, reporting.weekStart);
  const comparePrev = params.comparePreviousWeek ?? true;
  const prevWeek = comparePrev ? previousWeek(week, tz, reporting.weekStart) : null;

  const current = computeBundle(ctx, params, week);
  const previous = prevWeek ? computeBundle(ctx, params, prevWeek) : null;
  const cmp = (pick: (b: WeekBundle) => number) =>
    previous ? compare(pick(current), pick(previous)) : null;

  // Training cadence for the single week.
  const training = buildTrainingCadence(ctx, {
    guildId: params.guildId,
    startDate: week.localStartDate,
    endDate: week.localEndDate,
    resourceChannelIds: params.resourceChannelIds,
  });

  const warnings: string[] = [];
  if (!store.storeContent)
    warnings.push("Message content storage is disabled; question/training detection is limited.");
  if (!reporting.primaryUserId)
    warnings.push(
      "Primary user ID is not configured; the primary-user activity section is omitted.",
    );
  if (reporting.staffUserIds.length === 0)
    warnings.push("No staff user IDs configured; response/acknowledgement metrics are degraded.");
  const resourceChannels = params.resourceChannelIds?.length
    ? params.resourceChannelIds
    : reporting.resourceChannelIds;
  if (resourceChannels.length === 0)
    warnings.push("No resource channels configured; training cadence is unavailable.");
  const officeChannels = params.officeHourChannelIds?.length
    ? params.officeHourChannelIds
    : reporting.officeHourChannelIds;
  if (officeChannels.length === 0)
    warnings.push("No office-hour channels configured; office-hour metrics are zero.");
  if (current.incompleteSessions > 0)
    warnings.push("Some voice sessions are incomplete (unknown leave time).");
  if (store.getEarliestVoiceJoin(params.guildId, officeChannels) === null)
    warnings.push("No stored voice history; office-hour history is limited.");
  if (comparePrev && previous && previous.memberMessages === 0)
    warnings.push("Previous week has no stored messages; comparisons may be unreliable or null.");
  if (params.collectionActive === false) warnings.push("Live analytics collection is not active.");

  return {
    reportingPeriod: {
      timezone: tz,
      weekStartConvention: reporting.weekStart,
      currentWeekLocalDates: { start: week.localStartDate, end: week.localEndDate },
      currentWeekUtcBoundaries: { startUtc: week.startUtc, endUtcExclusive: week.endUtcExclusive },
      previousWeekUtcBoundaries: prevWeek
        ? { startUtc: prevWeek.startUtc, endUtcExclusive: prevWeek.endUtcExclusive }
        : null,
    },
    communityActivity: {
      totalMemberMessages: current.memberMessages,
      totalStaffMessages: current.staffMessages,
      activeNonStaffMembers: current.activeMembers,
      newActiveMembers: current.newMembers,
      returningActiveMembers: current.returningMembers,
      distinctActiveChannels: current.distinctChannels,
      messagesPerActiveMember: ratio(current.memberMessages, current.activeMembers),
      changeVsPreviousWeek: {
        memberMessages: cmp((b) => b.memberMessages),
        activeMembers: cmp((b) => b.activeMembers),
      },
    },
    // Optional primary-user (community owner/admin) activity. Present only when
    // DISCORD_ANALYTICS_PRIMARY_USER_ID is configured; otherwise clearly omitted.
    primaryUserActivity: reporting.primaryUserId
      ? {
          configured: true,
          userId: reporting.primaryUserId,
          messages: current.primaryUserMessages,
          activeDays: current.primaryUserActiveDays,
          directReplies: current.primaryUserDirectReplies,
          uniqueMembersRepliedTo: current.primaryUserUniqueRepliedTo,
          candidateQuestionsAnswered: current.questionsPrimaryUserAnswered,
          changeVsPreviousWeek: {
            messages: cmp((b) => b.primaryUserMessages),
            directReplies: cmp((b) => b.primaryUserDirectReplies),
          },
        }
      : {
          configured: false,
          note: "DISCORD_ANALYTICS_PRIMARY_USER_ID is not configured; primary-user activity is omitted.",
        },
    responseHealth: {
      candidateQuestions: current.questions,
      questionsWithStaffResponse: current.questionsWithResponse,
      questionsAnsweredWithinWindow: current.questionsWithinWindow,
      candidateUnansweredQuestions: current.unanswered,
      responseRate: ratio(current.questionsWithResponse, current.questions),
      medianResponseSeconds: current.medianResponseSeconds,
      changeVsPreviousWeek: {
        candidateQuestions: cmp((b) => b.questions),
        questionsWithResponse: cmp((b) => b.questionsWithResponse),
      },
    },
    acknowledgementHealth: {
      candidateEligibleMemberMessages: current.eligibleMessages,
      candidateUnacknowledgedMessages: current.unacknowledged,
      acknowledgementRate: ratio(
        Math.max(0, current.eligibleMessages - current.unacknowledged),
        current.eligibleMessages,
      ),
      changeVsPreviousWeek: {
        unacknowledged: cmp((b) => b.unacknowledged),
      },
    },
    trainingCadence: {
      expectedChannelWeeks: training.expectedChannelWeeks,
      channelWeeksWithTraining: training.completedChannelWeeks,
      missingChannelWeeks: training.missingChannelWeeks,
      cadence: training.cadence,
    },
    officeHours: {
      uniqueAttendees: current.uniqueAttendees,
      totalSessions: current.totalSessions,
      totalAttendanceMinutes: current.attendanceMinutes,
      averageAttendanceSeconds: current.averageAttendanceSeconds,
      repeatAttendees: current.repeatAttendees,
      incompleteSessions: current.incompleteSessions,
      changeVsPreviousWeek: {
        uniqueAttendees: cmp((b) => b.uniqueAttendees),
        totalSessions: cmp((b) => b.totalSessions),
      },
    },
    methodology: {
      newActiveMember:
        "A member whose FIRST stored message falls in the week (locally stored history, not Discord join date).",
      weekBoundaries:
        "Weeks use the configured time zone and week-start; boundaries are half-open in UTC.",
    },
    dataQualityWarnings: warnings,
  };
}
