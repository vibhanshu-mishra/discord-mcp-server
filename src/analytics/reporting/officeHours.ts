/**
 * Office-hour attendance report over the configured voice channels. Attendance is
 * only ever counted from sessions observed while the bot was online; first-time
 * status depends on whether earlier stored history exists, and that availability
 * is reported so nobody is falsely labelled a first-timer.
 */
import { buildPeriod, Limitations, type ReportContext } from "./types.js";
import { localDateOf } from "./dateRange.js";
import { mean, median } from "./stats.js";
import type { VoiceSessionReportRow } from "./store.js";

export interface OfficeHourParams {
  guildId: string;
  startDate: string;
  endDate: string;
  voiceChannelIds?: string[];
  excludeStaff?: boolean;
  includeIncompleteSessions?: boolean;
  includeMemberBreakdown?: boolean;
  includeDailyBreakdown?: boolean;
}

export function buildOfficeHourMetrics(ctx: ReportContext, params: OfficeHourParams) {
  const { store, reporting } = ctx;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const channelIds = params.voiceChannelIds?.length
    ? params.voiceChannelIds
    : reporting.officeHourChannelIds;
  const excludeStaff = params.excludeStaff ?? true;
  const includeIncomplete = params.includeIncompleteSessions ?? true;

  const limitations = new Limitations();
  limitations.addIf(channelIds.length === 0, "No office-hour voice channels are configured.");
  limitations.add(
    "Voice attendance exists only from when collection began; earlier attendance cannot be recovered.",
  );

  const sessions: VoiceSessionReportRow[] = store.getOfficeHourSessions(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds,
      excludeStaffIds: excludeStaff ? reporting.staffUserIds : undefined,
      includeIncomplete,
    },
  );

  const prior = store.getPriorVoiceAttendees(params.guildId, channelIds, period.startUtc);
  const earliestVoice = store.getEarliestVoiceJoin(params.guildId, channelIds);
  const historyAvailableBeforeRange = earliestVoice !== null && earliestVoice < period.startUtc;

  // Per-attendee tallies.
  const perMember = new Map<string, { sessions: number; seconds: number }>();
  const durations: number[] = [];
  let incomplete = 0;
  let totalSeconds = 0;
  const byDay = new Map<string, number>();
  const byChannel = new Map<string, number>();

  for (const s of sessions) {
    const m = perMember.get(s.user_id) ?? { sessions: 0, seconds: 0 };
    m.sessions += 1;
    if (s.is_incomplete === 1 || s.duration_seconds === null) {
      incomplete += 1;
    } else {
      m.seconds += s.duration_seconds;
      totalSeconds += s.duration_seconds;
      durations.push(s.duration_seconds);
    }
    perMember.set(s.user_id, m);
    const day = localDateOf(new Date(s.joined_at), reporting.timezone);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    byChannel.set(s.channel_id, (byChannel.get(s.channel_id) ?? 0) + 1);
  }

  const attendees = [...perMember.keys()];
  const firstTime = attendees.filter((id) => !prior.has(id));
  const repeat = attendees.filter((id) => prior.has(id) || (perMember.get(id)?.sessions ?? 0) > 1);

  return {
    period,
    voiceChannelIds: channelIds,
    excludeStaff,
    totalSessions: sessions.length,
    uniqueAttendees: attendees.length,
    firstTimeAttendees: firstTime.length,
    repeatAttendees: repeat.length,
    firstTimeConfidence: {
      historyAvailableBeforeRange,
      note: historyAvailableBeforeRange
        ? "Earlier stored voice history exists, so first-time status is reliable."
        : "No stored voice history before the range; first-time counts may be overstated.",
      earliestStoredVoiceJoin: earliestVoice,
    },
    totalAttendanceSeconds: totalSeconds,
    totalAttendanceMinutes: Math.round((totalSeconds / 60) * 100) / 100,
    averageSessionSeconds: mean(durations),
    medianSessionSeconds: median(durations),
    longestSessionSeconds: durations.length ? Math.max(...durations) : null,
    incompleteSessionCount: incomplete,
    dailyBreakdown:
      params.includeDailyBreakdown === false
        ? undefined
        : [...byDay.entries()].sort().map(([day, count]) => ({ day, sessions: count })),
    channelBreakdown: [...byChannel.entries()].map(([channelId, count]) => ({
      channelId,
      sessions: count,
    })),
    memberBreakdown:
      params.includeMemberBreakdown === false
        ? undefined
        : attendees.map((id) => ({
            memberId: id,
            sessions: perMember.get(id)!.sessions,
            attendanceSeconds: perMember.get(id)!.seconds,
            firstTimeInRange: !prior.has(id),
          })),
    methodology: {
      attendee: "A non-bot user with a stored voice session in a configured office-hour channel.",
      firstTime:
        "An attendee with no earlier stored session in these channels (subject to history availability).",
      note: "Incomplete sessions (unknown leave time) are counted but excluded from duration statistics.",
    },
    limitations: limitations.list(),
  };
}
