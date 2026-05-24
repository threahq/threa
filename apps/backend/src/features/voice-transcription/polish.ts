import type { VoicePolishLevel } from "@threa/types"
import type { AI } from "../../lib/ai/ai"
import { logger } from "../../lib/logger"

export const POLISH_MODEL = "openrouter:openai/gpt-5.4-nano"
const POLISH_TIMEOUT_MS = 4500
const POLISH_MAX_TOKENS = 2048

// Shared at the top of every system prompt. Two things matter to the user
// strongly enough to bake into both levels:
//   1. No em dashes ("—") and no en dashes ("–"). They read as AI-isms and
//      the speaker almost never dictates them. Substitute a colon when one
//      clause expands or explains another, otherwise a comma or a period.
//   2. Output ONLY the polished transcript text — no commentary, no quotes
//      around the result, no "Here:" / "Polished:" prefix.
const SHARED_HARD_RULES = `Hard rules:
- NEVER use em dashes ("—") or en dashes ("–"). Use a colon, comma, or period instead. When a clause expands or explains another, prefer a colon. Example: "here's what I'm thinking: pie for dinner" — NOT "here's what I'm thinking—pie for dinner".
- Preserve the speaker's words and intent. Do not paraphrase, summarize, translate, or add information that wasn't dictated.
- Inline backticks only for words the speaker explicitly said as code (variable names, function names, file paths).
- Do not invent headings, code blocks, links, or block quotes.
- Output ONLY the polished transcript text. No commentary, no quotes around the result, no prefixes like "Here:" or "Polished:". Do not greet, do not add a leading newline.
- If the raw text is already clean, return it unchanged.`

const MINOR_SYSTEM_PROMPT = `You lightly clean up a dictated voice transcript for a chat composer. Apply ONLY minor fixes:

- Capitalization at sentence starts.
- Terminal punctuation (., ?, !) where the speaker clearly ended a thought.
- Comma splices and restored apostrophes ("dont" -> "don't", "im" -> "I'm").
- Obvious homophone slips ("there"/"their", "your"/"you're", "to"/"too") only when context makes it unambiguous.

Do NOT remove filler words like "uh", "um", "yeah", "okay so" — keep them. Do NOT apply self-corrections (if the speaker says "X, no sorry Y", keep both X and Y exactly as dictated). Do NOT format lists or expand emoji shortcodes. Stay conservative.

${SHARED_HARD_RULES}`

const OPINIONATED_SYSTEM_PROMPT = `You polish a dictated voice transcript for a chat composer. The user spoke a full take in one or more bursts; the raw transcript may have run-on sentences, missing punctuation, lowercase starts, filler words, and self-corrections. Apply OPINIONATED corrections to make the message land cleanly:

- Drop filler used as filler: "uh", "um", "uhm", "er", "you know", "I mean" (as filler), leading "okay so" / "alright so" / "right so" at the start of clauses, and standalone "yeah" / "yes" / "right" used as filler affirmations (not when they're substantive answers).
- Apply the speaker's self-corrections. If they say "X, no sorry Y" / "X, scratch that Y" / "X, I mean Y" / "X, actually Y", drop the corrected-away portion and the correction phrase, keep only the correction. Example: raw "start the game at nine tonight, no sorry eight" -> polished "start the game at eight tonight".
- Fix transcription artifacts: capitalization at sentence start, terminal punctuation, comma splices, restored apostrophes, obvious homophone slips ("there"/"their", "your"/"you're", "to"/"too") only when context makes it unambiguous.
- Format lists ONLY when the speaker clearly enumerates discrete items ("first X, second Y, third Z" or "one X, two Y, three Z"). Use a markdown bullet list. Do not turn flowing prose into bullets.
- Convert spoken emoji shortcodes to markdown shortcodes: "colon blush colon" -> ":blush:", "colon thinking face colon" -> ":thinking_face:". Only when the speaker clearly framed it as a shortcode (literal "colon X colon"). Do not invent emoji that weren't dictated.
- Convert spoken mentions and slash commands when the speaker frames them explicitly: "at sign john" / "at-mention john" -> "@john", "slash command voice memo" -> "/voice-memo". Skip if the framing is ambiguous.

${SHARED_HARD_RULES}`

export interface PolishTranscriptInput {
  rawTranscript: string
  level: VoicePolishLevel
  workspaceId: string
  userId: string
  sessionId: string
}

export type PolishTranscript = (input: PolishTranscriptInput) => Promise<string>

/**
 * Builds the polish entrypoint used by the voice relay. The level controls
 * how aggressive the rewrite is: "minor" only fixes punctuation/capitalization
 * and leaves filler/self-corrections alone; "opinionated" drops filler, applies
 * self-corrections, formats clearly-enumerated lists, and expands spoken emoji
 * shortcodes. "none" never reaches here — the gateway short-circuits.
 *
 * On timeout or upstream error this never throws; it logs and returns the raw
 * text so dictation always commits something.
 */
export function createPolishTranscript(deps: { ai: AI }): PolishTranscript {
  return async ({ rawTranscript, level, workspaceId, userId, sessionId }) => {
    const trimmed = rawTranscript.trim()
    if (!trimmed) return rawTranscript

    const systemPrompt = level === "opinionated" ? OPINIONATED_SYSTEM_PROMPT : MINOR_SYSTEM_PROMPT

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS)

    try {
      const result = await deps.ai.generateText({
        model: POLISH_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Raw transcript:\n${trimmed}` },
        ],
        maxTokens: POLISH_MAX_TOKENS,
        temperature: 0.2,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
            level,
          },
        },
        context: { workspaceId, userId, origin: "user" },
        abortSignal: controller.signal,
      })

      const polished = result.value.trim()
      if (!polished) return rawTranscript
      // Safety net: even with the prompt rule, providers occasionally slip an
      // em-dash through. Strip it deterministically so the user never sees one
      // they didn't dictate. We replace with " — "? No — that's the same dash.
      // Use a colon when it sits between words with no spaces (" — " pattern),
      // otherwise a comma. Keep it cheap; this isn't a parser.
      return scrubDashes(polished)
    } catch (err) {
      logger.warn({ err, sessionId, workspaceId, level }, "Voice transcript polish failed; falling back to raw")
      return rawTranscript
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Belt-and-suspenders for the "no em-dash" rule. The polish model is told not
 * to use em or en dashes, but providers slip them through often enough that the
 * user notices. Replace them with punctuation that reads naturally:
 *   - " — " / " – " between clauses → ": " (clause expansion / explanation)
 *   - "word—word" / "word–word"     → "word, word" (interruption / list)
 * A regular ASCII hyphen "-" is left alone (it's used in legitimate compounds).
 */
export function scrubDashes(text: string): string {
  return text.replace(/\s+[—–]\s+/g, ": ").replace(/[—–]/g, ", ")
}
