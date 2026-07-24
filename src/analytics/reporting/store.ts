/**
 * Reporting data access: every Phase 3 report's SQL lives here, in one place,
 * fully parameterised (IDs and dates are always bound, never concatenated). The
 * store issues SELECTs only — it never writes. Aggregation happens in SQLite;
 * only bounded result sets (e.g. per-member rows, response-time lists) reach
 * application memory.
 */
import type { DatabaseSync } from "node:sqlite";
import { QUESTION_PHRASES } from "./questions.js";

type Bind = string | number | null;

/** Fragment plus the parameters it binds, spliced into a larger statement. */
interface Frag {
  sql: string;
  params: Bind[];
}

/** `col IN (?, ?, …)` — or a constant when the list is empty. `emptyValue` is the
 * SQL used for an empty list: "1" (match all) for filters, "0" (match none) for
 * required sets like staff. */
function inList(col: string, ids: string[], emptyValue: "1" | "0"): Frag {
  if (ids.length === 0) return { sql: emptyValue, params: [] };
  return { sql: `${col} IN (${ids.map(() => "?").join(",")})`, params: [...ids] };
}

export interface EngagementOptions {
  channelIds?: string[];
  memberIds?: string[];
  includeBots?: boolean;
  staffIds: string[];
}

export interface MemberEngagementRow {
  user_id: string;
  username: string | null;
  display_name: string | null;
  is_bot: number;
  messages: number;
  active_days: number;
  distinct_channels: number;
  replies_sent: number;
  unique_replied_to: number;
  replies_received: number;
  unique_repliers: number;
  reactions_received: number;
  questions_asked: number;
  unanswered_questions: number;
  first_activity: string | null;
  last_activity: string | null;
}

export interface QuestionResponseRow {
  message_id: string;
  channel_id: string;
  parent_channel_id: string | null;
  author_id: string | null;
  created_at: string;
  is_thread: number;
  first_response_at: string | null;
  first_responder_id: string | null;
}

export interface UnansweredRow extends QuestionResponseRow {
  username: string | null;
  display_name: string | null;
  direct_replies: number;
  staff_replies: number;
  has_staff_reaction: number;
  content: string | null;
}

export interface UnacknowledgedRow {
  message_id: string;
  channel_id: string;
  author_id: string | null;
  username: string | null;
  display_name: string | null;
  created_at: string;
  is_question: number;
  attachment_count: number;
  direct_replies: number;
  staff_reactions: number;
  staff_thread_responses: number;
  content: string | null;
}

export interface TrainingPostRow {
  message_id: string;
  channel_id: string;
  channel_name: string | null;
  author_id: string | null;
  created_at: string;
  has_attachment: number;
  has_link: number;
  has_keyword: number;
}

export interface VoiceSessionReportRow {
  session_id: string;
  channel_id: string;
  user_id: string;
  user_is_bot: number;
  joined_at: string;
  left_at: string | null;
  duration_seconds: number | null;
  is_incomplete: number;
}

export class ReportingStore {
  constructor(
    private readonly db: DatabaseSync,
    /** Whether readable message content is stored (affects content-based heuristics). */
    public readonly storeContent: boolean,
  ) {}

  private all<T>(sql: string, params: Bind[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private get<T>(sql: string, params: Bind[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  /** SQL that is true when message `alias` looks like a candidate question. */
  private questionFrag(alias: string): Frag {
    const phraseOrs = QUESTION_PHRASES.map(() => `lower(${alias}.content) LIKE ?`).join(" OR ");
    return {
      sql: `(${alias}.content IS NOT NULL AND (${alias}.content LIKE '%?%' OR ${phraseOrs}))`,
      params: QUESTION_PHRASES.map((p) => `%${p}%`),
    };
  }

  /**
   * SQL that is true when a staff response to question `q` exists: a direct reply,
   * a staff post in a thread started from the question, or a staff post in the
   * same channel when that channel is a thread. Requires `channels qc` joined on
   * `qc.channel_id = q.channel_id`. When `windowHours` is given, the response must
   * fall within that many hours of the message (per-message, via julianday so ISO
   * timestamps with 'Z'/milliseconds compare correctly).
   */
  private staffResponseExists(q: string, staffIds: string[], windowHours?: number): Frag {
    const staff = inList("s.author_id", staffIds, "0");
    const params: Bind[] = [...staff.params];
    let windowClause = "";
    if (windowHours !== undefined) {
      windowClause = `AND julianday(s.created_at) <= julianday(${q}.created_at) + (? / 24.0)`;
      params.push(windowHours);
    }
    return {
      sql: `EXISTS (
        SELECT 1 FROM messages s
        WHERE s.is_deleted = 0 AND ${staff.sql}
          AND s.created_at > ${q}.created_at ${windowClause}
          AND (
            s.referenced_message_id = ${q}.message_id
            OR s.channel_id = ${q}.message_id
            OR (s.channel_id = ${q}.channel_id AND qc.is_thread = 1)
          )
      )`,
      params,
    };
  }

  /** Per-member engagement rows, fully merged (one query set, no N+1). */
  getMemberEngagement(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    offsetSeconds: number,
    opts: EngagementOptions,
  ): MemberEngagementRow[] {
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const memb = inList("m.author_id", opts.memberIds ?? [], "1");
    const botClause = opts.includeBots ? "1" : "m.author_is_bot = 0";
    const range: Bind[] = [guildId, startUtc, endExclusive];

    // Base activity + meta (LEFT JOIN members for current name/bot flag).
    const base = this.all<MemberEngagementRow>(
      `SELECT m.author_id AS user_id,
              mem.username AS username, mem.display_name AS display_name,
              COALESCE(mem.is_bot, m.author_is_bot) AS is_bot,
              COUNT(*) AS messages,
              COUNT(DISTINCT date(m.created_at, ? || ' seconds')) AS active_days,
              COUNT(DISTINCT m.channel_id) AS distinct_channels,
              MIN(m.created_at) AS first_activity,
              MAX(m.created_at) AS last_activity,
              0 AS replies_sent, 0 AS unique_replied_to,
              0 AS replies_received, 0 AS unique_repliers,
              0 AS reactions_received, 0 AS questions_asked, 0 AS unanswered_questions
         FROM messages m
         LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = m.author_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_id IS NOT NULL
          AND ${botClause} AND ${chan.sql} AND ${memb.sql}
        GROUP BY m.author_id`,
      [offsetSeconds, ...range, ...chan.params, ...memb.params],
    );
    const byId = new Map(base.map((r) => [r.user_id, r]));

    // Replies sent + unique members replied to.
    const sent = this.all<{ user_id: string; replies_sent: number; unique_replied_to: number }>(
      `SELECT r.author_id AS user_id, COUNT(*) AS replies_sent,
              COUNT(DISTINCT orig.author_id) AS unique_replied_to
         FROM messages r JOIN messages orig ON r.referenced_message_id = orig.message_id
        WHERE r.guild_id = ? AND r.created_at >= ? AND r.created_at < ?
          AND r.is_deleted = 0 AND r.referenced_message_id IS NOT NULL
          AND ${inList("r.channel_id", opts.channelIds ?? [], "1").sql}
        GROUP BY r.author_id`,
      [...range, ...(opts.channelIds ?? [])],
    );
    for (const r of sent) {
      const row = byId.get(r.user_id);
      if (row) {
        row.replies_sent = r.replies_sent;
        row.unique_replied_to = r.unique_replied_to;
      }
    }

    // Replies received (grouped by the ORIGINAL author) + unique repliers.
    const recv = this.all<{ user_id: string; replies_received: number; unique_repliers: number }>(
      `SELECT orig.author_id AS user_id, COUNT(*) AS replies_received,
              COUNT(DISTINCT r.author_id) AS unique_repliers
         FROM messages r JOIN messages orig ON r.referenced_message_id = orig.message_id
        WHERE r.guild_id = ? AND r.created_at >= ? AND r.created_at < ?
          AND r.is_deleted = 0 AND r.referenced_message_id IS NOT NULL
        GROUP BY orig.author_id`,
      [...range],
    );
    for (const r of recv) {
      const row = byId.get(r.user_id);
      if (row) {
        row.replies_received = r.replies_received;
        row.unique_repliers = r.unique_repliers;
      }
    }

    // Reactions received on messages authored in range.
    const react = this.all<{ user_id: string; reactions_received: number }>(
      `SELECT m.author_id AS user_id, COUNT(*) AS reactions_received
         FROM reactions rx JOIN messages m ON rx.message_id = m.message_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND ${chan.sql}
        GROUP BY m.author_id`,
      [...range, ...chan.params],
    );
    for (const r of react) {
      const row = byId.get(r.user_id);
      if (row) row.reactions_received = r.reactions_received;
    }

    // Candidate questions asked + how many remain unanswered (non-staff authors).
    const q = this.questionFrag("m");
    const resp = this.staffResponseExists("m", opts.staffIds);
    const nonStaff = inList("m.author_id", opts.staffIds, "0"); // author IS staff → exclude
    const qStats = this.all<{
      user_id: string;
      questions_asked: number;
      unanswered_questions: number;
    }>(
      `SELECT m.author_id AS user_id,
              COUNT(*) AS questions_asked,
              SUM(CASE WHEN ${resp.sql} THEN 0 ELSE 1 END) AS unanswered_questions
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${q.sql} AND ${chan.sql} AND ${memb.sql}
        GROUP BY m.author_id`,
      // Placeholder order: SELECT resp, then WHERE guild/start/end, nonStaff, q, chan, memb.
      [...resp.params, ...range, ...nonStaff.params, ...q.params, ...chan.params, ...memb.params],
    );
    for (const r of qStats) {
      const row = byId.get(r.user_id);
      if (row) {
        row.questions_asked = r.questions_asked;
        row.unanswered_questions = r.unanswered_questions;
      }
    }

    return [...byId.values()];
  }

  /** Candidate questions (member-authored) with their first staff response. */
  getCandidateQuestions(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: { channelIds?: string[]; memberIds?: string[]; staffIds: string[] },
  ): QuestionResponseRow[] {
    const q = this.questionFrag("m");
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const memb = inList("m.author_id", opts.memberIds ?? [], "1");
    const nonStaff = inList("m.author_id", opts.staffIds, "0");
    const firstAt = this.staffFirstResponse(
      "first_response_at",
      opts.staffIds,
      "MIN(s.created_at)",
    );
    const firstBy = this.staffFirstResponse(
      "first_responder_id",
      opts.staffIds,
      "s.author_id",
      true,
    );
    return this.all<QuestionResponseRow>(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.created_at,
              COALESCE(qc.is_thread, 0) AS is_thread,
              ${firstAt.sql} AS first_response_at,
              ${firstBy.sql} AS first_responder_id
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${q.sql} AND ${chan.sql} AND ${memb.sql}
        ORDER BY m.created_at ASC`,
      [
        ...firstAt.params,
        ...firstBy.params,
        guildId,
        startUtc,
        endExclusive,
        ...nonStaff.params,
        ...q.params,
        ...chan.params,
        ...memb.params,
      ],
    );
  }

  /** Correlated subquery selecting the first staff response's timestamp or author. */
  private staffFirstResponse(
    _label: string,
    staffIds: string[],
    selectExpr: string,
    ordered = false,
  ): Frag {
    const staff = inList("s.author_id", staffIds, "0");
    const tail = ordered ? "ORDER BY s.created_at ASC LIMIT 1" : "";
    return {
      sql: `(SELECT ${selectExpr} FROM messages s
              WHERE s.is_deleted = 0 AND ${staff.sql} AND s.created_at > m.created_at
                AND (s.referenced_message_id = m.message_id OR s.channel_id = m.message_id
                     OR (s.channel_id = m.channel_id AND qc.is_thread = 1))
              ${tail})`,
      params: [...staff.params],
    };
  }

  /** Per-staff count of candidate questions they responded to (any response). */
  getStaffResponseCounts(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: { channelIds?: string[]; staffIds: string[] },
  ): { author_id: string; responses: number }[] {
    if (opts.staffIds.length === 0) return [];
    const q = this.questionFrag("m");
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const staff = inList("s.author_id", opts.staffIds, "0");
    const nonStaff = inList("m.author_id", opts.staffIds, "0");
    return this.all<{ author_id: string; responses: number }>(
      `SELECT s.author_id, COUNT(DISTINCT m.message_id) AS responses
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
         JOIN messages s ON s.is_deleted = 0 AND ${staff.sql} AND s.created_at > m.created_at
              AND (s.referenced_message_id = m.message_id OR s.channel_id = m.message_id
                   OR (s.channel_id = m.channel_id AND qc.is_thread = 1))
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${q.sql} AND ${chan.sql}
        GROUP BY s.author_id`,
      [
        ...staff.params,
        guildId,
        startUtc,
        endExclusive,
        ...nonStaff.params,
        ...q.params,
        ...chan.params,
      ],
    );
  }

  /** Open (unanswered) candidate questions with reply/reaction detail. */
  getUnansweredQuestions(
    guildId: string,
    startUtc: string | null,
    endExclusive: string | null,
    opts: {
      channelIds?: string[];
      memberIds?: string[];
      staffIds: string[];
      responseWindowIso?: string; // upper bound for "answered within window"
      olderThanIso: string; // created_at must be <= this (minimum age)
      limit: number;
    },
  ): UnansweredRow[] {
    const q = this.questionFrag("m");
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const memb = inList("m.author_id", opts.memberIds ?? [], "1");
    const nonStaff = inList("m.author_id", opts.staffIds, "0");
    const anyResp = this.staffResponseExists("m", opts.staffIds);
    const staffReplies = this.staffFirstResponse("x", opts.staffIds, "COUNT(*)");
    const rangeClauses: string[] = [];
    const rangeParams: Bind[] = [];
    if (startUtc) {
      rangeClauses.push("m.created_at >= ?");
      rangeParams.push(startUtc);
    }
    if (endExclusive) {
      rangeClauses.push("m.created_at < ?");
      rangeParams.push(endExclusive);
    }
    return this.all<UnansweredRow>(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.created_at,
              COALESCE(qc.is_thread, 0) AS is_thread,
              mem.username AS username, mem.display_name AS display_name,
              ${this.storeContent ? "m.content" : "NULL"} AS content,
              (SELECT COUNT(*) FROM messages dr WHERE dr.referenced_message_id = m.message_id AND dr.is_deleted = 0) AS direct_replies,
              ${staffReplies.sql} AS staff_replies,
              (SELECT CASE WHEN EXISTS (SELECT 1 FROM reactions rx WHERE rx.message_id = m.message_id
                     AND ${inList("rx.user_id", opts.staffIds, "0").sql}) THEN 1 ELSE 0 END) AS has_staff_reaction,
              NULL AS first_response_at, NULL AS first_responder_id
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
         LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = m.author_id
        WHERE m.guild_id = ? AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${q.sql} AND ${chan.sql} AND ${memb.sql}
          AND m.created_at <= ?
          ${rangeClauses.length ? "AND " + rangeClauses.join(" AND ") : ""}
          AND NOT (${anyResp.sql})
        ORDER BY m.created_at ASC
        LIMIT ?`,
      [
        ...staffReplies.params,
        ...inList("rx.user_id", opts.staffIds, "0").params,
        guildId,
        ...nonStaff.params,
        ...q.params,
        ...chan.params,
        ...memb.params,
        opts.olderThanIso,
        ...rangeParams,
        ...anyResp.params,
        opts.limit,
      ],
    );
  }

  /** Candidate unacknowledged member messages with acknowledgement signals. */
  getUnacknowledgedMessages(
    guildId: string,
    startUtc: string | null,
    endExclusive: string | null,
    opts: {
      channelIds?: string[];
      memberIds?: string[];
      staffIds: string[];
      olderThanIso: string;
      ackWindowHours: number; // acknowledgements only count within this many hours
      filter: "questions" | "attachments" | "all";
      limit: number;
    },
  ): UnacknowledgedRow[] {
    const q = this.questionFrag("m");
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const memb = inList("m.author_id", opts.memberIds ?? [], "1");
    const nonStaff = inList("m.author_id", opts.staffIds, "0");
    const ackResp = this.staffResponseExists("m", opts.staffIds, opts.ackWindowHours);
    const staffReact = inList("rx.user_id", opts.staffIds, "0");
    const staffDr = inList("dr.author_id", opts.staffIds, "0");
    // A staff reaction within the window is also an acknowledgement (reaction time
    // approximated by observed_at; julianday parses ISO 'Z'/millisecond stamps).
    const ackReactStaff = inList("rx2.user_id", opts.staffIds, "0");
    const ackReactSql = `EXISTS (SELECT 1 FROM reactions rx2 WHERE rx2.message_id = m.message_id
      AND ${ackReactStaff.sql}
      AND julianday(rx2.observed_at) <= julianday(m.created_at) + (? / 24.0))`;
    const ackReactParams: Bind[] = [...ackReactStaff.params, opts.ackWindowHours];

    let filterClause = "1";
    if (opts.filter === "questions") filterClause = q.sql;
    else if (opts.filter === "attachments") filterClause = "m.attachment_count > 0";

    const rangeClauses: string[] = [];
    const rangeParams: Bind[] = [];
    if (startUtc) {
      rangeClauses.push("m.created_at >= ?");
      rangeParams.push(startUtc);
    }
    if (endExclusive) {
      rangeClauses.push("m.created_at < ?");
      rangeParams.push(endExclusive);
    }

    return this.all<UnacknowledgedRow>(
      `SELECT m.message_id, m.channel_id, m.author_id, m.created_at, m.attachment_count,
              mem.username AS username, mem.display_name AS display_name,
              ${this.storeContent ? "m.content" : "NULL"} AS content,
              CASE WHEN ${q.sql} THEN 1 ELSE 0 END AS is_question,
              (SELECT COUNT(*) FROM messages dr WHERE dr.referenced_message_id = m.message_id
                 AND dr.is_deleted = 0 AND ${staffDr.sql}) AS direct_replies,
              (SELECT COUNT(*) FROM reactions rx WHERE rx.message_id = m.message_id
                 AND ${staffReact.sql}) AS staff_reactions,
              0 AS staff_thread_responses
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
         LEFT JOIN members mem ON mem.guild_id = m.guild_id AND mem.user_id = m.author_id
        WHERE m.guild_id = ? AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${filterClause} AND ${chan.sql} AND ${memb.sql}
          AND m.created_at <= ?
          ${rangeClauses.length ? "AND " + rangeClauses.join(" AND ") : ""}
          AND NOT (${ackResp.sql} OR ${ackReactSql})
        ORDER BY m.created_at ASC
        LIMIT ?`,
      [
        // SELECT-clause params, in order of appearance:
        ...q.params, // is_question CASE
        ...staffDr.params, // staff direct replies subquery
        ...staffReact.params, // staff reactions subquery
        // WHERE-clause params:
        guildId,
        ...nonStaff.params,
        ...(opts.filter === "questions" ? q.params : []),
        ...chan.params,
        ...memb.params,
        opts.olderThanIso,
        ...rangeParams,
        ...ackResp.params,
        ...ackReactParams,
        opts.limit,
      ],
    );
  }

  /** Qualifying training/resource posts in the given channels (with reasons). */
  getTrainingPosts(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: { channelIds: string[]; staffIds: string[]; keywords: string[] },
  ): TrainingPostRow[] {
    if (opts.channelIds.length === 0 || opts.staffIds.length === 0) return [];
    const chan = inList("m.channel_id", opts.channelIds, "0");
    const author = inList("m.author_id", opts.staffIds, "0");
    const kwOrs = opts.keywords.map(() => "lower(m.content) LIKE ?").join(" OR ") || "0";
    const kwParams = opts.keywords.map((k) => `%${k}%`);
    const linkSql = this.storeContent
      ? "(m.content LIKE '%http://%' OR m.content LIKE '%https://%')"
      : "0";
    const kwSql = this.storeContent ? `(m.content IS NOT NULL AND (${kwOrs}))` : "0";
    return this.all<TrainingPostRow>(
      `SELECT m.message_id, m.channel_id, ch.name AS channel_name, m.author_id, m.created_at,
              CASE WHEN m.attachment_count > 0 THEN 1 ELSE 0 END AS has_attachment,
              CASE WHEN ${linkSql} THEN 1 ELSE 0 END AS has_link,
              CASE WHEN ${kwSql} THEN 1 ELSE 0 END AS has_keyword
         FROM messages m
         LEFT JOIN channels ch ON ch.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND ${chan.sql} AND ${author.sql}
          AND (m.attachment_count > 0 OR ${linkSql} OR ${kwSql})
        ORDER BY m.created_at ASC`,
      [
        ...(this.storeContent ? kwParams : []), // has_keyword SELECT
        guildId,
        startUtc,
        endExclusive,
        ...chan.params,
        ...author.params,
        ...(this.storeContent ? kwParams : []), // WHERE keyword
      ],
    );
  }

  /** Office-hour voice sessions joined within the range in the given channels. */
  getOfficeHourSessions(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: { channelIds: string[]; excludeStaffIds?: string[]; includeIncomplete: boolean },
  ): VoiceSessionReportRow[] {
    if (opts.channelIds.length === 0) return [];
    const chan = inList("channel_id", opts.channelIds, "0");
    const clauses = [
      "guild_id = ?",
      "joined_at >= ?",
      "joined_at < ?",
      "user_is_bot = 0",
      chan.sql,
    ];
    const params: Bind[] = [guildId, startUtc, endExclusive, ...chan.params];
    if (!opts.includeIncomplete) clauses.push("is_incomplete = 0");
    if (opts.excludeStaffIds?.length) {
      const ex = inList("user_id", opts.excludeStaffIds, "1");
      clauses.push(`NOT (${ex.sql})`);
      params.push(...ex.params);
    }
    return this.all<VoiceSessionReportRow>(
      `SELECT session_id, channel_id, user_id, user_is_bot, joined_at, left_at,
              duration_seconds, is_incomplete
         FROM voice_sessions
        WHERE ${clauses.join(" AND ")}
        ORDER BY joined_at ASC`,
      params,
    );
  }

  /** User IDs with an office-hour session BEFORE `beforeUtc` (for first-time calc). */
  getPriorVoiceAttendees(guildId: string, channelIds: string[], beforeUtc: string): Set<string> {
    if (channelIds.length === 0) return new Set();
    const chan = inList("channel_id", channelIds, "0");
    const rows = this.all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM voice_sessions
        WHERE guild_id = ? AND user_is_bot = 0 AND joined_at < ? AND ${chan.sql}`,
      [guildId, beforeUtc, ...chan.params],
    );
    return new Set(rows.map((r) => r.user_id));
  }

  /** Earliest stored voice join for the given channels (history-availability check). */
  getEarliestVoiceJoin(guildId: string, channelIds: string[]): string | null {
    if (channelIds.length === 0) return null;
    const chan = inList("channel_id", channelIds, "0");
    const row = this.get<{ t: string | null }>(
      `SELECT MIN(joined_at) AS t FROM voice_sessions WHERE guild_id = ? AND ${chan.sql}`,
      [guildId, ...chan.params],
    );
    return row?.t ?? null;
  }

  /** Current member/current username lookups for a set of IDs (bounded). */
  getMemberMeta(
    guildId: string,
    userIds: string[],
  ): Map<string, { username: string | null; display_name: string | null; is_bot: number }> {
    if (userIds.length === 0) return new Map();
    const inClause = inList("user_id", userIds, "0");
    const rows = this.all<{
      user_id: string;
      username: string | null;
      display_name: string | null;
      is_bot: number;
    }>(
      `SELECT user_id, username, display_name, is_bot FROM members
        WHERE guild_id = ? AND ${inClause.sql}`,
      [guildId, ...inClause.params],
    );
    return new Map(rows.map((r) => [r.user_id, r]));
  }

  /**
   * Community activity aggregates for a range: per active non-staff member, their
   * message count and their earliest-ever stored message (for new vs returning).
   */
  getActiveMembers(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    staffIds: string[],
  ): { user_id: string; messages: number; first_ever: string }[] {
    const nonStaff = inList("m.author_id", staffIds, "0");
    return this.all<{ user_id: string; messages: number; first_ever: string }>(
      `SELECT m.author_id AS user_id, COUNT(*) AS messages,
              (SELECT MIN(g.created_at) FROM messages g
                 WHERE g.guild_id = m.guild_id AND g.author_id = m.author_id AND g.is_deleted = 0) AS first_ever
         FROM messages m
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
        GROUP BY m.author_id`,
      [guildId, startUtc, endExclusive, ...nonStaff.params],
    );
  }

  /** Simple totals for a range: total messages by staff vs members, distinct channels. */
  getMessageTotals(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    staffIds: string[],
  ): { staffMessages: number; memberMessages: number; distinctChannels: number } {
    const staff = inList("author_id", staffIds, "0");
    const row = this.get<{ staff: number; member: number; channels: number }>(
      `SELECT
          SUM(CASE WHEN ${staff.sql} THEN 1 ELSE 0 END) AS staff,
          SUM(CASE WHEN author_is_bot = 0 AND NOT (${staff.sql}) THEN 1 ELSE 0 END) AS member,
          COUNT(DISTINCT channel_id) AS channels
         FROM messages
        WHERE guild_id = ? AND created_at >= ? AND created_at < ? AND is_deleted = 0`,
      [...staff.params, ...staff.params, guildId, startUtc, endExclusive],
    );
    return {
      staffMessages: row?.staff ?? 0,
      memberMessages: row?.member ?? 0,
      distinctChannels: row?.channels ?? 0,
    };
  }

  /** A user's reactions given and received in a range. */
  getReactionTotals(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    userId: string,
  ): { given: number; received: number } {
    const given = this.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM reactions rx JOIN messages m ON rx.message_id = m.message_id
        WHERE rx.user_id = ? AND m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?`,
      [userId, guildId, startUtc, endExclusive],
    );
    const received = this.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM reactions rx JOIN messages m ON rx.message_id = m.message_id
        WHERE m.guild_id = ? AND m.author_id = ? AND m.created_at >= ? AND m.created_at < ?`,
      [guildId, userId, startUtc, endExclusive],
    );
    return { given: given?.c ?? 0, received: received?.c ?? 0 };
  }

  /** Daily message counts for a user (tz-bucketed via offsetSeconds). */
  getDailyMessageCounts(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    userId: string,
    offsetSeconds: number,
  ): { day: string; count: number }[] {
    return this.all<{ day: string; count: number }>(
      `SELECT date(created_at, ? || ' seconds') AS day, COUNT(*) AS count
         FROM messages
        WHERE guild_id = ? AND author_id = ? AND created_at >= ? AND created_at < ? AND is_deleted = 0
        GROUP BY day ORDER BY day ASC`,
      [offsetSeconds, guildId, userId, startUtc, endExclusive],
    );
  }

  /** Per-channel message counts for a user (with channel names). */
  getChannelMessageCounts(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    userId: string,
  ): { channel_id: string; channel_name: string | null; count: number }[] {
    return this.all<{ channel_id: string; channel_name: string | null; count: number }>(
      `SELECT m.channel_id, ch.name AS channel_name, COUNT(*) AS count
         FROM messages m LEFT JOIN channels ch ON ch.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.author_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0
        GROUP BY m.channel_id ORDER BY count DESC`,
      [guildId, userId, startUtc, endExclusive],
    );
  }
}
