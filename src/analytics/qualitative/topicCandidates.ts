/**
 * Lexical topic-candidate extraction. Topics are repeated words/phrases across
 * multiple DISTINCT messages — this is lexical, NOT semantic, and never
 * equivalent to an AI topic model. Bigrams are preferred over isolated common
 * words, near-duplicate labels are removed, and each candidate is ranked by how
 * many distinct messages/members support it.
 */
import { buildPeriod, Limitations } from "../reporting/types.js";
import { ratio, compare } from "../reporting/stats.js";
import { tokenize, bigrams, isLowInformation } from "./tokenizer.js";
import { Pseudonymizer } from "./pseudonymizer.js";
import { toEvidence } from "./evidence.js";
import { reportingOf, type QualContext, type AnalysisMessageRow } from "./types.js";

/** Bounded scan size so a huge guild never loads unbounded rows into memory. */
const ANALYSIS_SCAN_LIMIT = 5000;
/** Representative message IDs kept per topic. */
const REPRESENTATIVE_LIMIT = 5;

export interface TopicCandidatesParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  includeStaff?: boolean;
  minimumMessages?: number;
  topicLimit?: number;
  includeEvidence?: boolean;
  comparePreviousPeriod?: boolean;
}

interface TermStat {
  label: string;
  kind: "unigram" | "bigram";
  messages: Set<string>;
  members: Set<string>;
  channels: Set<string>;
  first: string;
  last: string;
  reps: AnalysisMessageRow[];
}

/** Builds per-term distinct-message/member/channel stats from message rows. */
function extractTerms(rows: AnalysisMessageRow[]): Map<string, TermStat> {
  const terms = new Map<string, TermStat>();
  for (const row of rows) {
    if (row.content === null || isLowInformation(row.content)) continue;
    const tokens = tokenize(row.content);
    const labels = new Set<string>([...tokens, ...bigrams(tokens)]);
    for (const label of labels) {
      const kind: TermStat["kind"] = label.includes(" ") ? "bigram" : "unigram";
      let stat = terms.get(label);
      if (!stat) {
        stat = {
          label,
          kind,
          messages: new Set(),
          members: new Set(),
          channels: new Set(),
          first: row.created_at,
          last: row.created_at,
          reps: [],
        };
        terms.set(label, stat);
      }
      stat.messages.add(row.message_id);
      if (row.author_id) stat.members.add(row.author_id);
      stat.channels.add(row.channel_id);
      if (row.created_at < stat.first) stat.first = row.created_at;
      if (row.created_at > stat.last) stat.last = row.created_at;
      if (stat.reps.length < REPRESENTATIVE_LIMIT) stat.reps.push(row);
    }
  }
  return terms;
}

/** Jaccard similarity of two string sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function buildTopicCandidates(ctx: QualContext, params: TopicCandidatesParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const minMessages = Math.max(params.minimumMessages ?? cfg.topicMinMessages, 1);
  const limit = Math.min(params.topicLimit ?? cfg.topicLimit, cfg.topicLimit);
  const includeStaff = params.includeStaff ?? cfg.includeStaff;
  const includeEvidence = params.includeEvidence ?? false;

  const limitations = new Limitations();
  limitations.add(
    "Topics are LEXICAL candidates (repeated words/phrases), not a semantic AI topic model.",
  );
  limitations.addIf(
    !ctx.qStore.storeContent,
    "Message content storage is disabled: no topics can be detected.",
  );
  limitations.addIf(
    cfg.excludedChannelIds.length > 0,
    "Some channels are excluded from qualitative analysis.",
  );
  const reason = ctx.policy.disabledReason();
  if (reason && includeEvidence) limitations.add(reason);

  const queryOpts = {
    excludedChannelIds: cfg.excludedChannelIds,
    includeStaff,
    staffIds: reporting.staffUserIds,
    limit: ANALYSIS_SCAN_LIMIT,
  };
  const rows = ctx.qStore.getAnalysisMessages(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: params.channelIds,
      ...queryOpts,
    },
  );

  const terms = extractTerms(rows);
  // Candidates that clear the minimum distinct-message threshold.
  const candidates = [...terms.values()].filter((t) => t.messages.size >= minMessages);
  // Deterministic ranking: distinct messages, then members, then bigram-first, then label.
  candidates.sort(
    (a, b) =>
      b.messages.size - a.messages.size ||
      b.members.size - a.members.size ||
      (a.kind === b.kind ? 0 : a.kind === "bigram" ? -1 : 1) ||
      a.label.localeCompare(b.label),
  );

  // Dedup: drop a candidate subsumed by a higher-ranked one — either a unigram
  // contained in a kept bigram with heavy message overlap, or a near-duplicate
  // (Jaccard of message sets > 0.8).
  const kept: TermStat[] = [];
  for (const c of candidates) {
    const dup = kept.some((k) => {
      const overlap = jaccard(c.messages, k.messages);
      const contained =
        k.kind === "bigram" && c.kind === "unigram" && k.label.split(" ").includes(c.label);
      return (contained && overlap > 0.5) || overlap > 0.8;
    });
    if (!dup) kept.push(c);
    if (kept.length >= limit) break;
  }

  // Previous-period distinct-message counts for the kept labels.
  let previousTerms: Map<string, TermStat> | null = null;
  if (params.comparePreviousPeriod ?? true) {
    const spanMs = Date.parse(period.endUtcExclusive) - Date.parse(period.startUtc);
    const prevStart = new Date(Date.parse(period.startUtc) - spanMs).toISOString();
    const prevRows = ctx.qStore.getAnalysisMessages(params.guildId, prevStart, period.startUtc, {
      channelIds: params.channelIds,
      ...queryOpts,
    });
    previousTerms = extractTerms(prevRows);
  }

  const pseudo = new Pseudonymizer(
    cfg,
    ctx.policy.contentAllowed,
    new Set(reporting.staffUserIds),
    reporting.primaryUserId,
  );

  const topics = kept.map((t) => {
    const previousCount = previousTerms?.get(t.label)?.messages.size ?? 0;
    return {
      label: t.label,
      kind: t.kind,
      supportingMessageCount: t.messages.size,
      distinctMemberCount: t.members.size,
      distinctChannelCount: t.channels.size,
      firstSeen: t.first,
      lastSeen: t.last,
      currentPeriodCount: t.messages.size,
      previousPeriodCount: previousTerms ? previousCount : null,
      change: previousTerms ? compare(t.messages.size, previousCount) : null,
      shareOfMessages: ratio(t.messages.size, rows.length),
      representativeMessageIds: t.reps.map((r) => r.message_id),
      evidence: includeEvidence
        ? t.reps.map((r) =>
            toEvidence(r, ctx.policy, pseudo, includeEvidence, {
              reason: `topic:${t.label}`,
              categories: [t.label],
            }),
          )
        : undefined,
    };
  });

  return {
    period,
    analysedMessageCount: rows.length,
    topicCount: topics.length,
    topics,
    methodology: {
      approach:
        "Distinct-message counts of unigrams and bigrams after stop-word removal; bigrams preferred; near-duplicate labels merged.",
      minimumMessages: minMessages,
      note: "Lexical only — repeated words/phrases, not semantic meaning. Candidates require human review.",
    },
    limitations: limitations.list(),
  };
}
