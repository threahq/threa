import type { Server } from "socket.io"
import type { Pool } from "pg"
import type { AuthService } from "@threa/backend-common"
import { UserRepository } from "../workspaces"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { voiceConfig } from "./config"
import type { VoiceTranscriptionService } from "./service"
import type { Transcription, TranscriptionSession } from "./transcription/strategy"

interface Dependencies {
  pool: Pool
  authService: AuthService
  voiceTranscriptionService: VoiceTranscriptionService
  transcription: Transcription
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
  const { pool, authService, voiceTranscriptionService, transcription } = deps
  const namespace = io.of("/voice")

  // Same session-cookie auth as the main namespace (INV-35: reuse, don't fork).
  namespace.use(createSocketAuthMiddleware(authService))

  namespace.on("connection", (socket) => {
    const workosUserId = socket.data.workosUserId as string
    let state: RelayState | null = null

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

    socket.on(
      "voice:start",
      async (
        payload: { workspaceId?: string; voiceSessionId?: string },
        callback?: (result: { ok: boolean; error?: string }) => void
      ) => {
        if (state) {
          callback?.({ ok: false, error: "Session already started" })
          return
        }
        const workspaceId = payload?.workspaceId
        const voiceSessionId = payload?.voiceSessionId
        if (!workspaceId || !voiceSessionId) {
          callback?.({ ok: false, error: "workspaceId and voiceSessionId required" })
          return
        }

        try {
          const workspaceUser = await UserRepository.findByWorkosUserIdInWorkspace(pool, workspaceId, workosUserId)
          if (!workspaceUser) {
            callback?.({ ok: false, error: "Not authorized" })
            return
          }

          const row = await voiceTranscriptionService.getRelaySession({
            workspaceId,
            userId: workspaceUser.id,
            sessionId: voiceSessionId,
          })

          const upstream = await transcription.open({ model: row.model, language: row.language ?? undefined })
          upstream.onDelta((delta) => socket.emit("voice:delta", delta))
          upstream.onError((e) => socket.emit("voice:error", e))

          const maxDurationTimer = setTimeout(() => {
            socket.emit("voice:stopped", { reason: "max_duration" })
            void finalize("max_duration").finally(() => socket.disconnect(true))
          }, voiceConfig.maxSessionMs)

          state = {
            workspaceId,
            userId: workspaceUser.id,
            voiceSessionId,
            upstream,
            maxDurationTimer,
            finalized: false,
          }
          logger.debug({ voiceSessionId, workspaceId }, "Voice relay started")
          callback?.({ ok: true })
        } catch (err) {
          if (err instanceof HttpError) {
            callback?.({ ok: false, error: err.message })
            return
          }
          logger.error({ err, voiceSessionId, workspaceId }, "Failed to start voice relay")
          callback?.({ ok: false, error: "Failed to start voice session" })
        }
      }
    )

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
      void finalize("aborted")
    })
  })
}
