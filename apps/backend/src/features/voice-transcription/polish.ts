import type { VoicePolishLevel } from "@threa/types"
import type { AI } from "@threa/agent-runtime"
import { parseMarkdown } from "@threa/prosemirror"
import type { JSONContent } from "@threa/types"
import { logger } from "../../lib/logger"
import {
  POLISH_MINOR_SYSTEM_PROMPT,
  POLISH_OPINIONATED_SYSTEM_PROMPT,
  voicePolishConfig,
  type VoicePolishConfig,
} from "./config"

export interface PolishTranscriptInput {
  rawTranscript: string
  level: VoicePolishLevel
  workspaceId: string
  userId: string
  sessionId: string
  draftBefore?: string
  draftAfter?: string
  steeringTerms?: string[]
  previousAcceptedMarkdown?: string
  deadline?: "live" | "final"
  signal?: AbortSignal
}

export type PolishOutcome =
  | { status: "success"; markdown: string; contentJson: JSONContent }
  | { status: "empty_input" }
  | { status: "invalid_output"; reason: "empty" | "truncated" | "unparseable" }
  | { status: "timeout" }
  | { status: "canceled" }
  | { status: "provider_error" }

export type PolishTranscript = (input: PolishTranscriptInput) => Promise<PolishOutcome>

export function createPolishTranscript(deps: { ai: AI; config?: VoicePolishConfig }): PolishTranscript {
  const config = deps.config ?? voicePolishConfig
  return async ({
    rawTranscript,
    level,
    workspaceId,
    userId,
    sessionId,
    draftBefore,
    draftAfter,
    steeringTerms,
    previousAcceptedMarkdown,
    deadline = "live",
    signal,
  }) => {
    const trimmed = rawTranscript.trim()
    if (!trimmed) return { status: "empty_input" }
    if (level === "none") return parsePolishSuccess(trimmed)

    const systemPrompt = level === "opinionated" ? POLISH_OPINIONATED_SYSTEM_PROMPT : POLISH_MINOR_SYSTEM_PROMPT
    const userMessage = buildPolishUserMessage({
      rawTranscript: trimmed,
      draftBefore,
      draftAfter,
      steeringTerms,
      previousAcceptedMarkdown,
    })
    const controller = new AbortController()
    let timedOut = false
    const onCancel = () => controller.abort()
    signal?.addEventListener("abort", onCancel, { once: true })
    const timer = setTimeout(
      () => {
        timedOut = true
        controller.abort()
      },
      deadline === "final" ? config.finalTimeoutMs : config.liveTimeoutMs
    )

    try {
      if (signal?.aborted) return { status: "canceled" }
      const result = await deps.ai.generateText({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
            draftContextLen: (draftBefore?.length ?? 0) + (draftAfter?.length ?? 0),
            steeringTermCount: steeringTerms?.length ?? 0,
            level,
          },
        },
        context: { workspaceId, userId, origin: "user" },
        abortSignal: controller.signal,
      })
      if (signal?.aborted) return { status: "canceled" }
      if (timedOut) return { status: "timeout" }
      const finishReason =
        (result as { finishReason?: string; response?: { finishReason?: string } }).finishReason ??
        (result as { response?: { finishReason?: string } }).response?.finishReason
      if (finishReason === "length") return { status: "invalid_output", reason: "truncated" }
      const polished = result.value.trim()
      if (!polished) return { status: "invalid_output", reason: "empty" }
      return parsePolishSuccess(scrubDashes(polished))
    } catch (err) {
      if (signal?.aborted) return { status: "canceled" }
      if (timedOut) return { status: "timeout" }
      logger.warn({ err, sessionId, workspaceId, level }, "Voice transcript polish provider failed")
      return { status: "provider_error" }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onCancel)
    }
  }
}

function parsePolishSuccess(markdown: string): PolishOutcome {
  try {
    const contentJson = parseMarkdown(markdown)
    return { status: "success", markdown, contentJson }
  } catch {
    return { status: "invalid_output", reason: "unparseable" }
  }
}

export function buildPolishUserMessage(args: {
  rawTranscript: string
  draftBefore?: string
  draftAfter?: string
  steeringTerms?: string[]
  previousAcceptedMarkdown?: string
}): string {
  const sections: string[] = []
  const before = args.draftBefore?.trim()
  const after = args.draftAfter?.trim()
  const steeringTerms = args.steeringTerms?.filter((t) => t.trim())
  const previousAccepted = args.previousAcceptedMarkdown?.trim()
  if (steeringTerms?.length)
    sections.push(
      `Spelling reference (normalize mis-transcriptions to these exact spellings):\n${steeringTerms.join(", ")}`
    )
  if (previousAccepted)
    sections.push(
      `Previously accepted polish (READ-ONLY revision reference):\n${previousAccepted}\n\nCopy its wording and Markdown block structure verbatim, then apply only the correction or extension introduced by the cumulative raw transcript. Keep existing list type, list-item boundaries, paragraph boundaries, capitalization, and punctuation unless the new speech explicitly changes them. Output the complete dictated take only; never echo this section separately.`
    )
  if (before)
    sections.push(`Existing draft text before the insertion point (context only, never output it):\n${before}`)
  if (after) sections.push(`Existing draft text after the insertion point (context only, never output it):\n${after}`)
  sections.push(`Raw transcript:\n${args.rawTranscript}`)
  return sections.join("\n\n")
}

export function scrubDashes(text: string): string {
  return text.replace(/\s+[—–]\s+/g, ": ").replace(/[—–]/g, ", ")
}
