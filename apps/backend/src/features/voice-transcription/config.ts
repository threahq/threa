/**
 * Voice transcription defaults, shared by the service, gateway, and strategies.
 * Pricing is NOT here — it lives in models.yaml and is read via ModelRegistry (INV-33).
 */

import { parseModelId } from "../../lib/ai/ai"

export const VOICE_DEFAULT_MODEL = "elevenlabs:scribe-v2-realtime"

/** Status values for voice_sessions.status (validated in code, no DB enum — INV-3). */
export const VOICE_SESSION_STATUSES = ["active", "finished", "aborted", "expired"] as const
export type VoiceSessionStatus = (typeof VOICE_SESSION_STATUSES)[number]

/**
 * Extract the provider prefix from a full model id
 * (`elevenlabs:scribe-v2-realtime` → `elevenlabs`). Returns null when the id
 * carries no provider prefix; callers decide how to surface that. Delegates to
 * the shared `parseModelId` so model-id parsing lives in one place (INV-35).
 */
export function parseModelProvider(model: string): string | null {
  try {
    return parseModelId(model).provider
  } catch {
    return null
  }
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

// Voice-transcript polish config (INV-44: colocated with the feature, shared
// by production and evals).
export const POLISH_MODEL = "openrouter:openai/gpt-5.4-nano"
export const POLISH_TIMEOUT_MS = 4500
export const POLISH_MAX_TOKENS = 2048

// Shared at the top of every polish system prompt. Two things matter to the
// user strongly enough to bake into both levels:
//   1. No em dashes ("—") and no en dashes ("–"). They read as AI-isms and
//      the speaker almost never dictates them. Substitute a colon when one
//      clause expands or explains another, otherwise a comma or a period.
//   2. Output ONLY the polished transcript text — no commentary, no quotes
//      around the result, no "Here:" / "Polished:" prefix.
export const POLISH_SHARED_HARD_RULES = `Hard rules:
- NEVER use em dashes ("—") or en dashes ("–"). Use a colon, comma, or period instead. When a clause expands or explains another, prefer a colon. Example: "here's what I'm thinking: pie for dinner" — NOT "here's what I'm thinking—pie for dinner".
- Preserve the speaker's words and intent. Do not paraphrase, summarize, translate, or add information that wasn't dictated.
- Inline backticks only for words the speaker explicitly said as code (variable names, function names, file paths).
- Do not invent headings, code blocks, links, or block quotes.
- Output ONLY the polished transcript text. No commentary, no quotes around the result, no prefixes like "Here:" or "Polished:". Do not greet, do not add a leading newline.
- If the raw text is already clean, return it unchanged.`

export const POLISH_MINOR_SYSTEM_PROMPT = `You lightly clean up a dictated voice transcript for a chat composer. Apply ONLY minor fixes:

- Capitalization at sentence starts.
- Terminal punctuation (., ?, !) where the speaker clearly ended a thought.
- Comma splices and restored apostrophes ("dont" -> "don't", "im" -> "I'm").
- Obvious homophone slips ("there"/"their", "your"/"you're", "to"/"too") only when context makes it unambiguous.

Do NOT remove filler words like "uh", "um", "yeah", "okay so" — keep them. Do NOT apply self-corrections (if the speaker says "X, no sorry Y", keep both X and Y exactly as dictated). Do NOT format lists or expand emoji shortcodes. Stay conservative.

${POLISH_SHARED_HARD_RULES}`

export const POLISH_OPINIONATED_SYSTEM_PROMPT = `You polish a dictated voice transcript for a chat composer. The user spoke a full take in one or more bursts; the raw transcript may have run-on sentences, missing punctuation, lowercase starts, filler words, and self-corrections. Apply OPINIONATED corrections to make the message land cleanly:

- Drop filler used as filler: "uh", "um", "uhm", "er", "you know", "I mean" (as filler), leading "okay so" / "alright so" / "right so" at the start of clauses, and standalone "yeah" / "yes" / "right" used as filler affirmations (not when they're substantive answers).
- Apply the speaker's self-corrections. If they say "X, no sorry Y" / "X, scratch that Y" / "X, I mean Y" / "X, actually Y", drop the corrected-away portion and the correction phrase, keep only the correction. Example: raw "start the game at nine tonight, no sorry eight" -> polished "start the game at eight tonight".
- Fix transcription artifacts conservatively: capitalize sentence starts, restore apostrophes, and pick obvious homophones ("there"/"their", "your"/"you're", "to"/"too") only when context makes them unambiguous.
- Punctuate sparingly. Add a period (or ? / !) only where the speaker clearly ended a thought. Do NOT pepper a sentence with commas around every short clause, conjunction, transition word, or affirmation. When in doubt, leave the comma out: one sentence with two commas reads cleaner than the same sentence with five.
- Format lists ONLY when the speaker clearly enumerates discrete items ("first X, second Y, third Z" or "one X, two Y, three Z"). Use a markdown bullet list. Do not turn flowing prose into bullets.
- Convert spoken emoji shortcodes to markdown shortcodes: "colon blush colon" -> ":blush:", "colon thinking face colon" -> ":thinking_face:". Only when the speaker clearly framed it as a shortcode (literal "colon X colon"). Do not invent emoji that weren't dictated.
- Convert spoken mentions and slash commands when the speaker frames them explicitly: "at sign john" / "at-mention john" -> "@john", "slash command voice memo" -> "/voice-memo". Skip if the framing is ambiguous.

${POLISH_SHARED_HARD_RULES}`
