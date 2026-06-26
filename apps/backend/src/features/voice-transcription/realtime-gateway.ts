import type { Server } from "socket.io"
import { ulid } from "ulid"
import { z } from "zod"
import type { AuthService } from "@threa/backend-common"
import { VOICE_DRAFT_CONTEXT_MAX_CHARS, type VoicePolishLevel } from "@threa/types"
import { createSocketAuthMiddleware } from "../../lib/socket-auth"
import { logger } from "../../lib/logger"
import { HttpError } from "../../lib/errors"
import { voiceConfig, resolveSteeringTerms } from "./config"
import type { VoiceTranscriptionService } from "./service"
import type { Transcription, TranscriptionSession } from "./transcription/strategy"
import type { PolishTranscript } from "./polish"
import type { UserPreferencesService } from "../user-preferences"
import type { WorkspaceSettingsService } from "../workspace-settings"

const startPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  voiceSessionId: z.string().min(1),
  // Draft around the caret, read-only polish context. The gateway re-caps to
  // VOICE_DRAFT_CONTEXT_MAX_CHARS below (truncate, don't reject — an oversized
  // draft must never block dictation from starting).
  draftBefore: z.string().optional(),
  draftAfter: z.string().optional(),
})

interface Dependencies {
  authService: AuthService
  voiceTranscriptionService: VoiceTranscriptionService
  transcription: Transcription
  userPreferencesService: UserPreferencesService
  workspaceSettingsService: WorkspaceSettingsService
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
   * Resolved once at start. "minor" / "opinionated" trigger a cumulative
   * re-polish of the whole transcript on every final, letting a later chunk
   * rewrite an earlier self-correction ("nine, no sorry eight" -> "eight").
   * "none" ships finals as plain deltas with no chunkId and no tracking.
   */
  polishLevel: VoicePolishLevel
  /**
   * Resolved once at start (baked-in product terms ∪ the user's steering words).
   * Reused for every polish pass as the spelling reference; the STT-layer
   * biasing already consumed it when the upstream session opened.
   */
  steeringTerms: string[]
  /**
   * Stable chunkId for the whole session: every final and polished event
   * carries it, so the editor extends/replaces a single tracked range.
   */
  sessionChunkId: string
  /** Cumulative raw final segments, joined and re-polished on every final. */
  rawFinals: string[]
  /**
   * Latest uncommitted interim hypothesis. Promoted to a synthetic final if
   * the upstream errors before the partial commits — otherwise the client's
   * flushInterim fallback would ship it as raw, unpolished text (the spurious
   * ElevenLabs "insufficient funds" close often fires before any final lands).
   */
  lastInterim: string
  /**
   * Draft around the insertion point, forwarded to every polish pass as
   * read-only context. Already capped to VOICE_DRAFT_CONTEXT_MAX_CHARS.
   */
  draftBefore: string | undefined
  draftAfter: string | undefined
  /**
   * Serializes polish work: out-of-order resolves would let an older polished
   * snapshot land after a newer one and undo incremental corrections.
   */
  polishQueue: Promise<void>
}

// Cap on how long an upstream error waits on in-flight polish: long enough for
// a sub-second polish to land the swap, short enough that a stuck provider
// can't delay the user-facing error past a heartbeat.
const POLISH_DRAIN_ON_ERROR_MS = 2000

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
  const {
    authService,
    voiceTranscriptionService,
    transcription,
    userPreferencesService,
    workspaceSettingsService,
    polishTranscript,
  } = deps
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

      // Drain in-flight polish before responding to voice:stop so a late
      // `voice:transcript:polished` doesn't race the socket close. On abort
      // the client is already gone, so skip the wait.
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
      // Proximity to the insertion point matters most for polish context, so
      // keep the END of the before-text and the START of the after-text.
      const draftBefore = parsed.data.draftBefore?.slice(-VOICE_DRAFT_CONTEXT_MAX_CHARS) || undefined
      const draftAfter = parsed.data.draftAfter?.slice(0, VOICE_DRAFT_CONTEXT_MAX_CHARS) || undefined
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

        // Resolve once per session so a mid-session pref change can't shift
        // behavior for an in-flight take and break the editor's chunk tracker.
        let polishLevel: VoicePolishLevel = "none"
        let userTerms: string[] | undefined
        let workspaceTerms: string[] | undefined
        // Resolve the two sources independently so one service's failure degrades
        // only its own output: a workspace-settings outage must not disable a
        // user's polish or drop their personal steering words, and vice versa.
        // The baked-in product terms always survive (resolveSteeringTerms prepends
        // them even when both lists are empty/missing).
        const [prefsResult, settingsResult] = await Promise.allSettled([
          userPreferencesService.getPreferences(workspaceId, row.userId),
          workspaceSettingsService.getSettings(workspaceId),
        ])
        if (prefsResult.status === "fulfilled") {
          polishLevel = prefsResult.value.voicePolishLevel
          userTerms = prefsResult.value.voiceSteeringWords
        } else {
          logger.warn(
            { err: prefsResult.reason, voiceSessionId, workspaceId },
            "Voice user-prefs lookup failed; defaulting polish off"
          )
        }
        if (settingsResult.status === "fulfilled") {
          workspaceTerms = settingsResult.value.voiceSteeringWords
        } else {
          logger.warn(
            { err: settingsResult.reason, voiceSessionId, workspaceId },
            "Voice workspace-settings lookup failed; skipping shared steering words"
          )
        }
        // base ∪ workspace-shared ∪ per-user (deduped, base/workspace win the spelling).
        const steeringTerms = resolveSteeringTerms(workspaceTerms, userTerms)

        const upstream = await transcription.open({
          model: row.model,
          language: row.language ?? undefined,
          vocabulary: steeringTerms,
        })

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

        // Commit a raw final: buffer it, emit a tagged final delta, and enqueue
        // a cumulative polish pass. Shared by the normal final path and the
        // interim-promotion-on-error path so the queue semantics are identical.
        const commitPolishedFinal = (polishingState: RelayState, raw: string) => {
          polishingState.rawFinals.push(raw)
          socket.emit("voice:transcript:delta", {
            voiceSessionId,
            text: raw,
            isFinal: true,
            chunkId: polishingState.sessionChunkId,
          })
          // Each pass re-polishes the FULL transcript so a later chunk can
          // rewrite an earlier one. The queue keeps emissions in order so a
          // slow polish N can't clobber a faster polish N+1 already in the editor.
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
                draftBefore: polishingState.draftBefore,
                draftAfter: polishingState.draftAfter,
                steeringTerms: polishingState.steeringTerms,
              })
              if (state !== polishingState || polishingState.finalized) return
              socket.emit("voice:transcript:polished", {
                voiceSessionId,
                chunkId: polishingState.sessionChunkId,
                raw: rawTranscript,
                polished,
              })
            } catch (err) {
              // Raw text is already in the editor, so skip the polish swap.
              logger.warn(
                { err, voiceSessionId, chunkId: polishingState.sessionChunkId },
                "Voice transcript polish failed; leaving raw text in editor"
              )
            }
          })
        }

        // Finals are tagged with a session-wide chunkId only when polish is on,
        // signalling the client to track them as a swappable chunk; with polish
        // off, no chunkId is sent and the client commits them as plain text.
        upstream.onDelta((delta) => {
          if (!state) return
          if (!delta.isFinal) {
            // Track the latest interim so the error handler can promote it to
            // a synthetic final if the upstream dies before the segment commits.
            state.lastInterim = delta.text ?? ""
            socket.emit("voice:transcript:delta", { voiceSessionId, ...delta })
            return
          }
          state.lastInterim = ""
          const raw = delta.text ?? ""
          if (state.polishLevel === "none" || !raw.trim()) {
            // Polish off, or an empty terminating final (some providers emit
            // these) — pass straight through with no chunk tracking.
            socket.emit("voice:transcript:delta", { voiceSessionId, ...delta })
            return
          }
          commitPolishedFinal(state, raw)
        })
        upstream.onError((e) => {
          // Drain in-flight polish so the polished swap lands BEFORE the client
          // tears down on this error (ElevenLabs sometimes closes ~10s in even
          // on healthy sessions). Socket.io preserves order, so emitting the
          // error after awaiting the polish promise guarantees the client
          // applies the polish first. Bounded so a hung polish can't stall it.
          const current = state
          if (!current || current.finalized) {
            socket.emit("voice:transcription:error", { voiceSessionId, ...e })
            return
          }
          // Promote the pending interim to a synthetic final so the user
          // doesn't lose what they just said. ElevenLabs' spurious close fires
          // before the in-flight segment commits, so without this the speech
          // since the last committed_transcript exists only as interim text,
          // which the client's flushInterim() would commit as RAW (unpolished).
          // Route it through the real-final path so the client tracks it as a
          // chunk and clears its interim ref (making flushInterim a no-op), and
          // the drain below waits for the polish. Best-effort: an unfinalized
          // hypothesis may drift in punctuation, but an approximation beats loss.
          const pendingInterim = current.lastInterim.trim()
          if (pendingInterim) {
            current.lastInterim = ""
            if (current.polishLevel === "none") {
              socket.emit("voice:transcript:delta", {
                voiceSessionId,
                text: pendingInterim,
                isFinal: true,
              })
            } else {
              commitPolishedFinal(current, pendingInterim)
            }
          }
          const drain = Promise.race([
            current.polishQueue,
            new Promise<void>((resolve) => setTimeout(resolve, POLISH_DRAIN_ON_ERROR_MS)),
          ])
          drain
            .catch(() => {
              /* polishQueue swallows its own errors */
            })
            .then(() => {
              // A concurrent voice:stop / disconnect may have finalized the
              // session while we were draining. Skip the error emit so the
              // client doesn't see a spurious error flash after a clean stop.
              if (current.finalized) return
              socket.emit("voice:transcription:error", { voiceSessionId, ...e })
            })
        })

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
          steeringTerms,
          sessionChunkId,
          rawFinals: [],
          lastInterim: "",
          draftBefore,
          draftAfter,
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
