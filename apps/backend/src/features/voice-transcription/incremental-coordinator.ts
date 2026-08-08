import { ulid } from "ulid"
import { parseMarkdown } from "@threa/prosemirror"
import type { VoicePolishLevel, VoiceReplacementAckStatus } from "@threa/types"
import { VOICE_POLISH_WIDEN_MAX_WINDOWS, VOICE_POLISH_WINDOW_MAX_CHARS, voicePolishConfig } from "./config"
import { IncrementalVoiceEngine, scalarLength, type VoicePolishWindow } from "./incremental-engine"
import type { PolishOutcome, PolishTranscript } from "./polish"
import type { DecideVoiceBoundaryScopeInput, VoiceBoundaryScopeOutcome } from "./scope"
import { logger } from "../../lib/logger"

export type IncrementalPolishResult =
  | { status: "applied"; operationId: string; widened: boolean; scope: "tail" | "widen_previous" }
  | { status: "rejected"; operationId: string; ackStatus: VoiceReplacementAckStatus | "timeout" }
  | { status: "preserve_raw"; scope: "preserve_raw" }
  | { status: "reused" }
  | { status: "invalid_output"; reason: "empty" | "truncated" | "unparseable" }
  | { status: "timeout" | "canceled" | "provider_error" | "empty_input" }

export interface IncrementalOperation {
  operationId: string
  sources: Array<{ chunkId: string; throughRevision: number }>
  resultChunkId: string
  raw: string
  outcome: Extract<PolishOutcome, { status: "success" }>
  authoritative: boolean
}

export interface IncrementalPolishContext {
  level: VoicePolishLevel
  workspaceId: string
  userId: string
  sessionId: string
  draftBefore?: string
  draftAfter?: string
  steeringTerms?: string[]
}

export interface IncrementalPolishCoordinatorDeps {
  engine: IncrementalVoiceEngine
  polishTranscript: PolishTranscript
  decideBoundaryScope?: (input: DecideVoiceBoundaryScopeInput) => Promise<VoiceBoundaryScopeOutcome>
  applyOperation: (operation: IncrementalOperation) => Promise<VoiceReplacementAckStatus | "timeout">
  context: IncrementalPolishContext
  liveTimeoutMs?: number
  finalTimeoutMs?: number
  includePreviousAccepted?: boolean
}

export class IncrementalPolishCoordinator {
  constructor(private readonly deps: IncrementalPolishCoordinatorDeps) {}

  async run(
    window: VoicePolishWindow,
    deadline: "live" | "final",
    authoritative: boolean,
    signal?: AbortSignal
  ): Promise<IncrementalPolishResult> {
    if (signal?.aborted) return { status: "canceled" }
    if (authoritative && this.deps.engine.exactCurrentAccepted()) return { status: "reused" }
    const budget =
      deadline === "final"
        ? (this.deps.finalTimeoutMs ?? voicePolishConfig.finalTimeoutMs)
        : (this.deps.liveTimeoutMs ?? voicePolishConfig.liveTimeoutMs)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener("abort", cancel, { once: true })
    const timer = setTimeout(() => controller.abort(), budget)
    const expiresAt = performance.now() + budget
    try {
      const snapshot = {
        chunkId: window.chunkId,
        throughRevision: window.latestRevision,
        raw: this.deps.engine.raw(window),
        finalCount: window.finalCount,
        logicalSpanCount: window.logicalSpanCount,
        acceptedMarkdown: window.accepted?.markdown,
      }
      const currentRaw = snapshot.raw
      if (
        snapshot.logicalSpanCount >= VOICE_POLISH_WIDEN_MAX_WINDOWS &&
        snapshot.acceptedMarkdown &&
        !this.deps.engine.isExactlyAccepted(window)
      )
        return { status: "preserve_raw", scope: "preserve_raw" }
      if (scalarLength(currentRaw) > VOICE_POLISH_WINDOW_MAX_CHARS)
        throw new RangeError("normal voice polish input exceeded bound")
      const includePrevious = this.deps.includePreviousAccepted !== false
      const predecessor = includePrevious ? this.deps.engine.immediateAcceptedPredecessor(window) : undefined
      if (!predecessor || !this.deps.decideBoundaryScope) {
        const outcome = await this.format(
          currentRaw,
          snapshot.finalCount,
          includePrevious ? snapshot.acceptedMarkdown : undefined,
          undefined,
          deadline,
          controller.signal
        )
        if (controller.signal.aborted) return { status: signal?.aborted ? "canceled" : "timeout" }
        return await this.applyOutcome(
          outcome,
          [{ chunkId: snapshot.chunkId, throughRevision: snapshot.throughRevision }],
          snapshot.chunkId,
          currentRaw,
          authoritative,
          "tail",
          controller.signal
        )
      }
      const predecessorSnapshot = {
        chunkId: predecessor.chunkId,
        throughRevision: predecessor.latestRevision,
        raw: this.deps.engine.raw(predecessor),
        finalCount: predecessor.finalCount,
        logicalSpanCount: predecessor.logicalSpanCount,
        markdown: predecessor.accepted!.markdown,
      }
      const tail = this.format(
        currentRaw,
        snapshot.finalCount,
        snapshot.acceptedMarkdown,
        predecessorSnapshot.markdown,
        deadline,
        controller.signal
      )
      const scope = this.deps.decideBoundaryScope({
        currentRaw,
        predecessorRaw: predecessorSnapshot.raw,
        predecessorMarkdown: predecessorSnapshot.markdown,
        olderAcceptedSuffix: this.deps.engine.olderAcceptedSuffix(window),
        draftBefore: this.deps.context.draftBefore,
        draftAfter: this.deps.context.draftAfter,
        workspaceId: this.deps.context.workspaceId,
        userId: this.deps.context.userId,
        sessionId: this.deps.context.sessionId,
        deadline,
        finalCount: predecessorSnapshot.finalCount + snapshot.finalCount,
        signal: controller.signal,
      })
      const [tailOutcome, scopeOutcome] = await Promise.all([tail, scope])
      if (controller.signal.aborted) return { status: signal?.aborted ? "canceled" : "timeout" }
      if (scopeOutcome.status !== "success") return { status: scopeOutcome.status }
      if (scopeOutcome.scope === "preserve_raw") return { status: "preserve_raw", scope: "preserve_raw" }
      if (scopeOutcome.scope === "tail")
        return await this.applyOutcome(
          tailOutcome,
          [{ chunkId: snapshot.chunkId, throughRevision: snapshot.throughRevision }],
          snapshot.chunkId,
          currentRaw,
          authoritative,
          "tail",
          controller.signal
        )

      if (predecessorSnapshot.logicalSpanCount + snapshot.logicalSpanCount > VOICE_POLISH_WIDEN_MAX_WINDOWS)
        return { status: "preserve_raw", scope: "preserve_raw" }
      const widenedRaw = `${predecessorSnapshot.raw} ${currentRaw}`
      if (scalarLength(widenedRaw) > VOICE_POLISH_WINDOW_MAX_CHARS * VOICE_POLISH_WIDEN_MAX_WINDOWS)
        return { status: "preserve_raw", scope: "preserve_raw" }
      if (performance.now() >= expiresAt) return { status: "timeout" }
      const widened = await this.deps.polishTranscript({
        ...this.polishInput(widenedRaw, deadline, controller.signal),
        previousAcceptedMarkdown: predecessorSnapshot.markdown,
        targetMode: "widen",
        stage: "format_widen",
        sourceWindowCount: VOICE_POLISH_WIDEN_MAX_WINDOWS,
        finalCount: predecessorSnapshot.finalCount + snapshot.finalCount,
      })
      if (controller.signal.aborted) return { status: signal?.aborted ? "canceled" : "timeout" }
      return await this.applyOutcome(
        widened,
        [
          { chunkId: predecessorSnapshot.chunkId, throughRevision: predecessorSnapshot.throughRevision },
          { chunkId: snapshot.chunkId, throughRevision: snapshot.throughRevision },
        ],
        ulid(),
        widenedRaw,
        authoritative,
        "widen_previous",
        controller.signal
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    }
  }

  private format(
    raw: string,
    finalCount: number,
    previousAcceptedMarkdown: string | undefined,
    readOnlyPredecessorMarkdown: string | undefined,
    deadline: "live" | "final",
    signal: AbortSignal
  ) {
    return this.deps.polishTranscript({
      ...this.polishInput(raw, deadline, signal),
      previousAcceptedMarkdown,
      readOnlyPredecessorMarkdown,
      targetMode: "tail",
      sourceWindowCount: 1,
      finalCount,
    })
  }

  private polishInput(rawTranscript: string, deadline: "live" | "final", signal: AbortSignal) {
    return {
      rawTranscript,
      protocolVersion: 4,
      level: this.deps.context.level,
      workspaceId: this.deps.context.workspaceId,
      userId: this.deps.context.userId,
      sessionId: this.deps.context.sessionId,
      draftBefore: this.deps.context.draftBefore,
      draftAfter: this.deps.context.draftAfter,
      steeringTerms: this.deps.context.steeringTerms,
      deadline,
      signal,
    }
  }

  private async applyOutcome(
    outcome: PolishOutcome,
    sources: Array<{ chunkId: string; throughRevision: number }>,
    resultChunkId: string,
    raw: string,
    authoritative: boolean,
    scope: "tail" | "widen_previous",
    signal: AbortSignal
  ): Promise<IncrementalPolishResult> {
    if (outcome.status !== "success") {
      if (outcome.status === "invalid_output") return { status: "invalid_output", reason: outcome.reason }
      if (outcome.status === "preserve_raw") return { status: "preserve_raw", scope: "preserve_raw" }
      if (outcome.status === "replacement_rejected") return { status: "canceled" }
      return { status: outcome.status }
    }
    if (signal.aborted) return { status: "canceled" }
    const operationId = ulid()
    if (
      !this.deps.engine.registerOperation({
        operationId,
        sources,
        resultChunkId,
        markdown: outcome.markdown,
        contentJson: outcome.contentJson,
        rawMarkdown: raw,
        rawContentJson: parseMarkdown(raw),
      })
    )
      return { status: "canceled" }
    const ackStarted = performance.now()
    const ackStatus = await this.deps.applyOperation({
      operationId,
      sources,
      resultChunkId,
      raw,
      outcome,
      authoritative,
    })
    let applied = false
    if (ackStatus === "timeout") this.deps.engine.rejectPending(operationId)
    else applied = this.deps.engine.acknowledge(operationId, ackStatus)
    logger.info(
      {
        sessionId: this.deps.context.sessionId,
        protocolVersion: 4,
        authoritative,
        scope,
        widened: sources.length === VOICE_POLISH_WIDEN_MAX_WINDOWS,
        sourceWindowCount: sources.length,
        throughRevision: Math.max(...sources.map((source) => source.throughRevision)),
        rawLength: scalarLength(raw),
        ackStatus,
        applied,
        ackDurationMs: Math.round(performance.now() - ackStarted),
      },
      "Voice transcript replacement acknowledgement completed"
    )
    return applied
      ? { status: "applied", operationId, widened: sources.length === VOICE_POLISH_WIDEN_MAX_WINDOWS, scope }
      : { status: "rejected", operationId, ackStatus }
  }
}
