/**
 * Structured evidence packets for an MCP client to summarise. These tools NEVER
 * generate an AI summary or persuasive prose — they assemble deterministic,
 * bounded, privacy-safe evidence (metrics, lexical candidates, and a balanced
 * message sample) and leave interpretation to the connected client.
 */
import { buildPeriod, Limitations } from "../reporting/types.js";
import { buildStaffResponseMetrics } from "../reporting/responseMetrics.js";
import { buildUnansweredQuestions, buildUnacknowledgedMessages } from "../reporting/openItems.js";
import { buildTrainingCadence } from "../reporting/trainingCadence.js";
import { buildOfficeHourMetrics } from "../reporting/officeHours.js";
import { Pseudonymizer } from "./pseudonymizer.js";
import { toEvidence, type EvidenceItem } from "./evidence.js";
import { classify } from "./feedbackSignals.js";
import { looksLikeQuestion } from "../reporting/questions.js";
import { buildTopicCandidates } from "./topicCandidates.js";
import { buildRecurringQuestions } from "./recurringQuestions.js";
import { buildFeedbackSignals } from "./feedbackSignals.js";
import { reportingOf, type QualContext, type AnalysisMessageRow } from "./types.js";

const SCAN_LIMIT = 5000;

/**
 * Deterministically selects a balanced evidence sample across several buckets
 * (high-reply, high-reaction, questions, feedback, topic-supporting, recent) — not
 * merely the first or last messages. Bounded by `limit`.
 */
function balancedSample(
  rows: AnalysisMessageRow[],
  topicMessageIds: Set<string>,
  limit: number,
): { row: AnalysisMessageRow; reason: string }[] {
  // Each bucket is a deterministically-sorted candidate list with a reason.
  const buckets: [AnalysisMessageRow[], string][] = [
    [
      [...rows].sort(
        (a, b) => b.reply_count - a.reply_count || a.message_id.localeCompare(b.message_id),
      ),
      "high_reply",
    ],
    [
      [...rows].sort(
        (a, b) => b.reaction_count - a.reaction_count || a.message_id.localeCompare(b.message_id),
      ),
      "high_reaction",
    ],
    [rows.filter((r) => looksLikeQuestion(r.content)), "candidate_question"],
    [rows.filter((r) => classify(r.content).length > 0), "feedback_signal"],
    [rows.filter((r) => topicMessageIds.has(r.message_id)), "topic_supporting"],
    [[...rows].sort((a, b) => b.created_at.localeCompare(a.created_at)), "recent"],
  ];
  const cursors = buckets.map(() => 0);
  const chosen = new Map<string, string>(); // messageId -> reason

  // Round-robin one pick per bucket per pass, so no single bucket dominates.
  let progressed = true;
  while (chosen.size < limit && progressed) {
    progressed = false;
    for (let b = 0; b < buckets.length && chosen.size < limit; b++) {
      const [list, reason] = buckets[b];
      while (cursors[b] < list.length && chosen.has(list[cursors[b]].message_id)) cursors[b]++;
      if (cursors[b] < list.length) {
        chosen.set(list[cursors[b]].message_id, reason);
        cursors[b]++;
        progressed = true;
      }
    }
  }

  const byId = new Map(rows.map((r) => [r.message_id, r]));
  return [...chosen.entries()]
    .map(([id, reason]) => ({ row: byId.get(id)!, reason }))
    .sort((a, b) => a.row.created_at.localeCompare(b.row.created_at)); // chronological output
}

// ─── Tool 5: channel conversation summary packet ─────────────────────────────

export interface ChannelPacketParams {
  guildId: string;
  channelId: string;
  startDate: string;
  endDate: string;
  maximumMessages?: number;
  includeStaff?: boolean;
  includeExcerpts?: boolean;
}

export function buildChannelPacket(ctx: QualContext, params: ChannelPacketParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const includeStaff = params.includeStaff ?? cfg.includeStaff;
  const includeExcerpts = params.includeExcerpts ?? false;
  const evidenceLimit = Math.min(
    params.maximumMessages ?? cfg.maxEvidenceMessages,
    cfg.maxEvidenceMessages,
  );

  const limitations = new Limitations();
  limitations.add(
    "This packet is deterministic evidence for an MCP client to summarise; it contains no AI-generated prose.",
  );
  const reason = ctx.policy.disabledReason();
  if (reason) limitations.add(reason);
  limitations.addIf(
    cfg.excludedChannelIds.includes(params.channelId),
    "The requested channel is in the qualitative exclusion list; results may be empty.",
  );

  const meta = ctx.qStore.getChannelMeta(params.channelId);
  const stats = ctx.qStore.getChannelStats(
    params.guildId,
    params.channelId,
    period.startUtc,
    period.endUtcExclusive,
    reporting.staffUserIds,
  );
  const questions = ctx.qStore.getCandidateQuestions(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: [params.channelId],
      excludedChannelIds: cfg.excludedChannelIds,
      staffIds: reporting.staffUserIds,
      limit: SCAN_LIMIT,
    },
  );
  const unanswered = questions.filter((q) => q.first_response_at === null).length;

  const topics = buildTopicCandidates(ctx, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: [params.channelId],
    includeStaff,
    comparePreviousPeriod: false,
  });
  const feedback = buildFeedbackSignals(ctx, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: [params.channelId],
    includeStaff,
  });

  const rows = ctx.qStore.getAnalysisMessages(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: [params.channelId],
      excludedChannelIds: cfg.excludedChannelIds,
      includeStaff,
      staffIds: reporting.staffUserIds,
      limit: SCAN_LIMIT,
    },
  );
  const topicMessageIds = new Set(topics.topics.flatMap((t) => t.representativeMessageIds));
  const pseudo = new Pseudonymizer(
    cfg,
    ctx.policy.contentAllowed,
    new Set(reporting.staffUserIds),
    reporting.primaryUserId,
  );
  const sample = balancedSample(rows, topicMessageIds, evidenceLimit).map((s) =>
    toEvidence(s.row, ctx.policy, pseudo, includeExcerpts, { reason: s.reason }),
  );

  limitations.addIf(
    stats.total < 10,
    "Low message volume; deterministic findings may be unreliable.",
  );
  limitations.add("Topic and feedback results are LEXICAL candidates requiring human review.");

  return {
    period,
    channel: meta
      ? {
          channelId: meta.channel_id,
          name: meta.name,
          type: meta.type,
          isThread: meta.is_thread === 1,
        }
      : { channelId: params.channelId, name: null },
    totals: {
      totalMessages: stats.total,
      activeMembers: stats.activeMembers,
      staffMessages: stats.staffMessages,
      memberMessages: stats.memberMessages,
    },
    candidateQuestions: questions.length,
    candidateUnansweredQuestions: unanswered,
    topicCandidates: topics.topics.map((t) => ({
      label: t.label,
      supportingMessageCount: t.supportingMessageCount,
      distinctMemberCount: t.distinctMemberCount,
    })),
    feedbackSignalCounts: feedback.categories.map((c) => ({
      category: c.category,
      count: c.count,
    })),
    mostActiveHours: ctx.qStore
      .getHourlyActivity(
        params.guildId,
        params.channelId,
        period.startUtc,
        period.endUtcExclusive,
        period.offsetSeconds,
      )
      .slice(0, 5),
    majorThreads:
      meta?.is_thread === 0
        ? ctx.qStore
            .getThreadActivity(
              params.guildId,
              params.channelId,
              period.startUtc,
              period.endUtcExclusive,
              5,
            )
            .map((t) => ({ channelId: t.channel_id, name: t.name, messageCount: t.message_count }))
        : [],
    evidenceSample: sample,
    methodology: {
      sampling:
        "Balanced deterministic buckets: high-reply, high-reaction, candidate questions, feedback signals, topic-supporting, and recent — output chronologically.",
      note: "No AI summary is generated; the MCP client performs interpretation.",
    },
    limitations: limitations.list(),
  };
}

// ─── Tool 6: global qualitative analysis packet ──────────────────────────────

export interface QualitativePacketParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  comparePreviousPeriod?: boolean;
  includeEvidence?: boolean;
  maximumEvidenceMessages?: number;
}

export function buildQualitativePacket(ctx: QualContext, params: QualitativePacketParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const includeEvidence = params.includeEvidence ?? false;
  const evidenceLimit = Math.min(
    params.maximumEvidenceMessages ?? cfg.maxEvidenceMessages,
    cfg.maxEvidenceMessages,
  );

  const topics = buildTopicCandidates(ctx, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
    comparePreviousPeriod: params.comparePreviousPeriod ?? true,
  });
  const recurring = buildRecurringQuestions(ctx, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
  });
  const feedback = buildFeedbackSignals(ctx, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
  });

  // Reuse deterministic Phase 3 metrics via the report context.
  const responses = buildStaffResponseMetrics(ctx.report, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
    includePerStaffBreakdown: false,
    includeChannelBreakdown: false,
  });
  const unanswered = buildUnansweredQuestions(ctx.report, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
  });
  const unacknowledged = buildUnacknowledgedMessages(ctx.report, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    channelIds: params.channelIds,
    messageFilter: "all",
    limit: 1000,
  });
  const training = buildTrainingCadence(ctx.report, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
  });
  const office = buildOfficeHourMetrics(ctx.report, {
    guildId: params.guildId,
    startDate: params.startDate,
    endDate: params.endDate,
    includeMemberBreakdown: false,
    includeDailyBreakdown: false,
  });

  // Optional bounded evidence packet.
  let evidence: EvidenceItem[] | undefined;
  if (includeEvidence && ctx.policy.contentAllowed) {
    const rows = ctx.qStore.getAnalysisMessages(
      params.guildId,
      period.startUtc,
      period.endUtcExclusive,
      {
        channelIds: params.channelIds,
        excludedChannelIds: cfg.excludedChannelIds,
        includeStaff: cfg.includeStaff,
        staffIds: reporting.staffUserIds,
        limit: SCAN_LIMIT,
      },
    );
    const topicIds = new Set(topics.topics.flatMap((t) => t.representativeMessageIds));
    const pseudo = new Pseudonymizer(
      cfg,
      ctx.policy.contentAllowed,
      new Set(reporting.staffUserIds),
      reporting.primaryUserId,
    );
    evidence = balancedSample(rows, topicIds, evidenceLimit).map((s) =>
      toEvidence(s.row, ctx.policy, pseudo, true, { reason: s.reason }),
    );
  }

  const warnings: string[] = [];
  if (!ctx.qStore.storeContent)
    warnings.push(
      "Message content storage is disabled; topic/question/feedback detection is unavailable.",
    );
  if (!cfg.allowContentOutput)
    warnings.push("Content output is disabled; excerpts are not returned.");
  if (cfg.excludedChannelIds.length > 0)
    warnings.push("Some channels are excluded from qualitative analysis.");
  if (reporting.staffUserIds.length === 0)
    warnings.push("No staff configured; response/acknowledgement metrics are degraded.");
  if (reporting.resourceChannelIds.length === 0)
    warnings.push("No resource channels configured; training cadence is unavailable.");
  if (reporting.officeHourChannelIds.length === 0)
    warnings.push("No office-hour channels configured; office-hour metrics are zero.");
  if (office.incompleteSessionCount > 0)
    warnings.push("Some voice sessions are incomplete (unknown leave time).");
  if (topics.analysedMessageCount < 10)
    warnings.push("Low message volume; lexical findings may be unreliable.");
  warnings.push(
    "Topic, recurring-question, and feedback results are LEXICAL candidates requiring human review.",
  );
  if ((params.comparePreviousPeriod ?? true) === false)
    warnings.push("Previous-period comparison was not requested.");

  return {
    period: {
      timezone: period.timezone,
      localDateRange: { start: period.startDate, end: period.endDate },
      utcBoundaries: { startUtc: period.startUtc, endUtcExclusive: period.endUtcExclusive },
      previousPeriodRequested: params.comparePreviousPeriod ?? true,
    },
    topicCandidates: topics.topics,
    recurringQuestions: recurring.groups,
    feedbackSignals: feedback.categories,
    conversationHealth: {
      candidateUnansweredQuestions: unanswered.count,
      candidateUnacknowledgedMessages: unacknowledged.count,
      staffResponse: {
        candidateQuestions: responses.totalQuestions,
        questionsWithResponse: responses.questionsWithResponse,
        responseRate: responses.responseRate,
        medianFirstResponseSeconds: responses.medianFirstResponseSeconds,
      },
      trainingCadence: {
        expectedChannelWeeks: training.expectedChannelWeeks,
        completedChannelWeeks: training.completedChannelWeeks,
        cadence: training.cadence,
      },
      officeHours: {
        uniqueAttendees: office.uniqueAttendees,
        totalSessions: office.totalSessions,
        incompleteSessions: office.incompleteSessionCount,
      },
    },
    evidence,
    methodology: {
      note: "Deterministic lexical analysis plus reused Phase 3 metrics. No AI provider is called; the MCP client performs any summarisation.",
    },
    dataQualityWarnings: warnings,
  };
}
