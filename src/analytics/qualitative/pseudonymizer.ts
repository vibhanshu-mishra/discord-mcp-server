/**
 * Per-response user pseudonymisation. Within one tool response, each user maps to
 * a stable generic label (Primary User / Staff N / Member N). Labels are NOT
 * stable across unrelated responses — they are assigned in first-seen order per
 * instance. Discord user IDs, usernames, and display names never appear in a
 * pseudonymised output; the staff-vs-member distinction is preserved.
 */
import type { QualitativeConfig } from "./config.js";

/** The identity fields a qualitative output may expose for one user. */
export interface UserIdentity {
  /** Generic label, present when pseudonymisation is enabled. */
  label?: string;
  /** Raw Discord user ID, present only when pseudonymisation is OFF and content output is ON. */
  userId?: string;
  isStaff: boolean;
}

export class Pseudonymizer {
  private readonly labels = new Map<string, string>();
  private staffCount = 0;
  private memberCount = 0;

  constructor(
    private readonly config: QualitativeConfig,
    /** Whether readable content output is permitted (gates exposing raw IDs). */
    private readonly contentAllowed: boolean,
    private readonly staffIds: ReadonlySet<string>,
    private readonly primaryUserId: string | null,
  ) {}

  private assignLabel(userId: string, isStaff: boolean): string {
    const existing = this.labels.get(userId);
    if (existing) return existing;
    let label: string;
    if (this.primaryUserId && userId === this.primaryUserId) label = "Primary User";
    else if (isStaff) label = `Staff ${++this.staffCount}`;
    else label = `Member ${++this.memberCount}`;
    this.labels.set(userId, label);
    return label;
  }

  /** Resolves a user to the identity fields allowed by the current policy. */
  identify(userId: string | null): UserIdentity {
    const isStaff = userId !== null && this.staffIds.has(userId);
    if (userId === null) return { isStaff: false };
    if (this.config.pseudonymizeUsers) {
      return { label: this.assignLabel(userId, isStaff), isStaff };
    }
    // Pseudonymisation OFF: raw IDs only when content output is also enabled.
    return this.contentAllowed ? { userId, isStaff } : { isStaff };
  }
}
