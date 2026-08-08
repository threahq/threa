import { z } from "zod"
import type { AI } from "@threa/agent-runtime"
import { VOICE_POLISH_WIDEN_MAX_WINDOWS, voicePolishConfig, type VoicePolishConfig } from "./config"
import type { VoicePolishAttemptObserver } from "./polish"
import { logger } from "../../lib/logger"

export const voiceBoundaryScopeSchema = z.object({
  scope: z.enum(["tail", "widen_previous", "preserve_raw"]),
})
export type VoiceBoundaryScope = z.infer<typeof voiceBoundaryScopeSchema>["scope"]

export interface DecideVoiceBoundaryScopeInput {
  currentRaw: string
  predecessorRaw: string
  predecessorMarkdown: string
  olderAcceptedSuffix?: string
  draftBefore?: string
  draftAfter?: string
  workspaceId: string
  userId: string
  sessionId: string
  deadline: "live" | "final"
  finalCount?: number
  signal?: AbortSignal
}

export type VoiceBoundaryScopeOutcome =
  | { status: "success"; scope: VoiceBoundaryScope }
  | { status: "timeout" | "canceled" | "provider_error" }

const SYSTEM_PROMPT = `Choose the smallest safe scope for formatting the current dictation window. Interpret semantic references and boundary phrases in the transcript's own language; never rely on English-only wording.

- Return tail when the current window is an independent new thought or block and only its text must change.
- Return widen_previous when the current window grammatically continues the immediate predecessor, continues its explicitly narrated list or paragraph, or corrects content in exactly that predecessor.
- Return preserve_raw when the current speech targets anything shown only in the older accepted suffix, reaches farther back than the immediate predecessor, is ambiguous, or cannot be safely represented within two windows.

Choose by the location of the intended edit, not merely by repeated words. Read-only context must never become output.`

export function createDecideVoiceBoundaryScope(deps: {
  ai: AI
  config?: VoicePolishConfig
  onAttempt?: VoicePolishAttemptObserver
}) {
  const config = deps.config ?? voicePolishConfig
  return async (input: DecideVoiceBoundaryScopeInput): Promise<VoiceBoundaryScopeOutcome> => {
    const controller = new AbortController()
    const onCancel = () => controller.abort()
    input.signal?.addEventListener("abort", onCancel, { once: true })
    let timedOut = false
    let usage: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } | undefined
    let outcome: VoiceBoundaryScopeOutcome["status"] = "provider_error"
    let chosenScope: VoiceBoundaryScope | undefined
    const startedAt = performance.now()
    const timeoutMs = input.deadline === "final" ? config.finalTimeoutMs : config.liveTimeoutMs
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      if (input.signal?.aborted) {
        outcome = "canceled"
        return { status: "canceled" }
      }
      const result = await deps.ai.generateObject({
        model: config.model,
        schema: voiceBoundaryScopeSchema,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `Immediate predecessor raw:\n${input.predecessorRaw}`,
              `Immediate predecessor accepted Markdown:\n${input.predecessorMarkdown}`,
              input.olderAcceptedSuffix ? `Older accepted suffix (READ-ONLY):\n${input.olderAcceptedSuffix}` : "",
              input.draftBefore ? `Draft before (READ-ONLY):\n${input.draftBefore}` : "",
              input.draftAfter ? `Draft after (READ-ONLY):\n${input.draftAfter}` : "",
              `Current raw window:\n${input.currentRaw}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        reasoningEffort: config.reasoningEffort,
        telemetry: {
          functionId: "voice-transcript-boundary-scope",
          metadata: {
            sessionId: input.sessionId,
            stage: input.deadline === "final" ? "scope_final" : "scope_live",
            deadline: input.deadline,
            deadlineMs: timeoutMs,
            reasoningEffort: config.reasoningEffort,
            rawLen: input.currentRaw.length,
            readOnlyContextLen:
              input.predecessorRaw.length +
              input.predecessorMarkdown.length +
              (input.olderAcceptedSuffix?.length ?? 0) +
              (input.draftBefore?.length ?? 0) +
              (input.draftAfter?.length ?? 0),
            sourceWindowCount: VOICE_POLISH_WIDEN_MAX_WINDOWS,
            finalCount: input.finalCount,
            protocolVersion: 4,
          },
        },
        context: { workspaceId: input.workspaceId, userId: input.userId, origin: "user" },
        abortSignal: controller.signal,
      })
      usage = result.usage
      if (input.signal?.aborted) {
        outcome = "canceled"
        return { status: "canceled" }
      }
      if (timedOut) {
        outcome = "timeout"
        return { status: "timeout" }
      }
      outcome = "success"
      chosenScope = result.value.scope
      return { status: "success", scope: chosenScope }
    } catch {
      if (input.signal?.aborted) outcome = "canceled"
      else if (timedOut) outcome = "timeout"
      else outcome = "provider_error"
      return { status: outcome }
    } finally {
      const durationMs = Math.round(performance.now() - startedAt)
      logger.info(
        {
          sessionId: input.sessionId,
          outcome,
          scope: chosenScope,
          stage: input.deadline === "final" ? "scope_final" : "scope_live",
          protocolVersion: 4,
          sourceWindowCount: VOICE_POLISH_WIDEN_MAX_WINDOWS,
          finalCount: input.finalCount,
          deadline: input.deadline,
          durationMs,
          rawLength: Array.from(input.currentRaw).length,
          readOnlyContextLength: Array.from(
            input.predecessorRaw +
              input.predecessorMarkdown +
              (input.olderAcceptedSuffix ?? "") +
              (input.draftBefore ?? "") +
              (input.draftAfter ?? "")
          ).length,
          reasoningEffort: config.reasoningEffort,
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
          reasoningTokens: usage?.reasoningTokens,
        },
        "Voice transcript scope attempt completed"
      )
      deps.onAttempt?.({
        stage: "scope",
        deadline: input.deadline,
        durationMs,
        outcome,
        rawScalarLength: Array.from(input.currentRaw).length,
        sourceWindowCount: VOICE_POLISH_WIDEN_MAX_WINDOWS,
        finalCount: input.finalCount,
        reasoningEffort: config.reasoningEffort,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        reasoningTokens: usage?.reasoningTokens,
      })
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onCancel)
    }
  }
}
