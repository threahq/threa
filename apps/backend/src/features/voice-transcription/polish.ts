import type { VoicePolishLevel } from "@threahq/types"
import type { AI, UsageWithCost } from "@threahq/agent-runtime"
import { parseMarkdown } from "@threahq/prosemirror"
import type { JSONContent } from "@threahq/types"
import { logger } from "../../lib/logger"
import { safeProviderError } from "./safe-error"
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
  readOnlyPredecessorMarkdown?: string
  targetMode?: "legacy" | "tail" | "widen"
  deadline?: "live" | "final"
  stage?: "format_live" | "format_final" | "format_widen"
  sourceWindowCount?: number
  finalCount?: number
  protocolVersion?: number
  signal?: AbortSignal
}

export type PolishOutcome =
  | { status: "success"; markdown: string; contentJson: JSONContent }
  | { status: "empty_input" }
  | { status: "invalid_output"; reason: "empty" | "truncated" | "unparseable" }
  | { status: "timeout" }
  | { status: "canceled" }
  | { status: "provider_error" }
  | { status: "preserve_raw" }
  | { status: "replacement_rejected" }

export type PolishTranscript = (input: PolishTranscriptInput) => Promise<PolishOutcome>

export interface VoicePolishAttempt {
  stage: "scope" | "normal_live" | "normal_final" | "widen"
  deadline: "live" | "final"
  durationMs: number
  outcome: PolishOutcome["status"] | "success"
  rawScalarLength: number
  sourceWindowCount: number
  finalCount?: number
  reasoningEffort: VoicePolishConfig["reasoningEffort"]
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
}

export type VoicePolishAttemptObserver = (attempt: VoicePolishAttempt) => void

export function createPolishTranscript(deps: {
  ai: AI
  config?: VoicePolishConfig
  parseMarkdown?: (markdown: string) => JSONContent
  onAttempt?: VoicePolishAttemptObserver
}): PolishTranscript {
  const config = deps.config ?? voicePolishConfig
  const parse = deps.parseMarkdown ?? parseMarkdown
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
    readOnlyPredecessorMarkdown,
    targetMode = "legacy",
    deadline = "live",
    stage,
    sourceWindowCount = 1,
    finalCount,
    protocolVersion = 3,
    signal,
  }) => {
    const trimmed = rawTranscript.trim()
    if (!trimmed) return { status: "empty_input" }
    if (level === "none") return parsePolishSuccess(trimmed, parse)

    const systemPrompt = level === "opinionated" ? POLISH_OPINIONATED_SYSTEM_PROMPT : POLISH_MINOR_SYSTEM_PROMPT
    const userMessage = buildPolishUserMessage({
      rawTranscript: trimmed,
      draftBefore,
      draftAfter,
      steeringTerms,
      previousAcceptedMarkdown,
      readOnlyPredecessorMarkdown,
      targetMode,
    })
    const controller = new AbortController()
    const startedAt = performance.now()
    const draftLength = (draftBefore?.length ?? 0) + (draftAfter?.length ?? 0)
    let usage: UsageWithCost | undefined
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

    const complete = (outcome: PolishOutcome, providerError?: unknown): PolishOutcome => {
      const durationMs = Math.round(performance.now() - startedAt)
      let attemptStage: VoicePolishAttempt["stage"] = deadline === "final" ? "normal_final" : "normal_live"
      if (stage === "format_widen") attemptStage = "widen"
      deps.onAttempt?.({
        stage: attemptStage,
        deadline,
        durationMs,
        outcome: outcome.status,
        rawScalarLength: Array.from(trimmed).length,
        sourceWindowCount,
        finalCount,
        reasoningEffort: config.reasoningEffort,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        reasoningTokens: usage?.reasoningTokens,
      })
      logger.info(
        {
          sessionId,
          workspaceId,
          level,
          outcome: outcome.status,
          invalidReason: outcome.status === "invalid_output" ? outcome.reason : undefined,
          deadline,
          deadlineMs: deadline === "final" ? config.finalTimeoutMs : config.liveTimeoutMs,
          durationMs,
          stage: attemptStage,
          protocolVersion,
          sourceWindowCount,
          finalCount,
          rawLength: Array.from(trimmed).length,
          readOnlyContextLength:
            Array.from(previousAcceptedMarkdown ?? "").length +
            Array.from(readOnlyPredecessorMarkdown ?? "").length +
            draftLength,
          draftLength,
          steeringTermCount: steeringTerms?.length ?? 0,
          reasoningEffort: config.reasoningEffort,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          reasoningTokens: usage?.reasoningTokens,
          ...(providerError === undefined ? {} : safeProviderError(providerError)),
        },
        "Voice transcript polish attempt completed"
      )
      return outcome
    }

    try {
      if (signal?.aborted) return complete({ status: "canceled" })
      const result = await deps.ai.generateText({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        reasoningEffort: config.reasoningEffort,
        telemetry: {
          functionId: "voice-transcript-polish",
          metadata: {
            sessionId,
            rawLen: trimmed.length,
            draftContextLen: draftLength,
            steeringTermCount: steeringTerms?.length ?? 0,
            level,
            stage: stage ?? (deadline === "final" ? "format_final" : "format_live"),
            deadline,
            sourceWindowCount,
            finalCount,
            protocolVersion,
            readOnlyContextLen:
              (previousAcceptedMarkdown?.length ?? 0) + (readOnlyPredecessorMarkdown?.length ?? 0) + draftLength,
            deadlineMs: deadline === "final" ? config.finalTimeoutMs : config.liveTimeoutMs,
            reasoningEffort: config.reasoningEffort,
          },
        },
        context: { workspaceId, userId, origin: "user" },
        abortSignal: controller.signal,
      })
      usage = result.usage
      if (signal?.aborted) return complete({ status: "canceled" })
      if (timedOut) return complete({ status: "timeout" })
      const finishReason =
        (result as { finishReason?: string; response?: { finishReason?: string } }).finishReason ??
        (result as { response?: { finishReason?: string } }).response?.finishReason
      if (finishReason === "length") return complete({ status: "invalid_output", reason: "truncated" })
      const polished = result.value.trim()
      if (!polished) return complete({ status: "invalid_output", reason: "empty" })
      return complete(parsePolishSuccess(scrubDashes(polished), parse))
    } catch (err) {
      if (signal?.aborted) return complete({ status: "canceled" })
      if (timedOut) return complete({ status: "timeout" })
      return complete({ status: "provider_error" }, err)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onCancel)
    }
  }
}

function parsePolishSuccess(markdown: string, parse: (markdown: string) => JSONContent): PolishOutcome {
  try {
    const contentJson = parse(markdown)
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
  readOnlyPredecessorMarkdown?: string
  targetMode?: "legacy" | "tail" | "widen"
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
  if (previousAccepted) {
    const instruction =
      args.targetMode === "tail"
        ? "This is an earlier accepted revision of the SAME mutable window. The raw transcript below is the complete cumulative target: preserve this wording and Markdown structure where compatible, incorporate newly appended speech, and output the complete current window."
        : "Copy its wording and Markdown block structure verbatim, then apply only the correction or extension introduced by the cumulative raw transcript. Keep existing list type, list-item boundaries, paragraph boundaries, capitalization, and punctuation unless the new speech explicitly changes them. Output the complete replacement target only; never echo this section separately."
    sections.push(`Previously accepted polish (revision reference):\n${previousAccepted}\n\n${instruction}`)
  }
  const readOnlyPredecessor = args.readOnlyPredecessorMarkdown?.trim()
  if (readOnlyPredecessor)
    sections.push(
      `Immediate predecessor accepted Markdown (READ-ONLY context):\n${readOnlyPredecessor}\n\nUse it only to resolve the boundary. Output only the current raw window; never copy or rewrite this section.`
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
