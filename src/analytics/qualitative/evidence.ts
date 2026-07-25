/**
 * Builds bounded, privacy-safe evidence items from message rows. An evidence item
 * carries IDs, timestamps, counts, a pseudonymised author, and an optional
 * redacted excerpt (only when the content policy permits it). Message content is
 * never included unless both content gates and the per-call flag are open.
 */
import type { OutputPolicy } from "./contentPolicy.js";
import type { Pseudonymizer } from "./pseudonymizer.js";
import type { AnalysisMessageRow } from "./types.js";

export interface EvidenceItem {
  messageId: string;
  channelId: string;
  createdAt: string;
  author: ReturnType<Pseudonymizer["identify"]>;
  replyCount: number;
  reactionCount: number;
  /** Present only when content output is permitted and requested. */
  excerpt: string | null;
  excerptTruncated?: boolean;
  /** Why this message is included (e.g. "topic:deploy failed", "signal:problem"). */
  reason?: string;
  /** Associated topic labels / signal categories, when relevant. */
  categories?: string[];
}

export function toEvidence(
  row: AnalysisMessageRow,
  policy: OutputPolicy,
  pseudo: Pseudonymizer,
  includeExcerpt: boolean,
  extra?: { reason?: string; categories?: string[] },
): EvidenceItem {
  const excerpt = policy.excerpt(row.content, includeExcerpt);
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    createdAt: row.created_at,
    author: pseudo.identify(row.author_id),
    replyCount: row.reply_count,
    reactionCount: row.reaction_count,
    excerpt: excerpt ? excerpt.text : null,
    ...(excerpt?.truncated ? { excerptTruncated: true } : {}),
    ...(extra?.reason ? { reason: extra.reason } : {}),
    ...(extra?.categories ? { categories: extra.categories } : {}),
  };
}
