import type { Server } from "socket.io"
import { ulid } from "ulid"
import { z } from "zod"
import type { AuthService } from "@threa/backend-common"
import { parseMarkdown } from "@threa/prosemirror"
import {
  VOICE_DRAFT_CONTEXT_MAX_CHARS,
  VOICE_LEGACY_PROTOCOL_VERSION,
  VOICE_PROTOCOL_VERSION,
  VOICE_REPLACEMENT_ACK_STATUSES,
  type VoiceReplacementAckStatus,
  type VoicePolishLevel,
  type VoiceRelayPhase,
  type VoiceTerminationMode,
  type VoiceStoppedOutcome,
} from "@threa/types"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import {
  voiceConfig,
  resolveSteeringTerms,
  VOICE_REPLACEMENT_ACK_TIMEOUT_MS,
  VOICE_REPLACEMENT_SETTLE_MARGIN_MS,
} from "./config"
import type { VoiceTranscriptionService } from "./service"
import type { Transcription, TranscriptionSession } from "./transcription/strategy"
import type { PolishOutcome, PolishTranscript } from "./polish"
import { PolishScheduler } from "./polish-scheduler"
import { IncrementalVoiceEngine } from "./incremental-engine"
import { IncrementalPolishCoordinator, type IncrementalOperation } from "./incremental-coordinator"
import type { DecideVoiceBoundaryScopeInput, VoiceBoundaryScopeOutcome } from "./scope"
import { safeDisconnectReason, safeProviderError } from "./safe-error"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceSettingsService } from "../workspace-settings"

const startPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  voiceSessionId: z.string().min(1),
  draftBefore: z.string().optional(),
  draftAfter: z.string().optional(),
  maxProtocolVersion: z.unknown().optional(),
})
const stopPayloadSchema = z.object({ mode: z.enum(["format", "send_as_is", "abort"]) })

type StopReason = "stopped" | "max_duration"
interface Dependencies {
  authService: AuthService
  voiceTranscriptionService: VoiceTranscriptionService
  transcription: Transcription
  userPreferencesService: UserPreferencesService
  workspaceSettingsService: WorkspaceSettingsService
  polishTranscript: PolishTranscript
  decideBoundaryScope?: (input: DecideVoiceBoundaryScopeInput) => Promise<VoiceBoundaryScopeOutcome>
}
interface RelayState {
  workspaceId: string
  userId: string
  voiceSessionId: string
  upstream: TranscriptionSession
  maxDurationTimer: ReturnType<typeof setTimeout>
  phase: VoiceRelayPhase
  terminationMode: VoiceTerminationMode | null
  terminationPromise: Promise<void> | null
  interruptFlush: (() => void) | null
  closePromise: Promise<number> | null
  polishLevel: VoicePolishLevel
  steeringTerms: string[]
  sessionChunkId: string
  rawFinals: string[]
  lastInterim: string
  draftBefore?: string
  draftAfter?: string
  revision: number
  previousAcceptedMarkdown?: string
  scheduler: PolishScheduler
  finalOutcome: VoiceStoppedOutcome
  negotiatedProtocol: number
  incrementalEngine?: IncrementalVoiceEngine
  finalReused: boolean
  coordinator?: IncrementalPolishCoordinator
  flushDurationMs?: number
  finalDurationMs?: number
}

function negotiateProtocol(value: unknown): number {
  if (value === undefined) return VOICE_LEGACY_PROTOCOL_VERSION
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return VOICE_LEGACY_PROTOCOL_VERSION
  return Math.min(VOICE_PROTOCOL_VERSION, Math.floor(value))
}

function toBuffer(frame: unknown): Buffer | null {
  if (Buffer.isBuffer(frame)) return frame
  if (frame instanceof ArrayBuffer) return Buffer.from(frame)
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  return null
}
const modeRank: Record<VoiceTerminationMode, number> = { format: 0, send_as_is: 1, abort: 2 }

export function registerVoiceGateway(io: Server, deps: Dependencies) {
  const namespace = io.of("/voice")
  namespace.use(createSocketAuthMiddleware(deps.authService))
  namespace.on("connection", (socket) => {
    const workosUserId = socket.data.workosUserId as string
    let state: RelayState | null = null
    let starting = false
    let disconnected = false

    const runPolish = async (
      current: RelayState,
      revision: number,
      rawTranscript: string,
      signal: AbortSignal
    ): Promise<PolishOutcome> => {
      const outcome = await deps.polishTranscript({
        rawTranscript,
        level: current.polishLevel,
        workspaceId: current.workspaceId,
        userId: current.userId,
        sessionId: current.voiceSessionId,
        draftBefore: current.draftBefore,
        draftAfter: current.draftAfter,
        steeringTerms: current.steeringTerms,
        previousAcceptedMarkdown:
          current.incrementalEngine?.windows.find((window) => window.latestRevision === revision)?.accepted?.markdown ??
          current.previousAcceptedMarkdown,
        targetMode: current.incrementalEngine ? "tail" : "legacy",
        sourceWindowCount: 1,
        finalCount: current.incrementalEngine?.windows.find((window) => window.latestRevision === revision)?.finalCount,
        deadline: current.phase === "formatting" ? "final" : "live",
        signal,
      })
      return typeof outcome === "string"
        ? { status: "success", markdown: outcome, contentJson: parseMarkdown(outcome) }
        : outcome
    }

    const runIncrementalSnapshot = async (
      current: RelayState,
      revision: number,
      signal: AbortSignal,
      authoritative: boolean
    ): Promise<PolishOutcome> => {
      const window = current.incrementalEngine!.windows.find((candidate) => candidate.latestRevision === revision)
      if (!window) return { status: "canceled" }
      const result = await current.coordinator!.run(
        window,
        current.phase === "formatting" ? "final" : "live",
        authoritative,
        signal
      )
      if (result.status === "applied" || result.status === "reused")
        return { status: "success", markdown: "", contentJson: { type: "doc" } }
      if (result.status === "rejected") return { status: "replacement_rejected" }
      if (result.status === "preserve_raw") return { status: "preserve_raw" }
      if (result.status === "invalid_output") return { status: "invalid_output", reason: result.reason }
      return { status: result.status }
    }

    function emitPolish(
      current: RelayState,
      revision: number,
      raw: string,
      outcome: PolishOutcome,
      authoritative: boolean
    ): Promise<void> {
      if (state !== current || current.phase === "closing" || current.phase === "closed") return Promise.resolve()
      if (outcome.status !== "success") return Promise.resolve()
      if (current.negotiatedProtocol === 4 && current.incrementalEngine) return Promise.resolve()
      if (revision !== current.revision) return Promise.resolve()
      current.previousAcceptedMarkdown = outcome.markdown
      socket.emit("voice:transcript:polished", {
        voiceSessionId: current.voiceSessionId,
        chunkId: current.sessionChunkId,
        revision,
        authoritative,
        raw,
        polished: outcome.markdown,
        rawContentJson: parseMarkdown(raw),
        polishedContentJson: outcome.contentJson,
      })
      return Promise.resolve()
    }

    function sendV4Operation(
      current: RelayState,
      operation: IncrementalOperation
    ): Promise<VoiceReplacementAckStatus | "timeout"> {
      return new Promise((resolve) => {
        let settled = false
        const finish = (payload?: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (!payload || typeof payload !== "object") return resolve("timeout")
          const ack = payload as { operationId?: unknown; status?: unknown }
          if (
            ack.operationId !== operation.operationId ||
            !VOICE_REPLACEMENT_ACK_STATUSES.includes(ack.status as VoiceReplacementAckStatus)
          )
            return resolve("invalid")
          resolve(ack.status as VoiceReplacementAckStatus)
        }
        const timer = setTimeout(() => finish(), VOICE_REPLACEMENT_ACK_TIMEOUT_MS)
        socket.emit(
          "voice:transcript:polished",
          {
            protocolVersion: 4,
            operationId: operation.operationId,
            voiceSessionId: current.voiceSessionId,
            authoritative: operation.authoritative,
            resultChunkId: operation.resultChunkId,
            throughRevision: Math.max(...operation.sources.map((source) => source.throughRevision)),
            sources: operation.sources,
            raw: operation.raw,
            polished: operation.outcome.markdown,
            rawContentJson: parseMarkdown(operation.raw),
            polishedContentJson: operation.outcome.contentJson,
          },
          finish
        )
      })
    }

    function commitFinal(current: RelayState, text: string, schedule = true) {
      const raw = text.trim()
      if (!raw || (current.phase !== "live" && current.phase !== "formatting")) return
      current.lastInterim = ""
      if (current.negotiatedProtocol === 4 && current.incrementalEngine) {
        for (const delta of current.incrementalEngine.appendFinal(raw)) {
          current.revision = delta.revision
          socket.emit("voice:transcript:delta", {
            protocolVersion: 4,
            voiceSessionId: current.voiceSessionId,
            revision: delta.revision,
            text: delta.text,
            isFinal: true,
            chunkId: delta.chunkId,
            ...(delta.afterChunkId ? { afterChunkId: delta.afterChunkId } : {}),
            contentJson: parseMarkdown(delta.text),
          })
          if (schedule && current.phase === "live" && current.polishLevel !== "none")
            current.scheduler.scheduleLive({
              revision: delta.revision,
              run: (signal) => runIncrementalSnapshot(current, delta.revision, signal, false),
            })
        }
        return
      }
      current.rawFinals.push(raw)
      const revision = ++current.revision
      socket.emit("voice:transcript:delta", {
        voiceSessionId: current.voiceSessionId,
        revision,
        text: raw,
        isFinal: true,
        ...(current.polishLevel === "none" ? {} : { chunkId: current.sessionChunkId, contentJson: parseMarkdown(raw) }),
      })
      if (schedule && current.phase === "live" && current.polishLevel !== "none") {
        const cumulative = current.rawFinals.join(" ")
        current.scheduler.scheduleLive({ revision, run: (signal) => runPolish(current, revision, cumulative, signal) })
      }
    }

    function closeUpstream(current: RelayState): Promise<number> {
      if (!current.closePromise) {
        current.closePromise = current.upstream
          .close()
          .then((result) => result.totalAudioMs)
          .catch((err) => {
            logger.warn(
              { ...safeProviderError(err), voiceSessionId: current.voiceSessionId },
              "Voice upstream close failed"
            )
            return 0
          })
      }
      return current.closePromise
    }

    async function closeAndRecord(current: RelayState) {
      const totalAudioMs = await closeUpstream(current)
      const abort = current.terminationMode === "abort"
      try {
        const input = {
          workspaceId: current.workspaceId,
          userId: current.userId,
          sessionId: current.voiceSessionId,
          totalAudioMs,
        }
        if (abort) await deps.voiceTranscriptionService.abortSession(input)
        else await deps.voiceTranscriptionService.finishSession(input)
      } catch (err) {
        logger.warn(
          { ...safeProviderError(err), voiceSessionId: current.voiceSessionId },
          "Voice session finalize failed"
        )
      }
      current.phase = "closed"
      logger.info(
        {
          voiceSessionId: current.voiceSessionId,
          terminationMode: current.terminationMode,
          finalOutcome: current.finalOutcome,
          revision: current.revision,
          rawFinalCount: current.incrementalEngine
            ? current.incrementalEngine.windows.reduce((sum, window) => sum + window.finalCount, 0)
            : current.rawFinals.length,
          windowCount: current.incrementalEngine?.windows.length,
          rawCharCount: current.incrementalEngine?.windows.reduce((sum, window) => sum + window.rawCharCount, 0),
          acceptedResultCount: current.incrementalEngine?.windows.filter((window) =>
            current.incrementalEngine!.isExactlyAccepted(window)
          ).length,
          rawWindowCount: current.incrementalEngine?.windows.filter(
            (window) => !current.incrementalEngine!.isExactlyAccepted(window)
          ).length,
          lockedAckCount: current.incrementalEngine?.counters.locked,
          ackStatusCounts: current.incrementalEngine?.counters,
          maxMutableTargetLength: current.incrementalEngine?.maxMutableLength,
          flushDurationMs: current.flushDurationMs,
          finalDurationMs: current.finalDurationMs,
          finalReused: current.finalReused,
          protocolVersion: current.negotiatedProtocol,
          totalAudioMs,
        },
        "Voice relay session closed"
      )
    }

    function terminate(requestedMode: VoiceTerminationMode, reason: StopReason): Promise<void> {
      const current = state
      if (!current) return Promise.resolve()
      if (!current.terminationMode || modeRank[requestedMode] > modeRank[current.terminationMode]) {
        current.terminationMode = requestedMode
        if (requestedMode !== "format") {
          current.phase = "closing"
          current.scheduler.cancel()
          current.lastInterim = ""
          current.interruptFlush?.()
          void closeUpstream(current)
        }
      }
      if (current.terminationPromise) return current.terminationPromise
      current.terminationPromise = (async () => {
        clearTimeout(current.maxDurationTimer)
        if (current.terminationMode === "format") {
          current.phase = "formatting"
          if (current.incrementalEngine)
            await current.scheduler.cancelAndSettle(
              VOICE_REPLACEMENT_ACK_TIMEOUT_MS + VOICE_REPLACEMENT_SETTLE_MARGIN_MS
            )
          else current.scheduler.cancel()
          let interruptFlush!: () => void
          const interrupted = new Promise<void>((resolve) => {
            interruptFlush = resolve
          })
          current.interruptFlush = interruptFlush
          const flushStarted = performance.now()
          try {
            await Promise.race([current.upstream.flush(), interrupted])
          } catch (err) {
            logger.warn({ ...safeProviderError(err), voiceSessionId: current.voiceSessionId }, "Voice flush failed")
          } finally {
            current.flushDurationMs = Math.max(0, Math.round(performance.now() - flushStarted))
            current.interruptFlush = null
          }
          if (current.terminationMode === "format") {
            if (current.lastInterim.trim()) commitFinal(current, current.lastInterim, false)
            const raw = current.incrementalEngine?.activeWindow
              ? current.incrementalEngine.raw(current.incrementalEngine.activeWindow)
              : current.rawFinals.join(" ")
            if (!raw) current.finalOutcome = "empty_input"
            else if (current.polishLevel !== "none") {
              const revision = current.revision
              const reusable = current.incrementalEngine?.exactCurrentAccepted()
              if (reusable) {
                current.finalOutcome = "success"
                current.finalReused = true
              } else {
                const finalStarted = performance.now()
                const outcome = await current.scheduler.formatFinal({
                  revision,
                  run: (signal) =>
                    current.incrementalEngine
                      ? runIncrementalSnapshot(current, revision, signal, true)
                      : runPolish(current, revision, raw, signal),
                })
                current.finalDurationMs = Math.max(0, Math.round(performance.now() - finalStarted))
                current.finalOutcome = outcome.status
                if (current.terminationMode === "format") await emitPolish(current, revision, raw, outcome, true)
              }
            } else current.finalOutcome = "success"
          }
        }
        current.phase = "closing"
        current.scheduler.cancel()
        await closeAndRecord(current)
        const mode = current.terminationMode ?? requestedMode
        if (mode !== "abort")
          socket.emit("voice:stopped", { reason, revision: current.revision, outcome: current.finalOutcome })
      })()
      return current.terminationPromise
    }

    socket.on(
      "voice:start",
      async (
        payload: unknown,
        callback?: (result: { ok: boolean; error?: string; protocolVersion: number }) => void
      ) => {
        const requestedProtocol =
          payload && typeof payload === "object"
            ? negotiateProtocol((payload as { maxProtocolVersion?: unknown }).maxProtocolVersion)
            : VOICE_LEGACY_PROTOCOL_VERSION
        if (state || starting)
          return callback?.({ ok: false, error: "Session already started", protocolVersion: requestedProtocol })
        const parsed = startPayloadSchema.safeParse(payload)
        if (!parsed.success)
          return callback?.({
            ok: false,
            error: "workspaceId and voiceSessionId required",
            protocolVersion: requestedProtocol,
          })
        const { workspaceId, voiceSessionId } = parsed.data
        starting = true
        let resolvedUserId: string | undefined
        try {
          const row = await deps.voiceTranscriptionService.getRelaySession({
            workspaceId,
            workosUserId,
            sessionId: voiceSessionId,
          })
          resolvedUserId = row.userId
          const [prefs, settings] = await Promise.allSettled([
            deps.userPreferencesService.getPreferences(workspaceId, row.userId),
            deps.workspaceSettingsService.getSettings(workspaceId),
          ])
          if (prefs.status === "rejected")
            logger.warn(
              { ...safeProviderError(prefs.reason), workspaceId, userId: row.userId, voiceSessionId },
              "Voice user preferences lookup failed"
            )
          if (settings.status === "rejected")
            logger.warn(
              { ...safeProviderError(settings.reason), workspaceId, userId: row.userId, voiceSessionId },
              "Voice workspace settings lookup failed"
            )
          const polishLevel = prefs.status === "fulfilled" ? prefs.value.voicePolishLevel : "none"
          const steeringTerms = resolveSteeringTerms(
            settings.status === "fulfilled" ? settings.value.voiceSteeringWords : undefined,
            prefs.status === "fulfilled" ? prefs.value.voiceSteeringWords : undefined
          )
          const upstream = await deps.transcription.open({
            model: row.model,
            language: row.language ?? undefined,
            vocabulary: steeringTerms,
          })
          if (disconnected) {
            await upstream.close().catch(() => ({ totalAudioMs: 0 }))
            await deps.voiceTranscriptionService
              .abortSession({ workspaceId, userId: row.userId, sessionId: voiceSessionId, totalAudioMs: 0 })
              .catch(() => {})
            return callback?.({
              ok: false,
              error: "Session ended before it started",
              protocolVersion: requestedProtocol,
            })
          }
          const current = {} as RelayState
          const scheduler = new PolishScheduler((snapshot, outcome) => {
            const window = current.incrementalEngine?.windows.find(
              (candidate) => candidate.latestRevision === snapshot.revision
            )
            const raw = window ? current.incrementalEngine!.raw(window) : current.rawFinals.join(" ")
            void emitPolish(current, snapshot.revision, raw, outcome, false)
          })
          Object.assign(current, {
            workspaceId,
            userId: row.userId,
            voiceSessionId,
            upstream,
            phase: "live",
            terminationMode: null,
            terminationPromise: null,
            interruptFlush: null,
            closePromise: null,
            polishLevel,
            steeringTerms,
            sessionChunkId: ulid(),
            rawFinals: [],
            lastInterim: "",
            draftBefore: parsed.data.draftBefore?.slice(-VOICE_DRAFT_CONTEXT_MAX_CHARS) || undefined,
            draftAfter: parsed.data.draftAfter?.slice(0, VOICE_DRAFT_CONTEXT_MAX_CHARS) || undefined,
            revision: 0,
            scheduler,
            finalOutcome: "empty_input",
            negotiatedProtocol: requestedProtocol,
            incrementalEngine: requestedProtocol === 4 ? new IncrementalVoiceEngine() : undefined,
            finalReused: false,
            maxDurationTimer: setTimeout(
              () => void terminate("format", "max_duration").finally(() => socket.disconnect(true)),
              voiceConfig.maxSessionMs
            ),
          } satisfies Partial<RelayState>)
          if (current.incrementalEngine) {
            current.coordinator = new IncrementalPolishCoordinator({
              engine: current.incrementalEngine,
              polishTranscript: async (input) => {
                const outcome = await deps.polishTranscript(input)
                return typeof outcome === "string"
                  ? { status: "success", markdown: outcome, contentJson: parseMarkdown(outcome) }
                  : outcome
              },
              decideBoundaryScope: deps.decideBoundaryScope,
              applyOperation: (operation) => sendV4Operation(current, operation),
              context: {
                level: current.polishLevel,
                workspaceId: current.workspaceId,
                userId: current.userId,
                sessionId: current.voiceSessionId,
                draftBefore: current.draftBefore,
                draftAfter: current.draftAfter,
                steeringTerms: current.steeringTerms,
              },
            })
          }
          state = current
          upstream.onDelta((delta) => {
            if (state !== current || (current.phase !== "live" && current.phase !== "formatting")) return
            if (!delta.isFinal) {
              current.lastInterim = delta.text ?? ""
              socket.emit(
                "voice:transcript:delta",
                current.negotiatedProtocol === 4
                  ? {
                      protocolVersion: 4,
                      voiceSessionId,
                      revision: current.revision,
                      text: delta.text ?? "",
                      isFinal: false,
                    }
                  : { voiceSessionId, revision: current.revision, ...delta }
              )
            } else if (delta.text?.trim()) commitFinal(current, delta.text, current.phase === "live")
            else if (current.negotiatedProtocol !== 4)
              socket.emit("voice:transcript:delta", { voiceSessionId, revision: current.revision, ...delta })
          })
          upstream.onError((error) => {
            if (state !== current || current.phase !== "live") return
            logger.warn(
              {
                voiceSessionId,
                provider: row.provider,
                ...safeProviderError(error),
                phase: current.phase,
                revision: current.revision,
                rawFinalCount: current.rawFinals.length,
              },
              "Voice transcription upstream error"
            )
            socket.emit("voice:transcription:error", { voiceSessionId, ...error })
            void terminate("abort", "stopped")
          })
          callback?.({ ok: true, protocolVersion: requestedProtocol })
        } catch (err) {
          if (resolvedUserId)
            await deps.voiceTranscriptionService
              .abortSession({ workspaceId, userId: resolvedUserId, sessionId: voiceSessionId, totalAudioMs: 0 })
              .catch(() => {})
          const error = err instanceof HttpError ? err.message : "Failed to start voice session"
          callback?.({ ok: false, error, protocolVersion: requestedProtocol })
        } finally {
          starting = false
        }
      }
    )

    socket.on("voice:audio", (frame: unknown) => {
      if (!state || state.phase !== "live") return
      const buffer = toBuffer(frame)
      if (buffer) state.upstream.pushAudio(buffer)
    })
    socket.on("voice:stop", async (payloadOrCallback?: unknown, maybeCallback?: (result: { ok: boolean }) => void) => {
      const legacy = typeof payloadOrCallback === "function" || payloadOrCallback === undefined
      const callback = (typeof payloadOrCallback === "function" ? payloadOrCallback : maybeCallback) as
        | ((result: { ok: boolean }) => void)
        | undefined
      const parsed = legacy
        ? { success: true as const, data: { mode: "format" as const } }
        : stopPayloadSchema.safeParse(payloadOrCallback)
      if (!parsed.success) return callback?.({ ok: false })
      await terminate(parsed.data.mode, "stopped")
      callback?.({ ok: true })
    })
    socket.on("disconnect", (reason) => {
      disconnected = true
      const current = state
      logger.info(
        {
          voiceSessionId: current?.voiceSessionId ?? null,
          reason: safeDisconnectReason(reason),
          phase: current?.phase ?? null,
          terminationMode: current?.terminationMode ?? null,
          revision: current?.revision ?? null,
          rawFinalCount: current?.incrementalEngine
            ? current.incrementalEngine.windows.reduce((sum, window) => sum + window.finalCount, 0)
            : (current?.rawFinals.length ?? null),
        },
        "Voice relay socket disconnected"
      )
      return terminate("abort", "stopped")
    })
  })
}
