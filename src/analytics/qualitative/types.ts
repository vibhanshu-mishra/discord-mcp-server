/**
 * Shared types for the qualitative-analysis services. Every service returns a
 * plain, JSON-compatible object with a `methodology` field (transparency) and a
 * `limitations` list (data-quality caveats). Results are lexical CANDIDATES for
 * human/MCP-client interpretation — never definitive conclusions.
 */
import type { QualitativeStore } from "./store.js";
import type { OutputPolicy } from "./contentPolicy.js";
import type { QualitativeConfig } from "./config.js";
import type { ReportContext } from "../reporting/types.js";
import type { ReportingConfig } from "../reporting/config.js";

/** Everything a qualitative service needs, all read-only. */
export interface QualContext {
  /** Phase 4 read-only store (its own parameterised SELECTs). */
  qStore: QualitativeStore;
  /** Phase 3 report context (ReportingStore + reporting config), for reuse. */
  report: ReportContext;
  qualitative: QualitativeConfig;
  policy: OutputPolicy;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/** Convenience accessor for the reporting config carried on the report context. */
export function reportingOf(ctx: QualContext): ReportingConfig {
  return ctx.report.reporting;
}

/** One analysable message row (content present only when storage is enabled). */
export interface AnalysisMessageRow {
  message_id: string;
  channel_id: string;
  parent_channel_id: string | null;
  author_id: string | null;
  author_is_bot: number;
  created_at: string;
  content: string | null;
  reaction_count: number;
  reply_count: number;
  is_thread: number;
}

/** A candidate question row with content and first-staff-response metadata. */
export interface CandidateQuestionRow {
  message_id: string;
  channel_id: string;
  author_id: string | null;
  created_at: string;
  is_thread: number;
  content: string | null;
  first_response_at: string | null;
  first_responder_id: string | null;
}
