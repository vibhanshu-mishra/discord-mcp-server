/**
 * Tiny, dependency-free CLI argument parser and output helpers. Supports
 * `--flag`, `--key value`, and `--key=value`. Human output goes to stdout;
 * `--json` mode emits a single JSON document. No external CLI framework is used.
 */
import { CliError, EXIT } from "./exitCodes.js";

export class Args {
  constructor(
    public readonly positionals: string[],
    private readonly flags: Map<string, string | true>,
  ) {}

  has(name: string): boolean {
    return this.flags.has(name);
  }
  bool(name: string): boolean {
    return this.flags.get(name) === true || this.flags.get(name) === "true";
  }
  get(name: string): string | undefined {
    const v = this.flags.get(name);
    return typeof v === "string" ? v : undefined;
  }
  /** Returns a required string flag or throws an invalid-argument CliError. */
  require(name: string): string {
    const v = this.get(name);
    if (v === undefined || v.length === 0) {
      throw new CliError(`Missing required argument: --${name}`, EXIT.INVALID_ARG);
    }
    return v;
  }
}

/** Parses `argv` (already past the command) into positionals and flags. */
export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return new Args(positionals, flags);
}

/** Prints a JSON document to stdout (machine-readable mode). */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** Prints a plain line to stdout. */
export function printLine(line = ""): void {
  process.stdout.write(line + "\n");
}
