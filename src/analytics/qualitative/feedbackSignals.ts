/**
 * Lexical feedback-signal classification. Messages are matched against transparent,
 * documented phrase dictionaries and tagged with candidate categories. These are
 * LEXICAL candidates — never definitive emotion or sentiment. A message may match
 * several categories; the matched phrases are returned as the reason.
 */
import { buildPeriod, Limitations } from "../reporting/types.js";
import { compare } from "../reporting/stats.js";
import { normalize } from "./tokenizer.js";
import { Pseudonymizer } from "./pseudonymizer.js";
import { toEvidence } from "./evidence.js";
import { reportingOf, type QualContext, type AnalysisMessageRow } from "./types.js";

const SCAN_LIMIT = 5000;

export type FeedbackCategory =
  | "request"
  | "problem"
  | "blocker"
  | "confusion"
  | "positive_outcome"
  | "suggestion"
  | "help_request";

/** Central, documented phrase dictionaries. All lower-case substring matches. */
export const FEEDBACK_PHRASES: Record<FeedbackCategory, string[]> = {
  request: [
    "can we",
    "could you",
    "please add",
    "would be helpful",
    "feature request",
    "can you add",
    "is it possible to",
  ],
  problem: [
    "not working",
    "doesn't work",
    "does not work",
    "broken",
    "error",
    "issue",
    "problem",
    "failed",
    "fails",
    "bug",
  ],
  blocker: [
    "blocked",
    "cannot continue",
    "can't continue",
    "stuck",
    "waiting on",
    "unable to proceed",
    "cannot proceed",
  ],
  confusion: [
    "confused",
    "not sure",
    "do not understand",
    "don't understand",
    "unclear",
    "where do i",
    "how does this",
  ],
  positive_outcome: [
    "worked",
    "solved",
    "completed",
    "success",
    "thank you",
    "thanks",
    "helped",
    "great result",
    "fixed it",
    "figured it out",
  ],
  suggestion: [
    "suggest",
    "recommend",
    "idea",
    "maybe we should",
    "it would be better",
    "we should",
    "what if we",
  ],
  help_request: [
    "please help",
    "need help",
    "can someone help",
    "any help",
    "help me",
    "looking for help",
  ],
};

export const ALL_CATEGORIES = Object.keys(FEEDBACK_PHRASES) as FeedbackCategory[];

/** Returns the categories a message matches, plus the matched phrases per category. */
export function classify(
  content: string | null,
): { category: FeedbackCategory; matched: string[] }[] {
  if (!content) return [];
  const norm = normalize(content);
  const out: { category: FeedbackCategory; matched: string[] }[] = [];
  for (const category of ALL_CATEGORIES) {
    const matched = FEEDBACK_PHRASES[category].filter((p) => norm.includes(p));
    // A trailing '?' also satisfies help_request via the shared question heuristic.
    if (
      category === "help_request" &&
      matched.length === 0 &&
      content.includes("?") &&
      /help|assist/i.test(content)
    ) {
      matched.push("? + help");
    }
    if (matched.length > 0) out.push({ category, matched });
  }
  return out;
}

export interface FeedbackSignalsParams {
  guildId: string;
  startDate: string;
  endDate: string;
  channelIds?: string[];
  categories?: FeedbackCategory[];
  includeStaff?: boolean;
  includeEvidence?: boolean;
  limit?: number;
}

function countSignals(rows: AnalysisMessageRow[], wanted: Set<FeedbackCategory>) {
  const perCategory = new Map<
    FeedbackCategory,
    {
      count: number;
      members: Set<string>;
      channels: Set<string>;
      reps: { row: AnalysisMessageRow; matched: string[] }[];
    }
  >();
  for (const cat of wanted)
    perCategory.set(cat, { count: 0, members: new Set(), channels: new Set(), reps: [] });
  for (const row of rows) {
    for (const { category, matched } of classify(row.content)) {
      if (!wanted.has(category)) continue;
      const e = perCategory.get(category)!;
      e.count += 1;
      if (row.author_id) e.members.add(row.author_id);
      e.channels.add(row.channel_id);
      if (e.reps.length < 10) e.reps.push({ row, matched });
    }
  }
  return perCategory;
}

export function buildFeedbackSignals(ctx: QualContext, params: FeedbackSignalsParams) {
  const reporting = reportingOf(ctx);
  const cfg = ctx.qualitative;
  const period = buildPeriod(params.startDate, params.endDate, reporting.timezone);
  const includeStaff = params.includeStaff ?? cfg.includeStaff;
  const includeEvidence = params.includeEvidence ?? false;
  const wanted = new Set(params.categories?.length ? params.categories : ALL_CATEGORIES);
  const evidenceLimit = Math.min(params.limit ?? cfg.maxEvidenceMessages, cfg.maxEvidenceMessages);

  const limitations = new Limitations();
  limitations.add(
    "Feedback signals are LEXICAL candidates from phrase dictionaries — not sentiment or emotion.",
  );
  limitations.addIf(
    !ctx.qStore.storeContent,
    "Message content storage is disabled: signals cannot be detected.",
  );
  const reason = ctx.policy.disabledReason();
  if (reason && includeEvidence) limitations.add(reason);

  const queryOpts = {
    excludedChannelIds: cfg.excludedChannelIds,
    includeStaff,
    staffIds: reporting.staffUserIds,
    limit: SCAN_LIMIT,
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
  const current = countSignals(rows, wanted);

  // Previous equal-length period for trends.
  const spanMs = Date.parse(period.endUtcExclusive) - Date.parse(period.startUtc);
  const prevStart = new Date(Date.parse(period.startUtc) - spanMs).toISOString();
  const prevRows = ctx.qStore.getAnalysisMessages(params.guildId, prevStart, period.startUtc, {
    channelIds: params.channelIds,
    ...queryOpts,
  });
  const previous = countSignals(prevRows, wanted);

  const pseudo = new Pseudonymizer(
    cfg,
    ctx.policy.contentAllowed,
    new Set(reporting.staffUserIds),
    reporting.primaryUserId,
  );

  const categories = [...wanted].sort().map((category) => {
    const cur = current.get(category)!;
    const prev = previous.get(category)!;
    return {
      category,
      count: cur.count,
      distinctMemberCount: cur.members.size,
      distinctChannelCount: cur.channels.size,
      changeVsPreviousPeriod: compare(cur.count, prev.count),
      representativeMessageIds: cur.reps.slice(0, 5).map((r) => r.row.message_id),
      evidence: includeEvidence
        ? cur.reps
            .slice(0, evidenceLimit)
            .map((r) =>
              toEvidence(r.row, ctx.policy, pseudo, includeEvidence, {
                reason: `signal:${category}`,
                categories: [category],
              }),
            )
            .map((e, idx) => ({ ...e, matchedReason: cur.reps[idx].matched }))
        : undefined,
    };
  });

  return {
    period,
    analysedMessageCount: rows.length,
    categories,
    methodology: {
      approach:
        "Case-insensitive phrase-dictionary matching; a message may match multiple categories.",
      categories: ALL_CATEGORIES,
      note: "Lexical candidates — not sentiment/emotion. Deleted and bot messages are excluded.",
    },
    limitations: limitations.list(),
  };
}
