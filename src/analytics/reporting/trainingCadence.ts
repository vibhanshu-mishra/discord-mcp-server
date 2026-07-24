/**
 * Training cadence report: for each resource channel and calendar week in the
 * range, whether at least one probable training/resource post was made. A post
 * qualifies when made by a configured staff author AND it has an attachment, an http(s) link,
 * or a configured training keyword.
 */
import { buildPeriod, Limitations, type ReportContext } from "./types.js";
import { resolveWeek } from "./dateRange.js";
import { ratio } from "./stats.js";
import type { TrainingPostRow } from "./store.js";

export interface TrainingCadenceParams {
  guildId: string;
  startDate: string;
  endDate: string;
  resourceChannelIds?: string[];
  staffUserIds?: string[];
  includePostEvidence?: boolean;
}

interface WeekBound {
  weekStart: string;
  weekEnd: string;
  startUtc: string;
  endUtcExclusive: string;
}

/** Enumerates the weeks (by configured week-start) overlapping the local range. */
function weeksInRange(
  startDate: string,
  endDate: string,
  tz: string,
  weekStart: "MONDAY" | "SUNDAY",
): WeekBound[] {
  const weeks: WeekBound[] = [];
  let cursor = resolveWeek(startDate, tz, weekStart);
  // Guard against pathological ranges.
  for (let i = 0; i < 520 && cursor.localStartDate <= endDate; i++) {
    weeks.push({
      weekStart: cursor.localStartDate,
      weekEnd: cursor.localEndDate,
      startUtc: cursor.startUtc,
      endUtcExclusive: cursor.endUtcExclusive,
    });
    cursor = resolveWeek(addDaysLocal(cursor.localStartDate, 7), tz, weekStart);
  }
  return weeks;
}

function addDaysLocal(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function reasons(p: TrainingPostRow): string[] {
  const out: string[] = [];
  if (p.has_attachment) out.push("attachment");
  if (p.has_link) out.push("link");
  if (p.has_keyword) out.push("keyword");
  return out;
}

export function buildTrainingCadence(ctx: ReportContext, params: TrainingCadenceParams) {
  const { store, reporting } = ctx;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const channelIds = params.resourceChannelIds?.length
    ? params.resourceChannelIds
    : reporting.resourceChannelIds;
  const staffIds = params.staffUserIds?.length ? params.staffUserIds : reporting.staffUserIds;

  const limitations = new Limitations();
  limitations.addIf(
    channelIds.length === 0,
    "No resource channels are configured; nothing can be evaluated.",
  );
  limitations.addIf(
    staffIds.length === 0,
    "No staff user IDs are configured; no post can qualify.",
  );
  limitations.addIf(
    !store.storeContent,
    "Message content storage is disabled: link and keyword detection are unavailable; only attachments qualify.",
  );

  const posts = store.getTrainingPosts(params.guildId, period.startUtc, period.endUtcExclusive, {
    channelIds,
    staffIds,
    keywords: reporting.trainingKeywords,
  });
  const weeks = weeksInRange(
    params.startDate,
    params.endDate,
    reporting.timezone,
    reporting.weekStart,
  );

  const cells = [];
  let completed = 0;
  for (const w of weeks) {
    for (const channelId of channelIds) {
      const qualifying = posts.filter(
        (p) =>
          p.channel_id === channelId &&
          p.created_at >= w.startUtc &&
          p.created_at < w.endUtcExclusive,
      );
      const hasTraining = qualifying.length > 0;
      if (hasTraining) completed += 1;
      cells.push({
        weekStart: w.weekStart,
        weekEnd: w.weekEnd,
        channelId,
        channelName: qualifying[0]?.channel_name ?? null,
        qualifyingPostCount: qualifying.length,
        hasProbableTraining: hasTraining,
        missing: !hasTraining,
        ...(params.includePostEvidence === false
          ? {}
          : {
              postIds: qualifying.map((p) => p.message_id),
              postTimestamps: qualifying.map((p) => p.created_at),
              authorIds: qualifying.map((p) => p.author_id),
              detectionReasons: qualifying.map((p) => reasons(p)),
            }),
      });
    }
  }

  const expected = weeks.length * channelIds.length;
  return {
    period,
    weekStart: reporting.weekStart,
    resourceChannelIds: channelIds,
    expectedChannelWeeks: expected,
    completedChannelWeeks: completed,
    missingChannelWeeks: expected - completed,
    cadence: ratio(completed, expected),
    weeks: cells,
    methodology: {
      qualifyingPost:
        "Posted by a configured staff author in a resource channel with an attachment, an http(s) link, or a training keyword.",
      cadence:
        "Completed channel-weeks divided by expected channel-weeks (null when expected is zero).",
    },
    limitations: limitations.list(),
  };
}
