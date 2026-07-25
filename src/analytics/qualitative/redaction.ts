/**
 * Mention redaction and link sanitisation for excerpts. Raw mention IDs and full
 * URLs (which can carry auth tokens / signed parameters) are never returned.
 */

/**
 * Replaces Discord mentions with generic placeholders so no raw IDs leak:
 *  <@id>/<@!id> → [member], <@&id> → [role], <#id> → [channel],
 *  @everyone → [everyone], @here → [here].
 */
export function redactMentions(text: string): string {
  return text
    .replace(/<@!?\d+>/g, "[member]")
    .replace(/<@&\d+>/g, "[role]")
    .replace(/<#\d+>/g, "[channel]")
    .replace(/@everyone/gi, "[everyone]")
    .replace(/@here/gi, "[here]");
}

/**
 * Reduces each http(s) URL to its bare origin `scheme://host`, dropping the path,
 * query string, and fragment. This preserves the domain for context while
 * removing query parameters, fragments, and any signed/auth tokens. A malformed
 * URL is replaced with a neutral `[link]` placeholder.
 */
export function sanitizeLinks(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}`;
    } catch {
      return "[link]";
    }
  });
}

/** Applies mention redaction (optional) and always sanitises links. */
export function redactContent(text: string, redactMentionsEnabled: boolean): string {
  let out = text;
  if (redactMentionsEnabled) out = redactMentions(out);
  out = sanitizeLinks(out);
  return out;
}
