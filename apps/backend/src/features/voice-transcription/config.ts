/**
 * Voice transcription defaults, shared by the service, gateway, and strategies.
 * Pricing is NOT here — it lives in models.yaml and is read via ModelRegistry (INV-33).
 */

export const VOICE_DEFAULT_MODEL = "elevenlabs:scribe-v2-realtime"

/** Status values for voice_sessions.status (validated in code, no DB enum — INV-3). */
export const VOICE_SESSION_STATUSES = ["active", "finished", "aborted", "expired"] as const
export type VoiceSessionStatus = (typeof VOICE_SESSION_STATUSES)[number]

/**
 * Extract the provider prefix from a full model id
 * (`elevenlabs:scribe-v2-realtime` → `elevenlabs`). Returns null when the id
 * carries no provider prefix; callers decide how to surface that.
 */
export function parseModelProvider(model: string): string | null {
  const colon = model.indexOf(":")
  return colon === -1 ? null : model.slice(0, colon)
}

export const voiceConfig = {
  defaultModel: VOICE_DEFAULT_MODEL,
  /** PCM16 mono sample rate captured client-side and expected by upstream STT. */
  sampleRateHz: 16_000,
  /** Approximate audio frame size the client emits, in ms (~100ms PCM16 frames). */
  frameMs: 100,
  /**
   * Hard max session duration — a cheap runaway-cost guard for the PR1 skeleton.
   * The gateway force-stops a session that exceeds this. Full idle-timeout +
   * sweeper-driven expiry land in PR2.
   */
  maxSessionMs: 10 * 60 * 1_000,
} as const
