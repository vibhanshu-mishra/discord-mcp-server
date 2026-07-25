/**
 * Recurring-question grouping over Phase 3 candidate questions. Grouping is
 * deterministic and lexical: questions are compared by Jaccard similarity of
 * their normalised token sets (no embeddings). Each question joins at most one
 * group, groups need at least the configured minimum size, and ordering is fixed.
 */
import { buildPeriod, Limitations } from "../reporting/types.js";
import { median } from "../reporting/stats.js";
import { tokenSet, tokenize, bigrams, termFrequency } from "./tokenizer.js";
import { Pseudonymizer } from "./pseudonymizer.js";
import { reportingOf, type QualContext, type CandidateQuestionRow } from "./types.js";

const SCAN_LIMIT = 5000;

export interface RecurringQuestionsParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  minimumGroupSize?: number;
  similarityThreshold?: number;
  limit?: number;
  includeEvidence?: boolean;
}

interface QNode extends CandidateQuestionRow {
  tokens: Set<string>;
}

/** Generates a short lexical label from the questions in a group. */
function labelFor(rows: CandidateQuestionRow[]): string {
  const bigramFreq = termFrequency(rows.flatMap((r) => bigrams(tokenize(r.content ?? ""))));
  const topBigram = [...bigramFreq.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  if (topBigram && topBigram[1] >= 2) return topBigram[0];
  const uniFreq = termFrequency(rows.flatMap((r) => tokenize(r.content ?? "")));
  const top = [...uniFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map((e) => e[0]);
  return top.join(" ") || "unlabelled";
}

/** Jaccard similarity of two token sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function responseSeconds(r: CandidateQuestionRow): number | null {
  if (!r.first_response_at) return null;
  return Math.max(
    0,
    Math.round((Date.parse(r.first_response_at) - Date.parse(r.created_at)) / 1000),
  );
}

export function buildRecurringQuestions(ctx: QualContext, params: RecurringQuestionsParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const minSize = Math.max(params.minimumGroupSize ?? 2, 2);
  const threshold = params.similarityThreshold ?? cfg.questionSimilarityThreshold;
  const limit = Math.min(params.limit ?? cfg.topicLimit, cfg.topicLimit);
  const includeEvidence = params.includeEvidence ?? false;

  const limitations = new Limitations();
  limitations.add(
    "Recurring-question groups are LEXICAL candidates (token-set similarity), not semantic clustering.",
  );
  if (!ctx.qStore.storeContent) {
    limitations.add("Message content storage is disabled: questions cannot be grouped.");
    return {
      period,
      groupCount: 0,
      groups: [],
      methodology: { similarity: "Jaccard token-set overlap", threshold },
      limitations: limitations.list(),
    };
  }
  const reason = ctx.policy.disabledReason();
  if (reason && includeEvidence) limitations.add(reason);

  const rows = ctx.qStore.getCandidateQuestions(
    params.guildId,
    period.startUtc,
    period.endUtcExclusive,
    {
      channelIds: params.channelIds,
      excludedChannelIds: cfg.excludedChannelIds,
      staffIds: reporting.staffUserIds,
      limit: SCAN_LIMIT,
    },
  );

  // Deterministic input order and one-group-per-message greedy grouping.
  const nodes: QNode[] = rows
    .map((r) => ({ ...r, tokens: tokenSet(r.content ?? "") }))
    .filter((n) => n.tokens.size > 0)
    .sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.message_id.localeCompare(b.message_id),
    );

  const grouped = new Set<string>();
  const rawGroups: QNode[][] = [];
  for (const seed of nodes) {
    if (grouped.has(seed.message_id)) continue;
    const group = [seed];
    grouped.add(seed.message_id);
    for (const other of nodes) {
      if (grouped.has(other.message_id)) continue;
      if (jaccard(seed.tokens, other.tokens) >= threshold) {
        group.push(other);
        grouped.add(other.message_id);
      }
    }
    if (group.length >= minSize) rawGroups.push(group);
  }

  const pseudo = new Pseudonymizer(
    cfg,
    ctx.policy.contentAllowed,
    new Set(reporting.staffUserIds),
    reporting.primaryUserId,
  );

  const groups = rawGroups
    .map((g, i) => {
      const answered = g.filter((r) => r.first_response_at !== null);
      const times = answered.map(responseSeconds).filter((s): s is number => s !== null);
      const members = new Set(g.map((r) => r.author_id).filter(Boolean) as string[]);
      const channels = new Set(g.map((r) => r.channel_id));
      const sorted = [...g].sort((a, b) => a.created_at.localeCompare(b.created_at));
      return {
        groupId: `qgroup-${i + 1}`,
        label: labelFor(g),
        questionCount: g.length,
        distinctMemberCount: members.size,
        distinctChannelCount: channels.size,
        firstSeen: sorted[0].created_at,
        lastSeen: sorted[sorted.length - 1].created_at,
        answeredCount: answered.length,
        unansweredCount: g.length - answered.length,
        medianStaffResponseSeconds: median(times),
        evidenceMessageIds: g.map((r) => r.message_id),
        evidence: includeEvidence
          ? g.map((r) => ({
              messageId: r.message_id,
              channelId: r.channel_id,
              createdAt: r.created_at,
              author: pseudo.identify(r.author_id),
              answered: r.first_response_at !== null,
              excerpt: ctx.policy.excerpt(r.content, includeEvidence)?.text ?? null,
            }))
          : undefined,
      };
    })
    .sort(
      (a, b) =>
        b.questionCount - a.questionCount ||
        b.unansweredCount - a.unansweredCount ||
        b.lastSeen.localeCompare(a.lastSeen) ||
        a.groupId.localeCompare(b.groupId),
    )
    .slice(0, limit);

  return {
    period,
    groupCount: groups.length,
    groups,
    methodology: {
      similarity: "Jaccard overlap of normalised token sets; each message joins at most one group.",
      threshold,
      minimumGroupSize: minSize,
      note: "Lexical candidates requiring human review.",
    },
    limitations: limitations.list(),
  };
}
