import type { Server } from "socket.io"
import { ulid } from "ulid"
import { z } from "zod"
import type { AuthService } from "@threa/backend-common"
import {
  VOICE_DRAFT_CONTEXT_MAX_CHARS,
  VOICE_PROTOCOL_VERSION,
  type VoicePolishLevel,
  type VoiceRelayPhase,
  type VoiceTerminationMode,
} from "@threa/types"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { voiceConfig, resolveSteeringTerms } from "./config"
import type { VoiceTranscriptionService } from "./service"
import type { Transcription, TranscriptionSession } from "./transcription/strategy"
import type { PolishOutcome, PolishTranscript } from "./polish"
import { PolishScheduler } from "./polish-scheduler"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceSettingsService } from "../workspace-settings"

const startPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  voiceSessionId: z.string().min(1),
  draftBefore: z.string().optional(),
  draftAfter: z.string().optional(),
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
  scheduler: PolishScheduler
  finalOutcome: PolishOutcome["status"]
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
        signal,
      })
      return typeof outcome === "string" ? { status: "success", markdown: outcome } : outcome
    }

    function emitPolish(
      current: RelayState,
      revision: number,
      raw: string,
      outcome: PolishOutcome,
      authoritative: boolean
    ) {
      if (state !== current || current.phase === "closing" || current.phase === "closed") return
      if (revision !== current.revision || outcome.status !== "success") return
      socket.emit("voice:transcript:polished", {
        voiceSessionId: current.voiceSessionId,
        chunkId: current.sessionChunkId,
        revision,
        authoritative,
        raw,
        polished: outcome.markdown,
      })
    }

    function commitFinal(current: RelayState, text: string, schedule = true) {
      const raw = text.trim()
      if (!raw || (current.phase !== "live" && current.phase !== "formatting")) return
      current.lastInterim = ""
      current.rawFinals.push(raw)
      const revision = ++current.revision
      socket.emit("voice:transcript:delta", {
        voiceSessionId: current.voiceSessionId,
        revision,
        text: raw,
        isFinal: true,
        ...(current.polishLevel === "none" ? {} : { chunkId: current.sessionChunkId }),
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
            logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice upstream close failed")
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
        logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice session finalize failed")
      }
      current.phase = "closed"
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
          current.scheduler.cancel()
          let interruptFlush!: () => void
          const interrupted = new Promise<void>((resolve) => {
            interruptFlush = resolve
          })
          current.interruptFlush = interruptFlush
          try {
            await Promise.race([current.upstream.flush(), interrupted])
          } catch (err) {
            logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice flush failed")
          } finally {
            current.interruptFlush = null
          }
          if (current.terminationMode === "format") {
            if (current.lastInterim.trim()) commitFinal(current, current.lastInterim, false)
            const raw = current.rawFinals.join(" ")
            if (current.polishLevel !== "none") {
              const revision = current.revision
              const outcome = await current.scheduler.formatFinal({
                revision,
                run: (signal) => runPolish(current, revision, raw, signal),
              })
              current.finalOutcome = outcome.status
              if (current.terminationMode === "format") emitPolish(current, revision, raw, outcome, true)
            } else current.finalOutcome = raw ? "success" : "empty_input"
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
        if (state || starting)
          return callback?.({ ok: false, error: "Session already started", protocolVersion: VOICE_PROTOCOL_VERSION })
        const parsed = startPayloadSchema.safeParse(payload)
        if (!parsed.success)
          return callback?.({
            ok: false,
            error: "workspaceId and voiceSessionId required",
            protocolVersion: VOICE_PROTOCOL_VERSION,
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
              { err: prefs.reason, workspaceId, userId: row.userId, voiceSessionId },
              "Voice user preferences lookup failed"
            )
          if (settings.status === "rejected")
            logger.warn(
              { err: settings.reason, workspaceId, userId: row.userId, voiceSessionId },
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
              protocolVersion: VOICE_PROTOCOL_VERSION,
            })
          }
          const current = {} as RelayState
          const scheduler = new PolishScheduler((snapshot, outcome) => {
            emitPolish(current, snapshot.revision, current.rawFinals.join(" "), outcome, false)
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
            maxDurationTimer: setTimeout(
              () => void terminate("format", "max_duration").finally(() => socket.disconnect(true)),
              voiceConfig.maxSessionMs
            ),
          } satisfies Partial<RelayState>)
          state = current
          upstream.onDelta((delta) => {
            if (state !== current || (current.phase !== "live" && current.phase !== "formatting")) return
            if (!delta.isFinal) {
              current.lastInterim = delta.text ?? ""
              socket.emit("voice:transcript:delta", { voiceSessionId, revision: current.revision, ...delta })
            } else if (delta.text?.trim()) commitFinal(current, delta.text, current.phase === "live")
            else socket.emit("voice:transcript:delta", { voiceSessionId, revision: current.revision, ...delta })
          })
          upstream.onError((error) => {
            if (state !== current || current.phase !== "live") return
            socket.emit("voice:transcription:error", { voiceSessionId, ...error })
            void terminate("abort", "stopped")
          })
          callback?.({ ok: true, protocolVersion: VOICE_PROTOCOL_VERSION })
        } catch (err) {
          if (resolvedUserId)
            await deps.voiceTranscriptionService
              .abortSession({ workspaceId, userId: resolvedUserId, sessionId: voiceSessionId, totalAudioMs: 0 })
              .catch(() => {})
          const error = err instanceof HttpError ? err.message : "Failed to start voice session"
          callback?.({ ok: false, error, protocolVersion: VOICE_PROTOCOL_VERSION })
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
    socket.on("disconnect", () => {
      disconnected = true
      return terminate("abort", "stopped")
    })
  })
}
