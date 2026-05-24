import type { Server } from "socket.io"
import { ulid } from "ulid"
import { z } from "zod"
import type { AuthService } from "@threa/backend-common"
import type { VoicePolishLevel } from "@threa/types"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { voiceConfig } from "./config"
import type { VoiceTranscriptionService } from "./service"
import type { Transcription, TranscriptionSession } from "./transcription/strategy"
import type { PolishTranscript } from "./polish"
import type { UserPreferencesService } from "../user-preferences"

const startPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  voiceSessionId: z.string().min(1),
})

interface Dependencies {
  authService: AuthService
  voiceTranscriptionService: VoiceTranscriptionService
  transcription: Transcription
  userPreferencesService: UserPreferencesService
  polishTranscript: PolishTranscript
}

/**
 * Per-connection relay state. One dictation session is bound to one voice
 * socket: the client opens it with `voice:start`, streams PCM16 frames over
 * `voice:audio`, and ends it with `voice:stop` (or just disconnects, which
 * aborts). The upstream provider socket is opened lazily on `voice:start`.
 */
interface RelayState {
  workspaceId: string
  userId: string
  voiceSessionId: string
  upstream: TranscriptionSession
  maxDurationTimer: ReturnType<typeof setTimeout>
  finalized: boolean
  /**
   * Polish level resolved from user prefs at start. "minor" / "opinionated"
   * trigger a cumulative polish on every final final delta (every raw final
   * segment so far is joined and re-polished, then emitted as
   * `voice:transcript:polished` so the client can swap its tracked session
   * chunk to the new polished snapshot). This is what lets the model fix a
   * self-correction in chunk N+1 by rewriting chunk N ("nine, no sorry eight"
   * collapses to "eight"). When "none", finals ship as plain
   * `voice:transcript:delta` with no `chunkId` and the client never tracks them.
   */
  polishLevel: VoicePolishLevel
  /**
   * Stable chunkId for the whole session: every final delta and every
   * polished event carries it, so the editor extends/replaces a single
   * tracked range instead of accumulating per-chunk decorations.
   */
  sessionChunkId: string
  /**
   * Cumulative raw final segments collected this session. Joined with single
   * spaces and re-polished on every final. Bounded only by the session's
   * max duration — provider segments are short enough that this stays small.
   */
  rawFinals: string[]
  /**
   * Serializes polish work — out-of-order resolves would let an older
   * polished snapshot land in the editor after a newer one, which would
   * undo the model's incremental corrections. Each polish step awaits the
   * previous one before reading `rawFinals` and emitting.
   */
  polishQueue: Promise<void>
}

function toBuffer(frame: unknown): Buffer | null {
  if (Buffer.isBuffer(frame)) return frame
  if (frame instanceof ArrayBuffer) return Buffer.from(frame)
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
  return null
}

/**
 * The dedicated voice relay. It lives on its own Socket.io namespace (`/voice`)
 * so high-rate audio frames never share the main namespace's room fan-out. The
 * browser never holds the provider key: frames go up, transcript deltas come
 * down, and the upstream provider WebSocket is owned entirely here.
 *
 * INV-4 carve-out: realtime transcript deltas are delivered directly over this
 * socket rather than through the outbox — they are ephemeral and per-connection,
 * with no durable read model to reconstruct.
 */
export function registerVoiceGateway(io: Server, deps: Dependencies) {
  const { authService, voiceTranscriptionService, transcription, userPreferencesService, polishTranscript } = deps
  const namespace = io.of("/voice")

  // Same session-cookie auth as the main namespace (INV-35: reuse, don't fork).
  namespace.use(createSocketAuthMiddleware(authService))

  namespace.on("connection", (socket) => {
    const workosUserId = socket.data.workosUserId as string
    let state: RelayState | null = null
    // `voice:start` yields at several awaits; without these guards a second
    // start (or a disconnect mid-start) would orphan the upstream socket+timer.
    let starting = false
    let disconnected = false

    async function finalize(reason: "stopped" | "aborted" | "max_duration"): Promise<void> {
      if (!state || state.finalized) return
      state.finalized = true
      clearTimeout(state.maxDurationTimer)
      const current = state

      let totalAudioMs = 0
      try {
        if (reason !== "aborted") await current.upstream.flush()
      } catch (err) {
        logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice flush failed")
      }
      try {
        const result = await current.upstream.close()
        totalAudioMs = result.totalAudioMs
      } catch (err) {
        logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice upstream close failed")
      }

      // Drain any polish call still in flight before responding to voice:stop
      // so a late `voice:transcript:polished` doesn't race the socket close.
      // On an aborted finalize the client is already gone; there is no
      // socket to emit on, so don't pay the polish wait. The catch is
      // unreachable (the queue swallows its own errors) but it's here so a
      // defect in the chain can't tear down the whole finalize.
      if (reason !== "aborted") {
        try {
          await current.polishQueue
        } catch {
          /* unreachable */
        }
      }

      try {
        if (reason === "aborted") {
          await voiceTranscriptionService.abortSession({
            workspaceId: current.workspaceId,
            userId: current.userId,
            sessionId: current.voiceSessionId,
            totalAudioMs,
          })
        } else {
          await voiceTranscriptionService.finishSession({
            workspaceId: current.workspaceId,
            userId: current.userId,
            sessionId: current.voiceSessionId,
            totalAudioMs,
          })
        }
      } catch (err) {
        logger.warn({ err, voiceSessionId: current.voiceSessionId }, "Voice session finalize failed")
      }
    }

    socket.on("voice:start", async (payload: unknown, callback?: (result: { ok: boolean; error?: string }) => void) => {
      if (state || starting) {
        callback?.({ ok: false, error: "Session already started" })
        return
      }
      const parsed = startPayloadSchema.safeParse(payload)
      if (!parsed.success) {
        callback?.({ ok: false, error: "workspaceId and voiceSessionId required" })
        return
      }
      const { workspaceId, voiceSessionId } = parsed.data
      starting = true

      // Captured once getRelaySession resolves so a later failure (e.g.
      // upstream open) can abort the DB session instead of leaving it active
      // until the max-duration sweeper.
      let resolvedUserId: string | undefined

      try {
        const row = await voiceTranscriptionService.getRelaySession({
          workspaceId,
          workosUserId,
          sessionId: voiceSessionId,
        })
        resolvedUserId = row.userId

        // Resolve polish level once per session: a mid-session pref change
        // doesn't change behavior for an in-flight take, which keeps the
        // session chunkId story consistent for the editor's chunk tracker.
        let polishLevel: VoicePolishLevel = "none"
        try {
          const prefs = await userPreferencesService.getPreferences(workspaceId, row.userId)
          polishLevel = prefs.voicePolishLevel
        } catch (err) {
          logger.warn({ err, voiceSessionId, workspaceId }, "Voice prefs lookup failed; defaulting polish off")
        }

        const upstream = await transcription.open({ model: row.model, language: row.language ?? undefined })

        // The socket disconnected while we were opening upstream — there is no
        // longer anyone to relay to, so tear down what we just built.
        if (disconnected) {
          try {
            await upstream.close()
          } catch (err) {
            logger.warn({ err, voiceSessionId }, "Voice upstream close after abandoned start failed")
          }
          await voiceTranscriptionService
            .abortSession({ workspaceId, userId: row.userId, sessionId: voiceSessionId, totalAudioMs: 0 })
            .catch(() => {})
          callback?.({ ok: false, error: "Session ended before it started" })
          return
        }

        const sessionChunkId = ulid()

        // Per-session payloads (plan §3): the client filters deltas by
        // voiceSessionId so a stale session can't leak text into a new one.
        // Interim deltas always pass through unchanged. Finals are tagged with
        // a session-wide chunkId only when polish is on, which signals the
        // client to track them as a swappable chunk; with polish off, no
        // chunkId is sent and the client commits them as plain text.
        upstream.onDelta((delta) => {
          if (!state) return
          if (!delta.isFinal) {
            socket.emit("voice:transcript:delta", { voiceSessionId, ...delta })
            return
          }
          const raw = delta.text ?? ""
          if (state.polishLevel === "none" || !raw.trim()) {
            // Polish off, or an empty terminating final (some providers emit
            // these) — pass straight through with no chunk tracking.
            socket.emit("voice:transcript:delta", { voiceSessionId, ...delta })
            return
          }
          const polishingState = state
          polishingState.rawFinals.push(raw)
          socket.emit("voice:transcript:delta", {
            voiceSessionId,
            text: raw,
            isFinal: true,
            chunkId: polishingState.sessionChunkId,
          })
          // Cumulative polish: each pass re-polishes the FULL transcript so
          // far. That's what lets a later chunk rewrite an earlier one — the
          // canonical example is "let's start at nine tonight, no sorry eight"
          // collapsing to "let's start at eight tonight". The queue keeps
          // emissions in order so a slow polish N can't clobber a faster
          // polish N+1 already in the editor.
          polishingState.polishQueue = polishingState.polishQueue.then(async () => {
            if (state !== polishingState || polishingState.finalized) return
            const rawTranscript = polishingState.rawFinals.join(" ")
            try {
              const polished = await polishTranscript({
                rawTranscript,
                level: polishingState.polishLevel,
                workspaceId: polishingState.workspaceId,
                userId: polishingState.userId,
                sessionId: polishingState.voiceSessionId,
              })
              if (state !== polishingState || polishingState.finalized) return
              socket.emit("voice:transcript:polished", {
                voiceSessionId,
                chunkId: polishingState.sessionChunkId,
                raw: rawTranscript,
                polished,
              })
            } catch (err) {
              // Raw text is already in the editor (we emitted the delta above)
              // — silently skip the polish swap on failure.
              logger.warn(
                { err, voiceSessionId, chunkId: polishingState.sessionChunkId },
                "Voice transcript polish failed; leaving raw text in editor"
              )
            }
          })
        })
        upstream.onError((e) => socket.emit("voice:transcription:error", { voiceSessionId, ...e }))

        const maxDurationTimer = setTimeout(() => {
          socket.emit("voice:stopped", { reason: "max_duration" })
          void finalize("max_duration").finally(() => socket.disconnect(true))
        }, voiceConfig.maxSessionMs)

        state = {
          workspaceId,
          userId: row.userId,
          voiceSessionId,
          upstream,
          maxDurationTimer,
          finalized: false,
          polishLevel,
          sessionChunkId,
          rawFinals: [],
          polishQueue: Promise.resolve(),
        }
        logger.debug({ voiceSessionId, workspaceId }, "Voice relay started")
        callback?.({ ok: true })
      } catch (err) {
        // The session row was already resolved/created, so a failure here
        // leaves it active. Abort it (best-effort) so it doesn't linger.
        if (resolvedUserId) {
          await voiceTranscriptionService
            .abortSession({ workspaceId, userId: resolvedUserId, sessionId: voiceSessionId, totalAudioMs: 0 })
            .catch(() => {})
        }
        if (err instanceof HttpError) {
          callback?.({ ok: false, error: err.message })
          return
        }
        logger.error({ err, voiceSessionId, workspaceId }, "Failed to start voice relay")
        callback?.({ ok: false, error: "Failed to start voice session" })
      } finally {
        starting = false
      }
    })

    socket.on("voice:audio", (frame: unknown) => {
      if (!state || state.finalized) return
      const buf = toBuffer(frame)
      if (!buf) return
      state.upstream.pushAudio(buf)
    })

    socket.on("voice:stop", async (callback?: (result: { ok: boolean }) => void) => {
      await finalize("stopped")
      socket.emit("voice:stopped", { reason: "stopped" })
      callback?.({ ok: true })
    })

    socket.on("disconnect", () => {
      disconnected = true
      void finalize("aborted")
    })
  })
}
