/**
 * Deterministic, lightweight text processing for LEXICAL analysis (English).
 * There is no NLP framework, no model, no embeddings — just Unicode
 * normalisation, lowercasing, whitespace/URL/mention stripping, tokenisation,
 * stop-word filtering, and n-gram extraction. Topic detection built on this is
 * lexical (repeated words/phrases), NOT semantic, and never equivalent to an AI
 * topic model. Everything here is pure and reproducible.
 */

/** A compact English stop-word list (function words carrying little topicality). */
export const STOP_WORDS = new Set<string>([
  "a",
  "about",
  "above",
  "after",
  "again",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "being",
  "but",
  "by",
  "can",
  "cant",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "dont",
  "down",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "im",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "me",
  "more",
  "most",
  "my",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "us",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "ll",
  "ve",
  "re",
  "s",
  "t",
]);

/** Very short, low-information messages that should not drive topic candidates. */
const LOW_INFO_PHRASES = new Set<string>([
  "thanks",
  "thank you",
  "thankyou",
  "ty",
  "thx",
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "no",
  "nope",
  "nah",
  "sure",
  "cool",
  "nice",
  "great",
  "lol",
  "lmao",
  "haha",
  "np",
  "gotcha",
  "same",
  "agreed",
  "done",
  "fixed",
  "got it",
]);

/** Unicode-normalise, lowercase, and collapse whitespace. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Removes http(s) URLs entirely (used before tokenising). */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, " ");
}

/** Removes Discord mentions and @everyone/@here (used before tokenising). */
export function stripMentions(text: string): string {
  return text
    .replace(/<@!?\d+>/g, " ")
    .replace(/<@&\d+>/g, " ")
    .replace(/<#\d+>/g, " ")
    .replace(/<a?:\w+:\d+>/g, " ") // custom emoji
    .replace(/@everyone/gi, " ")
    .replace(/@here/gi, " ");
}

/**
 * Tokenises content into lower-case word tokens: strips URLs/mentions, splits on
 * non-letter/digit boundaries, drops stop-words and single characters.
 */
export function tokenize(text: string): string[] {
  const cleaned = normalize(stripMentions(stripUrls(text)));
  return cleaned
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

/** Adjacent-pair phrases from a token list (e.g. "deploy failed"). */
export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/** Adjacent-triple phrases from a token list. */
export function trigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 < tokens.length; i++)
    out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  return out;
}

/** Term-frequency map for a token (or n-gram) list. */
export function termFrequency(terms: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * True for messages too short/generic to be topical: empty content, a known
 * low-information phrase, emoji/punctuation-only, or fewer than two content
 * tokens. Applies to TOPIC extraction only (not feedback classification).
 */
export function isLowInformation(content: string | null): boolean {
  if (!content) return true;
  const normalized = normalize(stripMentions(stripUrls(content)));
  if (normalized.length === 0) return true;
  if (LOW_INFO_PHRASES.has(normalized)) return true;
  return tokenize(content).length < 2;
}

/** The distinct normalised token set of a message (for similarity comparisons). */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}
