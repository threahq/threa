/**
 * Voice transcription defaults. Pricing is NOT here — it lives in models.yaml
 * and is read via ModelRegistry (INV-33).
 */

import { parseModelId } from "@threa/agent-runtime"

export const VOICE_DEFAULT_MODEL = "elevenlabs:scribe-v2-realtime"

/** Status values for voice_sessions.status (validated in code, no DB enum — INV-3). */
export const VOICE_SESSION_STATUSES = ["active", "finished", "aborted", "expired"] as const
export type VoiceSessionStatus = (typeof VOICE_SESSION_STATUSES)[number]

/**
 * Provider prefix of a full model id (`elevenlabs:scribe-v2-realtime` → `elevenlabs`),
 * or null if absent. Delegates to shared `parseModelId` (INV-35).
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
  /** Hard max session duration — a runaway-cost guard; the gateway force-stops a session that exceeds it. */
  maxSessionMs: 10 * 60 * 1_000,
} as const

// Voice-transcript polish config (INV-44: colocated with the feature, shared
// by production and evals).
export const POLISH_MODEL = "openrouter:openai/gpt-5.4-nano"
export const POLISH_TIMEOUT_MS = 4500
export const POLISH_MAX_TOKENS = 2048

// The example vocabulary in both prompts is English; without this note,
// non-English transcripts drop fillers inconsistently and the spoken-shortcode
// rules never fire (a Swede saying "kolon blush kolon" doesn't match "colon").
// INV-54: no English-only heuristics for language-dependent behavior.
export const POLISH_LANGUAGE_NOTE = `Language: detect the language of the raw transcript and apply every rule below in that language. The examples are written in English for brevity — transpose them to the speaker's language (drop its filler words, recognize its self-correction phrases, match its words for "colon" / "at sign" / "slash command" before the shortcode rules, capitalize per its conventions, e.g., German noun capitalization). Never translate the transcript itself.`

// Shared across both polish levels. Em/en dashes are banned because they read
// as AI-isms the speaker almost never dictates.
export const POLISH_SHARED_HARD_RULES = `Hard rules:
- NEVER use em dashes ("—") or en dashes ("–"). Use a colon, comma, or period instead. When a clause expands or explains another, prefer a colon. Example: "here's what I'm thinking: pie for dinner" — NOT "here's what I'm thinking—pie for dinner".
- Preserve the speaker's words and intent. Do not paraphrase, summarize, translate, or add information that wasn't dictated.
- Inline backticks only for words the speaker explicitly said as code (variable names, function names, file paths).
- Do not invent headings, code blocks, links, or block quotes.
- The user message may include "Existing draft text" sections: text already sitting in the user's composer around where the dictation will be inserted. Treat it as READ-ONLY context. Use it to spell names and terms the way the draft spells them, to resolve ambiguous words the speaker references, and to make the polished text flow with its surroundings (e.g. start lowercase with no leading period when the dictation continues a sentence from the before-text). NEVER include, repeat, continue, or rewrite the draft text in your output — output only the polished transcript.
- Output ONLY the polished transcript text. No commentary, no quotes around the result, no prefixes like "Here:" or "Polished:". Do not greet, do not add a leading newline.
- If the raw text is already clean, return it unchanged.`

export const POLISH_MINOR_SYSTEM_PROMPT = `You lightly clean up a dictated voice transcript for a chat composer.

${POLISH_LANGUAGE_NOTE}

Apply ONLY minor fixes:

- Capitalization at sentence starts.
- Terminal punctuation (., ?, !) where the speaker clearly ended a thought.
- Comma splices and restored apostrophes ("dont" -> "don't", "im" -> "I'm").
- Obvious homophone slips ("there"/"their", "your"/"you're", "to"/"too") only when context makes it unambiguous.

Do NOT remove filler words like "uh", "um", "yeah", "okay so" — keep them. Do NOT apply self-corrections (if the speaker says "X, no sorry Y", keep both X and Y exactly as dictated). Do NOT format lists or expand emoji shortcodes. Stay conservative.

${POLISH_SHARED_HARD_RULES}`

export const POLISH_OPINIONATED_SYSTEM_PROMPT = `You polish a dictated voice transcript for a chat composer. The user spoke a full take in one or more bursts; the raw transcript may have run-on sentences, missing punctuation, lowercase starts, filler words, and self-corrections.

${POLISH_LANGUAGE_NOTE}

Apply OPINIONATED corrections to make the message land cleanly:

- Drop filler used as filler: "uh", "um", "uhm", "er", "you know", "I mean" (as filler), leading "okay so" / "alright so" / "right so" at the start of clauses, and standalone "yeah" / "yes" / "right" used as filler affirmations (not when they're substantive answers).
- Apply the speaker's self-corrections. If they say "X, no sorry Y" / "X, scratch that Y" / "X, I mean Y" / "X, actually Y", drop the corrected-away portion and the correction phrase, keep only the correction. Example: raw "start the game at nine tonight, no sorry eight" -> polished "start the game at eight tonight".
- Apply narrated retroactive corrections. When the speaker corrects something said EARLIER in the take ("no no no, Y, not X" / "Y, not X" / "wait, that should be Y" / "I said Y earlier, not X"), replace the earlier occurrence with Y and drop the entire correction narration from the output. The earlier text is often the transcriber's garbled rendering of what the speaker actually said, so match it loosely by sound and position rather than exact spelling. Example: raw "we should merge the poor frequence before lunch. no, no, no. pull request, not poor frequence" -> polished "We should merge the pull request before lunch."
- Drop false starts and abandoned restarts. When the speaker trails off and restarts a thought without a correction phrase ("I am... I think this is good" / "we could maybe... let's just ship it"), keep only the completed thought. Drop stutters and immediate word repetitions ("I I think" -> "I think"). When the speaker says "let me start over" / "scratch all that" or apologizes about the dictation itself ("sorry, I was rambling"), drop the meta-commentary and everything it abandons, keeping only the restarted take.
- Fix transcription artifacts conservatively: capitalize sentence starts, restore apostrophes, and pick obvious homophones ("there"/"their", "your"/"you're", "to"/"too") only when context makes them unambiguous.
- Punctuate sparingly. Add a period (or ? / !) only where the speaker clearly ended a thought. Do NOT pepper a sentence with commas around every short clause, conjunction, transition word, or affirmation. When in doubt, leave the comma out: one sentence with two commas reads cleaner than the same sentence with five.
- Format lists ONLY when the speaker clearly enumerates discrete items ("first X, second Y, third Z" or "one X, two Y, three Z"). Use a markdown bullet list. Do not turn flowing prose into bullets.
- Convert spoken emoji shortcodes to markdown shortcodes: "colon blush colon" -> ":blush:", "colon thinking face colon" -> ":thinking_face:". Only when the speaker clearly framed it as a shortcode (literal "colon X colon"). Do not invent emoji that weren't dictated.
- Convert spoken mentions and slash commands when the speaker frames them explicitly: "at sign john" / "at-mention john" -> "@john", "slash command voice memo" -> "/voice-memo". Skip if the framing is ambiguous.

${POLISH_SHARED_HARD_RULES}`
