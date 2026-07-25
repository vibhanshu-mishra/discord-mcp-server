/**
 * Central, stable process exit codes for every CLI command. Documented once here
 * so operators and scripts can rely on them.
 */
export const EXIT = {
  /** The command completed successfully. */
  SUCCESS: 0,
  /** An unexpected failure (uncaught error). */
  FAILURE: 1,
  /** Unknown command or invalid argument. */
  INVALID_ARG: 2,
  /** Configuration is missing or invalid. */
  CONFIG: 3,
  /** A database open/integrity/schema problem. */
  DATABASE: 4,
  /** Discord connection or authorisation failure (online commands only). */
  DISCORD: 5,
  /** A lock conflict — another writer holds the database lock. */
  LOCK: 6,
  /** The operation partially succeeded (e.g. some channels failed). */
  PARTIAL: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error carrying the exit code a command should terminate with. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly code: ExitCode,
  ) {
    super(message);
    this.name = "CliError";
  }
}
