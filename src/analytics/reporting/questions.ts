/**
 * Candidate-question detection — a transparent, testable heuristic (NOT AI).
 *
 * The same phrase list drives both the in-app detector and the SQL used by the
 * reporting store, so both agree. A "candidate question" is exactly that: a
 * candidate that a human should still review. Detection needs readable content;
 * with content storage off, question detection is unavailable (never faked).
 */

/** Lower-case opening/《request》phrases that flag a probable question. */
export const QUESTION_PHRASES = [
  "how do",
  "how can",
  "how would",
  "can someone",
  "could someone",
  "does anyone",
  "did anyone",
  "where can",
  "where is",
  "where do",
  "what is",
  "what are",
  "what's",
  "when is",
  "when are",
  "who can",
  "why is",
  "why are",
  "is there",
  "are there",
  "please help",
  "need help",
  "any advice",
  "any idea",
  "any ideas",
] as const;

/**
 * True when `content` looks like a candidate question: it contains a question
 * mark, or contains one of {@link QUESTION_PHRASES}. Returns false for null
 * content (content storage disabled) — the caller reports that limitation.
 */
export function looksLikeQuestion(content: string | null | undefined): boolean {
  if (!content) return false;
  if (content.includes("?")) return true;
  const lower = content.toLowerCase();
  return QUESTION_PHRASES.some((p) => lower.includes(p));
}
