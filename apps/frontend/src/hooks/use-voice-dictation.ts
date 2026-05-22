import { useCallback, useEffect, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import { voiceApi } from "@/api/voice"
import { getCachedWsConfig } from "@/lib/cached-ws-config"

export type VoiceDictationState = "idle" | "connecting" | "recording" | "stopping" | "error"

interface VoiceDelta {
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
  return `${base}/voice`
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
          processorOptions: { frameSamples: FRAME_SAMPLES },
        })
        workletRef.current = worklet
        // Route through a muted gain so the graph stays pulled without playing
        // the mic back to the user.
        const muted = audioContext.createGain()
        muted.gain.value = 0
        source.connect(worklet)
        worklet.connect(muted)
        muted.connect(audioContext.destination)

        const socket = io(voiceUrl, { path: "/socket.io/", withCredentials: true, autoConnect: true })
        socketRef.current = socket

        socket.on("voice:delta", (delta: VoiceDelta) => {
          if (delta.isFinal && delta.text) onCommittedTextRef.current(delta.text)
        })
        socket.on("voice:error", (e: { message?: string }) => fail(e?.message || "Transcription failed"))
        socket.on("voice:stopped", () => teardown())
        socket.on("disconnect", () => {
          // An unexpected drop while recording ends the take.
          if (workletRef.current) teardown()
        })

        socket.emit(
          "voice:start",
          { workspaceId, voiceSessionId: session.voiceSessionId },
          (result: { ok: boolean; error?: string }) => {
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
    // Stop capture immediately; tell the backend to commit the buffered audio.
    teardownAudio()
    const socket = socketRef.current
    if (socket) {
      socket.emit("voice:stop", () => {
        socket.disconnect()
        socketRef.current = null
        sessionIdRef.current = null
        setState("idle")
      })
    } else {
      teardown()
      setState("idle")
    }
  }, [state, teardownAudio, teardown])

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
