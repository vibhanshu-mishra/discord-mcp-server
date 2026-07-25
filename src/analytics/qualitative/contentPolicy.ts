/**
 * The central content-output policy — the single place that decides whether
 * readable message text may leave the local database through MCP, and produces
 * bounded, redacted, sanitised excerpts when it may.
 *
 * TWO gates must BOTH be true before any excerpt is returned:
 *   1. `DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT` (content is actually stored)
 *   2. `DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT` (content may be output)
 * Plus the per-call `include_*` flag. If any is false, no excerpt is produced and
 * a clear limitation is reported instead. Content is never logged or thrown.
 */
import type { QualitativeConfig } from "./config.js";
import { redactContent } from "./redaction.js";
import { normalize } from "./tokenizer.js";

export interface Excerpt {
  text: string;
  truncated: boolean;
}

export class OutputPolicy {
  /** True when both the storage and output gates are open. */
  readonly contentAllowed: boolean;

  constructor(
    private readonly storeContent: boolean,
    private readonly config: QualitativeConfig,
  ) {
    this.contentAllowed = storeContent && config.allowContentOutput;
  }

  /** A secret-free explanation of why excerpts are unavailable, or null when allowed. */
  disabledReason(): string | null {
    if (!this.storeContent) {
      return "Message content storage is disabled (DISCORD_ANALYTICS_STORE_MESSAGE_CONTENT=false); excerpts are unavailable.";
    }
    if (!this.config.allowContentOutput) {
      return "Content output is disabled (DISCORD_ANALYTICS_ALLOW_CONTENT_OUTPUT=false); only IDs, counts, timestamps, and lexical labels are returned.";
    }
    return null;
  }

  /**
   * Produces a bounded, redacted excerpt, or null when output is not permitted or
   * not requested. Mentions are redacted (when configured), links are reduced to
   * their origin, whitespace is normalised, and the text is truncated to the
   * configured character limit with an explicit truncation marker.
   */
  excerpt(content: string | null, includeRequested: boolean): Excerpt | null {
    if (!this.contentAllowed || !includeRequested || content === null) return null;
    const redacted = redactContent(content, this.config.redactMentions);
    const collapsed = normalize(redacted);
    const max = this.config.maxExcerptCharacters;
    if (collapsed.length <= max) return { text: collapsed, truncated: false };
    // Truncate cleanly on a word boundary within the limit, then mark truncation.
    const slice = collapsed.slice(0, max);
    const lastSpace = slice.lastIndexOf(" ");
    const body = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
    return { text: `${body}…`, truncated: true };
  }
}
