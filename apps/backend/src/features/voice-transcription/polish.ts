import type { VoicePolishLevel } from "@threa/types"
import type { AI } from "@threa/agent-runtime"
import { logger } from "../../lib/logger"
import {
  POLISH_MAX_TOKENS,
  POLISH_MINOR_SYSTEM_PROMPT,
  POLISH_MODEL,
  POLISH_OPINIONATED_SYSTEM_PROMPT,
  POLISH_TIMEOUT_MS,
} from "./config"

export interface PolishTranscriptInput {
  rawTranscript: string
  level: VoicePolishLevel
  workspaceId: string
  userId: string
  sessionId: string
  /**
   * Draft text already in the composer around the dictation insertion point,
   * captured client-side at `voice:start`. Read-only context for the model
   * (vocabulary, names, sentence continuation) — never part of the output.
   */
  draftBefore?: string
  draftAfter?: string
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
  return async ({ rawTranscript, level, workspaceId, userId, sessionId, draftBefore, draftAfter }) => {
    const trimmed = rawTranscript.trim()
    if (!trimmed) return rawTranscript
    // Defense-in-depth: the gateway short-circuits before reaching here, but an
    // explicit guard prevents a future caller from silently falling through to
    // the "minor" branch (INV-11).
    if (level === "none") return rawTranscript

    const systemPrompt = level === "opinionated" ? POLISH_OPINIONATED_SYSTEM_PROMPT : POLISH_MINOR_SYSTEM_PROMPT
    const userMessage = buildPolishUserMessage({ rawTranscript: trimmed, draftBefore, draftAfter })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), POLISH_TIMEOUT_MS)

    try {
      const result = await deps.ai.generateText({
        model: POLISH_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        maxTokens: POLISH_MAX_TOKENS,
        temperature: 0.2,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
            draftContextLen: (draftBefore?.length ?? 0) + (draftAfter?.length ?? 0),
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
      // they didn't dictate.
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
 * Assembles the polish user message. When the composer already holds text, the
 * draft around the insertion point is included as labeled read-only sections so
 * the model can match the draft's vocabulary (names, project terms) and make
 * the polished text flow with the surrounding sentence. The prompt's hard rules
 * tell the model these sections must never appear in the output.
 */
export function buildPolishUserMessage(args: {
  rawTranscript: string
  draftBefore?: string
  draftAfter?: string
}): string {
  const sections: string[] = []
  const before = args.draftBefore?.trim()
  const after = args.draftAfter?.trim()
  if (before) {
    sections.push(
      `Existing draft text before the insertion point (context only, never output it):\n${args.draftBefore}`
    )
  }
  if (after) {
    sections.push(`Existing draft text after the insertion point (context only, never output it):\n${args.draftAfter}`)
  }
  sections.push(`Raw transcript:\n${args.rawTranscript}`)
  return sections.join("\n\n")
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
