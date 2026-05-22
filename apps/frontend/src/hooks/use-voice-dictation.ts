import { useCallback, useEffect, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import { voiceApi } from "@/api/voice"
import { getCachedWsConfig } from "@/lib/cached-ws-config"

export type VoiceDictationState = "idle" | "connecting" | "recording" | "stopping" | "error"

interface VoiceDelta {
  voiceSessionId: string
  text: string
  isFinal: boolean
}

interface UseVoiceDictationOptions {
  workspaceId: string
  /** Called with each committed (final) transcript span. PR1 ignores interim deltas. */
  onCommittedText: (text: string) => void
  language?: string
}

interface UseVoiceDictationResult {
  state: VoiceDictationState
  /** False when the browser lacks mic capture / AudioWorklet support. */
  supported: boolean
  unsupportedReason: string | null
  error: string | null
  start: () => void
  stop: () => void
}

const FRAME_SAMPLES = 1600 // 100ms @ 16kHz
const SAMPLE_RATE_HZ = 16_000

function detectSupport(): { supported: boolean; reason: string | null } {
  if (typeof window === "undefined") return { supported: false, reason: "Voice input is unavailable here" }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { supported: false, reason: "Your browser doesn't support microphone capture" }
  }
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
  if (!AudioCtx || typeof AudioWorkletNode === "undefined") {
    return { supported: false, reason: "Your browser doesn't support audio processing for dictation" }
  }
  return { supported: true, reason: null }
}

function resolveVoiceUrl(workspaceId: string): string | null {
  const config = getCachedWsConfig(workspaceId)
  if (!config) return null
  // Mirror SocketProvider's dev rewrite so phone-over-WiFi testing connects to
  // the right host instead of the worker's localhost.
  const base = import.meta.env.DEV ? config.wsUrl.replace("localhost", window.location.hostname) : config.wsUrl
  // socket.io derives the namespace from the URL path, so `/voice` must sit
  // before any query string. The wsUrl can carry a `?region=…` param (staging
  // routes by it); naive concatenation would fold `/voice` into the region
  // value and corrupt both the namespace and the route.
  const url = new URL(base)
  url.pathname = "/voice"
  return url.toString()
}

/**
 * Drives one voice-dictation session: create the session over HTTP, capture
 * mic audio as PCM16 frames via an AudioWorklet, stream them up the dedicated
 * `/voice` socket namespace, and surface committed transcript spans. PR1 is a
 * naive caret insert — only final deltas are forwarded, interim replacement
 * lands in a later PR.
 */
export function useVoiceDictation(options: UseVoiceDictationOptions): UseVoiceDictationResult {
  const { workspaceId, onCommittedText, language } = options
  const [state, setState] = useState<VoiceDictationState>("idle")
  const [error, setError] = useState<string | null>(null)
  const supportRef = useRef(detectSupport())

  const socketRef = useRef<Socket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // Bumped on every start() and every teardown/stop so a `voice:start` ACK that
  // resolves after the user has already stopped (or torn down) can't flip the
  // state machine back to "recording" with nothing behind it.
  const startGenerationRef = useRef(0)
  // Keep the latest committed-text callback without re-subscribing the socket.
  const onCommittedTextRef = useRef(onCommittedText)
  onCommittedTextRef.current = onCommittedText

  const teardownAudio = useCallback(() => {
    workletRef.current?.port.close()
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }, [])

  const teardown = useCallback(() => {
    startGenerationRef.current++
    teardownAudio()
    socketRef.current?.disconnect()
    socketRef.current = null
    sessionIdRef.current = null
  }, [teardownAudio])

  const fail = useCallback(
    (message: string) => {
      setError(message)
      setState("error")
      teardown()
    },
    [teardown]
  )

  const start = useCallback(() => {
    if (!supportRef.current.supported) return
    if (state !== "idle" && state !== "error") return

    setError(null)
    setState("connecting")
    const generation = ++startGenerationRef.current

    void (async () => {
      try {
        const voiceUrl = resolveVoiceUrl(workspaceId)
        if (!voiceUrl) {
          fail("Voice isn't ready yet — reconnecting")
          return
        }

        const session = await voiceApi.createSession(workspaceId, { language })
        sessionIdRef.current = session.voiceSessionId

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
        streamRef.current = stream

        const AudioCtx =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const audioContext = new AudioCtx({ sampleRate: SAMPLE_RATE_HZ })
        audioContextRef.current = audioContext
        await audioContext.audioWorklet.addModule("/worklets/pcm16-processor.js")

        const source = audioContext.createMediaStreamSource(stream)
        const worklet = new AudioWorkletNode(audioContext, "pcm16-processor", {
          processorOptions: { frameSamples: FRAME_SAMPLES, targetSampleRate: SAMPLE_RATE_HZ },
        })
        workletRef.current = worklet
        // Route through a muted gain so the graph stays pulled without playing
        // the mic back to the user.
        const muted = audioContext.createGain()
        muted.gain.value = 0
        source.connect(worklet)
        worklet.connect(muted)
        muted.connect(audioContext.destination)
        // iOS Safari starts the context suspended; without this the worklet's
        // process() never runs and no audio frames are produced.
        if (audioContext.state === "suspended") await audioContext.resume()

        const socket = io(voiceUrl, { path: "/socket.io/", withCredentials: true, autoConnect: true })
        socketRef.current = socket

        socket.on("voice:transcript:delta", (delta: VoiceDelta) => {
          // Ignore deltas from a session we've already moved past so a stale
          // socket can't leak text into a new take (plan §3).
          if (delta.voiceSessionId !== sessionIdRef.current) return
          if (delta.isFinal && delta.text) onCommittedTextRef.current(delta.text)
        })
        socket.on("voice:transcription:error", (e: { message?: string }) => fail(e?.message || "Transcription failed"))
        socket.on("voice:stopped", () => {
          // Server-initiated stop (e.g. the max-duration guard). Leave the
          // recording state, not just tear down the audio graph.
          teardown()
          setState("idle")
        })
        socket.on("disconnect", () => {
          // An unexpected drop while still capturing ends the take — surface it
          // so the button leaves its recording state instead of hanging.
          if (workletRef.current) fail("Dictation connection lost")
        })

        socket.emit(
          "voice:start",
          { workspaceId, voiceSessionId: session.voiceSessionId },
          (result: { ok: boolean; error?: string }) => {
            // The user stopped (or we tore down) while this ACK was in flight —
            // don't resurrect a dead take into the "recording" state.
            if (generation !== startGenerationRef.current) {
              socket.disconnect()
              return
            }
            if (!result?.ok) {
              fail(result?.error || "Couldn't start dictation")
              return
            }
            worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
              socketRef.current?.emit("voice:audio", event.data)
            }
            setState("recording")
          }
        )
      } catch (err) {
        // The user already stopped this take while we were setting up — don't
        // surface a late setup error against a session they've abandoned.
        if (generation !== startGenerationRef.current) return
        const message =
          err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
            ? "Microphone access was denied"
            : "Couldn't start dictation"
        fail(message)
      }
    })()
  }, [state, workspaceId, language, fail, teardown])

  const stop = useCallback(() => {
    if (state !== "recording" && state !== "connecting") return
    setState("stopping")
    // Invalidate any in-flight `voice:start` ACK so a late accept can't flip us
    // back to "recording" after we've decided to stop.
    startGenerationRef.current++
    // Stop capture immediately; tell the backend to commit the buffered audio.
    teardownAudio()
    const socket = socketRef.current
    socketRef.current = null
    sessionIdRef.current = null
    if (socket) {
      socket.emit("voice:stop", () => {
        socket.disconnect()
        setState("idle")
      })
    } else {
      setState("idle")
    }
  }, [state, teardownAudio])

  // Abort a still-open session on unmount: disconnecting the socket makes the
  // gateway finalize it as aborted; if the socket never opened, abort over HTTP
  // so it doesn't linger until the max-duration guard.
  useEffect(() => {
    return () => {
      const sessionId = sessionIdRef.current
      const hadSocket = socketRef.current !== null
      teardown()
      if (sessionId && !hadSocket) {
        void voiceApi.abortSession(workspaceId, sessionId).catch(() => {})
      }
    }
  }, [teardown, workspaceId])

  return {
    state,
    supported: supportRef.current.supported,
    unsupportedReason: supportRef.current.reason,
    error,
    start,
    stop,
  }
}
