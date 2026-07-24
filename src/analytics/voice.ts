/**
 * Voice-attendance logic, kept pure and Discord-agnostic so it can be unit-tested
 * without a gateway connection. It maps a "voice state changed" event (a member's
 * channel before/after) onto open/close operations on the repository.
 *
 * Historical attendance is NEVER fabricated: sessions are only ever opened while
 * the bot is running, and open sessions found after a restart are flagged
 * incomplete rather than given an invented leave time.
 */
import type { AnalyticsRepository } from "./repository.js";

/** The minimal, Discord-agnostic view of a member's voice state at one instant. */
export interface VoiceStateLike {
  guildId: string | null;
  channelId: string | null;
  userId: string;
  isBot: boolean;
}

export interface VoiceHandlerOptions {
  /** Guild authorisation gate (analytics list AND allow-list). */
  isAuthorised: (guildId: string) => boolean;
  /** Master switch for voice collection. */
  collectVoice: boolean;
  /** Override "now" for deterministic tests. */
  at?: string;
}

/**
 * Reconciles a voice-state transition into session open/close calls.
 *  - join  (no old channel → new channel): open a session
 *  - leave (old channel → no new channel): close the open session
 *  - move  (old channel → different new channel): close then open
 *  - same channel (mute/deafen only): ignored
 * Duplicate joins are ignored by the repository's single-open-session guard.
 */
export function handleVoiceStateChange(
  repo: AnalyticsRepository,
  previous: VoiceStateLike | null,
  next: VoiceStateLike | null,
  opts: VoiceHandlerOptions,
): void {
  if (!opts.collectVoice) return;

  const guildId = next?.guildId ?? previous?.guildId ?? null;
  if (!guildId || !opts.isAuthorised(guildId)) return;

  const userId = next?.userId ?? previous?.userId;
  if (!userId) return;
  const isBot = next?.isBot ?? previous?.isBot ?? false;

  const oldChannel = previous?.channelId ?? null;
  const newChannel = next?.channelId ?? null;

  if (oldChannel === newChannel) return; // no channel change

  const at = opts.at;
  if (oldChannel !== null) {
    repo.closeVoiceSession(guildId, userId, at);
  }
  if (newChannel !== null) {
    repo.openVoiceSession({
      guild_id: guildId,
      channel_id: newChannel,
      user_id: userId,
      user_is_bot: isBot,
      joined_at: at,
    });
  }
}

/**
 * Called once at startup: any session left open by a previous process cannot be
 * given a real leave time, so it is flagged incomplete. Returns the count fixed.
 */
export function recoverOpenSessions(repo: AnalyticsRepository): number {
  return repo.markOpenSessionsIncomplete();
}
