import type { AI } from "../../lib/ai/ai"
import { logger } from "../../lib/logger"

export const POLISH_MODEL = "openrouter:openai/gpt-5.4-nano"
const POLISH_TIMEOUT_MS = 4500
const POLISH_MAX_TOKENS = 2048

const SYSTEM_PROMPT = `You polish a dictated voice transcript for a chat composer. The user spoke a full take in one or more bursts; the raw transcript may have run-on sentences, missing punctuation, lowercase starts, and obvious filler.

Rules:
- Preserve the speaker's words and intent. Never paraphrase, summarize, expand abbreviations, translate, or add information.
- Fix obvious transcription artifacts: capitalization at sentence start, terminal punctuation, comma splices, restored apostrophes, common homophone slips ("there"/"their") only when context makes it unambiguous.
- Add light markdown only when it is clearly the right shape: bullet items for an enumerated list the speaker dictated as a list, inline backticks only for words the speaker explicitly said as code (e.g. names of variables, function names, files). Do not invent headings, code blocks, links, or quotes.
- Emoji are allowed sparingly when they fit naturally at the end of a clause; never start the transcript with one and never replace words with them. If unsure, omit.
- Output the polished transcript only. No commentary, no quotes around the result, no prefixes like "Here:". Do not greet, do not add a leading newline.
- If the raw text is already clean, return it unchanged.`

export interface PolishTranscriptInput {
  rawTranscript: string
  workspaceId: string
  userId: string
  sessionId: string
}

export type PolishTranscript = (input: PolishTranscriptInput) => Promise<string>

/**
 * Builds the polish entrypoint used by the voice relay. Called once per
 * dictation session, after the user stops — the full raw transcript is sent
 * through a small fast text model and returned in one shot, so the editor
 * swap to polished is a single atomic step.
 *
 * On timeout or upstream error this never throws; it logs and returns the raw
 * text so dictation always commits something.
 */
export function createPolishTranscript(deps: { ai: AI }): PolishTranscript {
  return async ({ rawTranscript, workspaceId, userId, sessionId }) => {
    const trimmed = rawTranscript.trim()
    if (!trimmed) return rawTranscript

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS)

    try {
      const result = await deps.ai.generateText({
        model: POLISH_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Raw transcript:\n${trimmed}` },
        ],
        maxTokens: POLISH_MAX_TOKENS,
        temperature: 0.2,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
          },
        },
        context: { workspaceId, userId, origin: "user" },
        abortSignal: controller.signal,
      })

      const polished = result.value.trim()
      if (!polished) return rawTranscript
      return polished
    } catch (err) {
      logger.warn({ err, sessionId, workspaceId }, "Voice transcript polish failed; falling back to raw")
      return rawTranscript
    } finally {
      clearTimeout(timer)
    }
  }
}
