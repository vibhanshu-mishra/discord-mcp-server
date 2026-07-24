/**
 * Staff response metrics: how many candidate member questions received a staff
 * response, how fast, and by whom. A staff response is a direct reply, a staff
 * post in a thread started from the question, or a staff post in the same thread
 * — never merely a later message in a shared channel.
 */
import { buildPeriod, Limitations, type ReportContext } from "./types.js";
import type { QuestionResponseRow } from "./store.js";
import { ratio, mean, median, percentile, type Ratio } from "./stats.js";

export interface StaffResponseParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  staffUserIds?: string[];
  responseWindowHours?: number;
  includePerStaffBreakdown?: boolean;
  includeChannelBreakdown?: boolean;
}

/** Response-time aggregates over one set of candidate questions. */
export interface ResponseStats {
  totalQuestions: number;
  questionsWithResponse: number;
  questionsWithinWindow: number;
  unanswered: number;
  responseRate: Ratio;
  withinWindowRate: Ratio;
  averageFirstResponseSeconds: number | null;
  medianFirstResponseSeconds: number | null;
  p90FirstResponseSeconds: number | null;
  fastestResponseSeconds: number | null;
  slowestResponseSeconds: number | null;
}

/** Seconds between a question and its first staff response, or null if none. */
function responseSeconds(row: QuestionResponseRow): number | null {
  if (!row.first_response_at) return null;
  return Math.max(
    0,
    Math.round((Date.parse(row.first_response_at) - Date.parse(row.created_at)) / 1000),
  );
}

/** Computes response aggregates from question rows for a given window. */
export function computeResponseStats(
  rows: QuestionResponseRow[],
  windowSeconds: number,
): ResponseStats {
  const total = rows.length;
  const times: number[] = [];
  let withResponse = 0;
  let withinWindow = 0;
  for (const r of rows) {
    const secs = responseSeconds(r);
    if (secs === null) continue;
    withResponse += 1;
    times.push(secs);
    if (secs <= windowSeconds) withinWindow += 1;
  }
  return {
    totalQuestions: total,
    questionsWithResponse: withResponse,
    questionsWithinWindow: withinWindow,
    unanswered: total - withResponse,
    responseRate: ratio(withResponse, total),
    withinWindowRate: ratio(withinWindow, total),
    averageFirstResponseSeconds: mean(times),
    medianFirstResponseSeconds: median(times),
    // 90th percentile needs a few points to be meaningful.
    p90FirstResponseSeconds: times.length >= 5 ? percentile(times, 90) : null,
    fastestResponseSeconds: times.length ? Math.min(...times) : null,
    slowestResponseSeconds: times.length ? Math.max(...times) : null,
  };
}

export function buildStaffResponseMetrics(ctx: ReportContext, params: StaffResponseParams) {
  const { store, reporting } = ctx;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const staffIds = params.staffUserIds?.length ? params.staffUserIds : reporting.staffUserIds;
  const windowHours = params.responseWindowHours ?? reporting.responseWindowHours;
  const windowSeconds = windowHours * 3600;
  const limitations = new Limitations();
  limitations.addIf(
    !store.storeContent,
    "Message content storage is disabled: candidate questions cannot be detected, so results are empty.",
  );
  limitations.addIf(
    staffIds.length === 0,
    "No staff user IDs are configured; every question counts as unanswered.",
  );

  const questions = store.getCandidateQuestions(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: params.channelIds,
      staffIds,
    },
  );
  const stats = computeResponseStats(questions, windowSeconds);

  // Per-staff first-response counts (from the questions) and total-response counts.
  const perStaff = new Map<string, { firstResponses: number; responses: number }>();
  for (const id of staffIds) perStaff.set(id, { firstResponses: 0, responses: 0 });
  for (const qrow of questions) {
    if (qrow.first_responder_id) {
      const e = perStaff.get(qrow.first_responder_id) ?? { firstResponses: 0, responses: 0 };
      e.firstResponses += 1;
      perStaff.set(qrow.first_responder_id, e);
    }
  }
  if (params.includePerStaffBreakdown !== false) {
    for (const r of store.getStaffResponseCounts(
      params.guildId,
      period.startUtc,
      period.endUtcExclusive,
      {
        channelIds: params.channelIds,
        staffIds,
      },
    )) {
      const e = perStaff.get(r.author_id) ?? { firstResponses: 0, responses: 0 };
      e.responses = r.responses;
      perStaff.set(r.author_id, e);
    }
  }

  // Per-channel breakdown.
  const perChannel = new Map<string, QuestionResponseRow[]>();
  for (const q of questions) {
    const list = perChannel.get(q.channel_id) ?? [];
    list.push(q);
    perChannel.set(q.channel_id, list);
  }

  return {
    period,
    responseWindowHours: windowHours,
    staffUserIds: staffIds,
    ...stats,
    perStaff:
      params.includePerStaffBreakdown === false
        ? undefined
        : [...perStaff.entries()].map(([userId, v]) => ({
            userId,
            firstResponses: v.firstResponses,
            responses: v.responses,
          })),
    perChannel:
      params.includeChannelBreakdown === false
        ? undefined
        : [...perChannel.entries()].map(([channelId, list]) => {
            const s = computeResponseStats(list, windowSeconds);
            return {
              channelId,
              totalQuestions: s.totalQuestions,
              questionsWithResponse: s.questionsWithResponse,
              questionsWithinWindow: s.questionsWithinWindow,
              medianFirstResponseSeconds: s.medianFirstResponseSeconds,
            };
          }),
    methodology: {
      candidateQuestion:
        "Member message with '?' or a known question phrase (requires stored content).",
      staffResponse:
        "A staff direct reply, a staff post in a thread started from the question, or a staff post in the same thread.",
      responseTime: "Seconds from the question to the first staff response.",
      note: "Rates return null when there are no eligible questions.",
    },
    limitations: limitations.list(),
  };
}
