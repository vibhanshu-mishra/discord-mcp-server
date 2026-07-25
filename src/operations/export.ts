/**
 * Privacy-safe report exports. Reuses the existing Phase 3 reporting services and
 * Phase 4 qualitative services (no duplicated calculations) against a READ-ONLY
 * database connection. Aggregate data is the default; message excerpts appear only
 * when content is stored AND content output is enabled AND `--include-evidence`
 * is supplied. Redaction, pseudonymisation, excluded channels, and excerpt limits
 * are enforced by the services themselves. Exports never contact Discord.
 */
import { openReadOnly, inspectDatabase } from "./databaseHealth.js";
import { ReportingStore } from "../analytics/reporting/store.js";
import { getReportingConfig } from "../analytics/reporting/config.js";
import type { ReportContext } from "../analytics/reporting/types.js";
import { QualitativeStore } from "../analytics/qualitative/store.js";
import { getQualitativeConfig } from "../analytics/qualitative/config.js";
import { OutputPolicy } from "../analytics/qualitative/contentPolicy.js";
import type { QualContext } from "../analytics/qualitative/types.js";
import { buildMemberEngagement } from "../analytics/reporting/memberEngagement.js";
import { buildStaffResponseMetrics } from "../analytics/reporting/responseMetrics.js";
import { buildTrainingCadence } from "../analytics/reporting/trainingCadence.js";
import { buildOfficeHourMetrics } from "../analytics/reporting/officeHours.js";
import { buildWeeklyMetrics } from "../analytics/reporting/weeklyMetrics.js";
import { buildTopicCandidates } from "../analytics/qualitative/topicCandidates.js";
import { buildRecurringQuestions } from "../analytics/qualitative/recurringQuestions.js";
import { buildFeedbackSignals } from "../analytics/qualitative/feedbackSignals.js";
import { buildQualitativePacket } from "../analytics/qualitative/analysisPacket.js";
import { isAnalyticsGuildAuthorised } from "../analytics/config.js";
import { CliError, EXIT } from "../cli/exitCodes.js";

export const REPORT_TYPES = [
  "weekly-metrics",
  "member-engagement",
  "staff-response",
  "training-cadence",
  "office-hours",
  "topic-candidates",
  "recurring-questions",
  "feedback-signals",
  "qualitative-packet",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Reports whose primary array flattens cleanly to CSV (nested detail is dropped). */
const CSV_TABULAR: Partial<Record<ReportType, string>> = {
  "member-engagement": "members",
  "topic-candidates": "topics",
  "feedback-signals": "categories",
  "recurring-questions": "groups",
};

export interface ExportParams {
  reportType: ReportType;
  guildId: string;
  startDate: string;
  endDate?: string;
  includeEvidence?: boolean;
  dbPath: string;
}

/** Builds the report object by reusing existing services on a read-only DB. */
export function generateReport(params: ExportParams): Record<string, unknown> {
  if (!isAnalyticsGuildAuthorised(params.guildId)) {
    throw new CliError(
      "Guild is not authorised (must be in both DISCORD_ANALYTICS_GUILD_IDS and DISCORD_ALLOWED_GUILDS).",
      EXIT.CONFIG,
    );
  }
  const storeContent = inspectDatabase(params.dbPath).contentStored === "yes";
  const db = openReadOnly(params.dbPath);
  try {
    const reporting = getReportingConfig();
    const report: ReportContext = { store: new ReportingStore(db, storeContent), reporting };
    const qualitative = getQualitativeConfig();
    const qctx: QualContext = {
      qStore: new QualitativeStore(db, storeContent),
      report,
      qualitative,
      policy: new OutputPolicy(storeContent, qualitative),
    };
    const end = params.endDate ?? params.startDate;
    const includeEvidence = params.includeEvidence ?? false;
    const g = params.guildId;

    switch (params.reportType) {
      case "weekly-metrics":
        return buildWeeklyMetrics(report, { guildId: g, weekStartDate: params.startDate }) as never;
      case "member-engagement":
        return buildMemberEngagement(report, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
        }) as never;
      case "staff-response":
        return buildStaffResponseMetrics(report, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
        }) as never;
      case "training-cadence":
        return buildTrainingCadence(report, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
        }) as never;
      case "office-hours":
        return buildOfficeHourMetrics(report, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
        }) as never;
      case "topic-candidates":
        return buildTopicCandidates(qctx, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
          includeEvidence,
        }) as never;
      case "recurring-questions":
        return buildRecurringQuestions(qctx, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
          includeEvidence,
        }) as never;
      case "feedback-signals":
        return buildFeedbackSignals(qctx, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
          includeEvidence,
        }) as never;
      case "qualitative-packet":
        return buildQualitativePacket(qctx, {
          guildId: g,
          startDate: params.startDate,
          endDate: end,
          includeEvidence,
        }) as never;
    }
  } finally {
    db.close();
  }
}

/** True when the report type supports CSV output. */
export function supportsCsv(reportType: ReportType): boolean {
  return reportType in CSV_TABULAR;
}

/** Extracts the flat tabular rows for CSV, or null when the report is not tabular. */
export function tabularRows(
  reportType: ReportType,
  report: Record<string, unknown>,
): Record<string, unknown>[] | null {
  const key = CSV_TABULAR[reportType];
  if (!key) return null;
  const rows = report[key];
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Serialises flat rows to CSV, keeping only scalar columns (arrays/objects dropped). */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]).filter((k) => {
    const v = rows[0][k];
    return v === null || ["string", "number", "boolean"].includes(typeof v);
  });
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.join(",");
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
  return `${header}\n${body}\n`;
}
