/**
 * Read-only data access for qualitative analysis. Every query is a parameterised
 * SELECT — this store never writes. IDs, dates, and channel lists are always
 * bound, never concatenated. Content columns are only selected when message
 * content is actually stored; otherwise NULL is returned so nothing downstream
 * can fabricate text.
 */
import type { DatabaseSync } from "node:sqlite";
import { QUESTION_PHRASES } from "../reporting/questions.js";
import type { AnalysisMessageRow, CandidateQuestionRow } from "./types.js";

type Bind = string | number | null;

interface Frag {
  sql: string;
  params: Bind[];
}

/** `col IN (?, …)` — or a constant when the list is empty ("1"=all, "0"=none). */
function inList(col: string, ids: string[], empty: "1" | "0"): Frag {
  if (ids.length === 0) return { sql: empty, params: [] };
  return { sql: `${col} IN (${ids.map(() => "?").join(",")})`, params: [...ids] };
}

/** `col NOT IN (…)` — or "1" (no exclusion) when the list is empty. */
function notInList(col: string, ids: string[]): Frag {
  if (ids.length === 0) return { sql: "1", params: [] };
  return { sql: `${col} NOT IN (${ids.map(() => "?").join(",")})`, params: [...ids] };
}

export interface AnalysisQueryOptions {
  channelIds?: string[];
  excludedChannelIds: string[];
  includeStaff: boolean;
  staffIds: string[];
  /** Hard cap on rows returned (applied in SQL). */
  limit: number;
}

export class QualitativeStore {
  constructor(
    private readonly db: DatabaseSync,
    /** Whether readable message content is stored (gates content selection). */
    public readonly storeContent: boolean,
  ) {}

  private all<T>(sql: string, params: Bind[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }
  private get<T>(sql: string, params: Bind[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  private contentCol(alias = "m"): string {
    return this.storeContent ? `${alias}.content` : "NULL";
  }

  private replyCountExpr(alias = "m"): string {
    return `(SELECT COUNT(*) FROM messages r WHERE r.referenced_message_id = ${alias}.message_id AND r.is_deleted = 0)`;
  }

  /** SQL fragment matching this store's question heuristic (mirrors Phase 3). */
  private questionFrag(alias: string): Frag {
    const ors = QUESTION_PHRASES.map(() => `lower(${alias}.content) LIKE ?`).join(" OR ");
    return {
      sql: `(${alias}.content IS NOT NULL AND (${alias}.content LIKE '%?%' OR ${ors}))`,
      params: QUESTION_PHRASES.map((p) => `%${p}%`),
    };
  }

  /**
   * Messages eligible for topic/feedback analysis: non-deleted, non-bot, within
   * range, in the requested channels, NOT in excluded channels, and — unless
   * `includeStaff` — authored by non-staff members. Bounded by `limit`.
   */
  getAnalysisMessages(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: AnalysisQueryOptions,
  ): AnalysisMessageRow[] {
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const excl = notInList("m.channel_id", opts.excludedChannelIds);
    const nonStaff = opts.includeStaff
      ? { sql: "1", params: [] as Bind[] }
      : { sql: `NOT (${inList("m.author_id", opts.staffIds, "0").sql})`, params: opts.staffIds };
    return this.all<AnalysisMessageRow>(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_is_bot,
              m.created_at, ${this.contentCol()} AS content,
              m.reaction_count AS reaction_count,
              ${this.replyCountExpr()} AS reply_count,
              COALESCE(qc.is_thread, 0) AS is_thread
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0
          AND ${chan.sql} AND ${excl.sql} AND ${nonStaff.sql}
        ORDER BY m.created_at ASC
        LIMIT ?`,
      [
        guildId,
        startUtc,
        endExclusive,
        ...chan.params,
        ...excl.params,
        ...nonStaff.params,
        opts.limit,
      ],
    );
  }

  /** Candidate questions (member-authored) with content and first staff response. */
  getCandidateQuestions(
    guildId: string,
    startUtc: string,
    endExclusive: string,
    opts: {
      channelIds?: string[];
      excludedChannelIds: string[];
      staffIds: string[];
      limit: number;
    },
  ): CandidateQuestionRow[] {
    const q = this.questionFrag("m");
    const chan = inList("m.channel_id", opts.channelIds ?? [], "1");
    const excl = notInList("m.channel_id", opts.excludedChannelIds);
    const nonStaff = inList("m.author_id", opts.staffIds, "0");
    const staff = inList("s.author_id", opts.staffIds, "0");
    const respWhere = `s.is_deleted = 0 AND ${staff.sql} AND s.created_at > m.created_at
      AND (s.referenced_message_id = m.message_id OR s.channel_id = m.message_id
           OR (s.channel_id = m.channel_id AND qc.is_thread = 1))`;
    return this.all<CandidateQuestionRow>(
      `SELECT m.message_id, m.channel_id, m.author_id, m.created_at,
              COALESCE(qc.is_thread, 0) AS is_thread,
              ${this.contentCol()} AS content,
              (SELECT MIN(s.created_at) FROM messages s WHERE ${respWhere}) AS first_response_at,
              (SELECT s.author_id FROM messages s WHERE ${respWhere}
                 ORDER BY s.created_at ASC LIMIT 1) AS first_responder_id
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0 AND m.author_is_bot = 0 AND NOT (${nonStaff.sql})
          AND ${q.sql} AND ${chan.sql} AND ${excl.sql}
        ORDER BY m.created_at ASC
        LIMIT ?`,
      [
        ...staff.params, // first_response_at subquery
        ...staff.params, // first_responder_id subquery
        guildId,
        startUtc,
        endExclusive,
        ...nonStaff.params,
        ...q.params,
        ...chan.params,
        ...excl.params,
        opts.limit,
      ],
    );
  }

  /** Fetches one message with channel metadata, or undefined. */
  getMessage(
    guildId: string,
    messageId: string,
  ):
    | (AnalysisMessageRow & { channel_name: string | null; channel_type: number | null })
    | undefined {
    return this.get(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_is_bot,
              m.created_at, ${this.contentCol()} AS content,
              m.reaction_count AS reaction_count,
              ${this.replyCountExpr()} AS reply_count,
              COALESCE(qc.is_thread, 0) AS is_thread,
              qc.name AS channel_name, qc.type AS channel_type
         FROM messages m
         LEFT JOIN channels qc ON qc.channel_id = m.channel_id
        WHERE m.guild_id = ? AND m.message_id = ?`,
      [guildId, messageId],
    );
  }

  /** Messages immediately before/after a target within the same channel. */
  getContextWindow(
    guildId: string,
    channelId: string,
    createdAt: string,
    before: number,
    after: number,
  ): { before: AnalysisMessageRow[]; after: AnalysisMessageRow[] } {
    const select = `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_is_bot,
              m.created_at, ${this.contentCol()} AS content, m.reaction_count AS reaction_count,
              ${this.replyCountExpr()} AS reply_count, 0 AS is_thread
         FROM messages m`;
    const beforeRows = this.all<AnalysisMessageRow>(
      `${select} WHERE m.guild_id = ? AND m.channel_id = ? AND m.is_deleted = 0 AND m.created_at < ?
        ORDER BY m.created_at DESC LIMIT ?`,
      [guildId, channelId, createdAt, before],
    ).reverse();
    const afterRows = this.all<AnalysisMessageRow>(
      `${select} WHERE m.guild_id = ? AND m.channel_id = ? AND m.is_deleted = 0 AND m.created_at > ?
        ORDER BY m.created_at ASC LIMIT ?`,
      [guildId, channelId, createdAt, after],
    );
    return { before: beforeRows, after: afterRows };
  }

  /** Direct replies referencing a target message. */
  getDirectReplies(guildId: string, messageId: string, limit: number): AnalysisMessageRow[] {
    return this.all<AnalysisMessageRow>(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_is_bot,
              m.created_at, ${this.contentCol()} AS content, m.reaction_count AS reaction_count,
              0 AS reply_count, 0 AS is_thread
         FROM messages m
        WHERE m.guild_id = ? AND m.referenced_message_id = ? AND m.is_deleted = 0
        ORDER BY m.created_at ASC LIMIT ?`,
      [guildId, messageId, limit],
    );
  }

  /**
   * Thread messages for a target: messages in the thread channel started from the
   * target (channel_id = messageId) OR messages in the target's own thread channel.
   */
  getThreadMessages(guildId: string, threadChannelId: string, limit: number): AnalysisMessageRow[] {
    return this.all<AnalysisMessageRow>(
      `SELECT m.message_id, m.channel_id, m.parent_channel_id, m.author_id, m.author_is_bot,
              m.created_at, ${this.contentCol()} AS content, m.reaction_count AS reaction_count,
              0 AS reply_count, 1 AS is_thread
         FROM messages m
        WHERE m.guild_id = ? AND m.channel_id = ? AND m.is_deleted = 0
        ORDER BY m.created_at ASC LIMIT ?`,
      [guildId, threadChannelId, limit],
    );
  }

  /** Channel metadata for a packet. */
  getChannelMeta(channelId: string):
    | {
        channel_id: string;
        name: string | null;
        type: number | null;
        is_thread: number;
        parent_channel_id: string | null;
      }
    | undefined {
    return this.get(
      `SELECT channel_id, name, type, is_thread, parent_channel_id FROM channels WHERE channel_id = ?`,
      [channelId],
    );
  }

  /** Per-hour-of-day message counts (tz-offset applied) for "most active times". */
  getHourlyActivity(
    guildId: string,
    channelId: string,
    startUtc: string,
    endExclusive: string,
    offsetSeconds: number,
  ): { hour: string; count: number }[] {
    return this.all(
      `SELECT strftime('%H', m.created_at, ? || ' seconds') AS hour, COUNT(*) AS count
         FROM messages m
        WHERE m.guild_id = ? AND m.channel_id = ? AND m.created_at >= ? AND m.created_at < ?
          AND m.is_deleted = 0
        GROUP BY hour ORDER BY count DESC`,
      [offsetSeconds, guildId, channelId, startUtc, endExclusive],
    );
  }

  /** Top threads under a channel by message count within range (major threads). */
  getThreadActivity(
    guildId: string,
    parentChannelId: string,
    startUtc: string,
    endExclusive: string,
    limit: number,
  ): { channel_id: string; name: string | null; message_count: number }[] {
    return this.all(
      `SELECT m.channel_id, tc.name AS name, COUNT(*) AS message_count
         FROM messages m
         JOIN channels tc ON tc.channel_id = m.channel_id AND tc.is_thread = 1
        WHERE m.guild_id = ? AND tc.parent_channel_id = ?
          AND m.created_at >= ? AND m.created_at < ? AND m.is_deleted = 0
        GROUP BY m.channel_id ORDER BY message_count DESC LIMIT ?`,
      [guildId, parentChannelId, startUtc, endExclusive, limit],
    );
  }

  /** Channel-scoped message counts for a packet (staff/member/bot, active members). */
  getChannelStats(
    guildId: string,
    channelId: string,
    startUtc: string,
    endExclusive: string,
    staffIds: string[],
  ): {
    total: number;
    staffMessages: number;
    memberMessages: number;
    botMessages: number;
    activeMembers: number;
  } {
    const staff = inList("author_id", staffIds, "0");
    const row = this.get<{
      total: number;
      staff: number;
      member: number;
      bot: number;
      active: number;
    }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${staff.sql} THEN 1 ELSE 0 END) AS staff,
              SUM(CASE WHEN author_is_bot = 0 AND NOT (${staff.sql}) THEN 1 ELSE 0 END) AS member,
              SUM(CASE WHEN author_is_bot = 1 THEN 1 ELSE 0 END) AS bot,
              COUNT(DISTINCT CASE WHEN author_is_bot = 0 AND NOT (${staff.sql}) THEN author_id END) AS active
         FROM messages
        WHERE guild_id = ? AND channel_id = ? AND created_at >= ? AND created_at < ? AND is_deleted = 0`,
      [
        ...staff.params,
        ...staff.params,
        ...staff.params,
        guildId,
        channelId,
        startUtc,
        endExclusive,
      ],
    );
    return {
      total: row?.total ?? 0,
      staffMessages: row?.staff ?? 0,
      memberMessages: row?.member ?? 0,
      botMessages: row?.bot ?? 0,
      activeMembers: row?.active ?? 0,
    };
  }

  /** The earliest stored message timestamp for a guild (partial-history detection). */
  getEarliestMessageAt(guildId: string): string | null {
    const row = this.get<{ t: string | null }>(
      `SELECT MIN(created_at) AS t FROM messages WHERE guild_id = ?`,
      [guildId],
    );
    return row?.t ?? null;
  }
}
