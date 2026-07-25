/**
 * `export` — writes a privacy-safe analytics report to a file by reusing the
 * existing reporting/qualitative services. Aggregate data is the default; excerpts
 * appear only when content is stored, content output is enabled, AND
 * `--include-evidence` is supplied. CLI output prints only the filename and a
 * small summary — never the report's private contents. Exports never contact
 * Discord and are git-ignored.
 */
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT, CliError } from "../exitCodes.js";
import { printJson, printLine, type Args } from "../output.js";
import { getOperationsConfig } from "../../operations/opsConfig.js";
import {
  REPORT_TYPES,
  generateReport,
  supportsCsv,
  tabularRows,
  toCsv,
  type ReportType,
} from "../../operations/export.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function run(args: Args): Promise<number> {
  const ops = getOperationsConfig();
  const json = args.bool("json");
  const reportType = args.require("report") as ReportType;
  if (!REPORT_TYPES.includes(reportType)) {
    throw new CliError(
      `Unknown --report "${reportType}". Valid: ${REPORT_TYPES.join(", ")}.`,
      EXIT.INVALID_ARG,
    );
  }
  const guildId = args.require("guild-id");
  const startDate = args.require("start-date");
  if (!ISO_DATE.test(startDate))
    throw new CliError("--start-date must be YYYY-MM-DD.", EXIT.INVALID_ARG);
  const endDate = args.get("end-date");
  if (endDate && !ISO_DATE.test(endDate))
    throw new CliError("--end-date must be YYYY-MM-DD.", EXIT.INVALID_ARG);

  const format = (args.get("format") ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv")
    throw new CliError('--format must be "json" or "csv".', EXIT.INVALID_ARG);
  if (format === "csv" && !supportsCsv(reportType)) {
    throw new CliError(
      `CSV is not supported for the nested report "${reportType}"; use --format json. CSV is available for tabular reports only.`,
      EXIT.INVALID_ARG,
    );
  }

  const outputDir = args.get("output-dir") ?? ops.exportDir;
  const force = args.bool("force");
  const includeEvidence = args.bool("include-evidence");

  const report = generateReport({
    reportType,
    guildId,
    startDate,
    endDate,
    includeEvidence,
    dbPath: ops.dbPath,
  });

  const range = endDate ? `${startDate}_${endDate}` : startDate;
  const filename = `${reportType}-${guildId}-${range}.${format}`;
  const filePath = join(outputDir, filename);

  if (existsSync(filePath) && !force) {
    throw new CliError(`${filePath} already exists; use --force to overwrite.`, EXIT.INVALID_ARG);
  }
  mkdirSync(outputDir, { recursive: true });

  let body: string;
  if (format === "csv") {
    const rows = tabularRows(reportType, report) ?? [];
    body = toCsv(rows);
  } else {
    body = JSON.stringify(report, null, 2);
  }
  writeFileSync(filePath, body);

  // Print only the filename and a small summary — never the report contents.
  const bytes = statSync(filePath).size;
  if (json)
    printJson({ ok: true, file: filePath, reportType, guildId, format, bytes, includeEvidence });
  else printLine(`Exported ${reportType} → ${filePath} (${bytes} bytes).`);
  return EXIT.SUCCESS;
}
