import { useCallback, useEffect, useRef, useState } from "react"
import { io, type Socket } from "socket.io-client"
import { voiceApi } from "@/api/voice"
import { getCachedWsConfig } from "@/lib/cached-ws-config"
import { useDictationCoordinator } from "@/contexts"

export type VoiceDictationState = "idle" | "connecting" | "recording" | "stopping" | "error"

interface VoiceDelta {
  voiceSessionId: string
  text: string
  isFinal: boolean
}

interface UseVoiceDictationOptions {
  workspaceId: string
  /** Called with each committed (final) transcript span. */
  onCommittedText: (text: string) => void
  language?: string
}

interface UseVoiceDictationResult {
  state: VoiceDictationState
  /** False when the browser lacks mic capture / AudioWorklet support. */
  supported: boolean
  unsupportedReason: string | null
  error: string | null
  /**
   * The live (uncommitted) transcript hypothesis for the current segment. It
   * grows as the user speaks and clears to "" once the segment commits (or the
   * take ends). Surfaced so the UI can show words immediately instead of only
   * after the upstream VAD endpoints a segment.
   */
  interimText: string
  /**
   * Smoothed live input level (0–1) derived from the mic signal while recording,
   * so the UI can react to the user's voice instead of pulsing on a fixed timer.
   * 0 whenever not recording.
   */
  level: number
  /** Elapsed recording time for the current take, in ms (0 when not recording). */
  elapsedMs: number
  /**
   * Hard cap after which the backend force-stops the take, in ms — null until a
   * session is created. Pair with `elapsedMs` to show a countdown near the cap.
   */
  maxDurationMs: number | null
  start: () => void
  stop: () => void
}

// Phrase structured upstream error codes as short, human copy. The raw provider
// message (e.g. "ElevenLabs realtime closed (code 1000)") leaks the vendor and a
// socket close code, so we never surface it — the backend sends a stable `code`
// and the wording lives here (INV-46).
export function friendlyTranscriptionError(code: string | undefined): string {
  switch (code) {
    case "INPUT_ERROR":
      return "Couldn't make out the audio"
    case "UPSTREAM_CLOSED":
      return "Dictation stopped unexpectedly"
    default:
      return "Dictation hit a problem"
  }
}

const FRAME_SAMPLES = 1600 // 100ms @ 16kHz
const SAMPLE_RATE_HZ = 16_000
// If the server never acks voice:stop (dropped connection mid-stop), fall
// through anyway so the button can't hang in the "stopping" state forever.
const STOP_ACK_TIMEOUT_MS = 3000

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
 * `/voice` socket namespace, and surface transcript spans. Committed (final)
 * spans are forwarded to `onCommittedText`; the in-flight hypothesis is exposed
 * live via `interimText` so callers can show words as they're spoken.
 */
export function useVoiceDictation(options: UseVoiceDictationOptions): UseVoiceDictationResult {
  const { workspaceId, onCommittedText, language } = options
  const [state, setState] = useState<VoiceDictationState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [interimText, setInterimText] = useState("")
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [maxDurationMs, setMaxDurationMs] = useState<number | null>(null)
  const supportRef = useRef(detectSupport())

  const socketRef = useRef<Socket | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // Live input-level metering: an AnalyserNode taps the mic source and a rAF
  // loop computes a smoothed RMS level + elapsed time while recording.
  const analyserRef = useRef<AnalyserNode | null>(null)
  const meterRafRef = useRef<number | null>(null)
  const recordingStartRef = useRef(0)
  const smoothedLevelRef = useRef(0)
  const lastSetLevelRef = useRef(0)
  const lastElapsedTickRef = useRef(0)
  // Bumped on every start() and every teardown/stop so a `voice:start` ACK that
  // resolves after the user has already stopped (or torn down) can't flip the
  // state machine back to "recording" with nothing behind it.
  const startGenerationRef = useRef(0)
  // Keep the latest committed-text callback without re-subscribing the socket.
  const onCommittedTextRef = useRef(onCommittedText)
  onCommittedTextRef.current = onCommittedText

  // Only one take dictates at a time across all composers. Starting a take stops
  // whichever was active first (flushing its tail). `coordinatedStop` is a stable
  // identity the coordinator can compare and invoke; it always calls the latest stop().
  const coordinator = useDictationCoordinator()
  const stopRef = useRef<() => void>(() => {})
  const coordinatedStop = useCallback(() => stopRef.current(), [])

  // Mirror the interim hypothesis into a ref so teardown/stop/fail can read and
  // flush it synchronously, without those callbacks depending on render state.
  const interimRef = useRef("")
  const updateInterim = useCallback((text: string) => {
    interimRef.current = text
    setInterimText(text)
  }, [])
  // Commit whatever uncommitted hypothesis is in flight, then clear it. Used when
  // a take ends before the upstream emits a final delta (manual stop, error, or a
  // dropped connection) so the words the user already saw are kept rather than
  // silently discarded.
  const flushInterim = useCallback(() => {
    const pending = interimRef.current
    if (pending) onCommittedTextRef.current(pending)
    updateInterim("")
  }, [updateInterim])

  const teardownAudio = useCallback(() => {
    if (meterRafRef.current !== null) cancelAnimationFrame(meterRafRef.current)
    meterRafRef.current = null
    analyserRef.current?.disconnect()
    analyserRef.current = null
    smoothedLevelRef.current = 0
    lastSetLevelRef.current = 0
    setLevel(0)
    setElapsedMs(0)
    workletRef.current?.port.close()
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }, [])

  // rAF loop: sample the analyser, surface a smoothed input level and the
  // elapsed recording time. Fast attack / slow decay reads as responsive; the
  // level setState is gated to meaningful changes so a 60fps loop doesn't churn
  // renders, and elapsed ticks at ~4Hz (enough for an m:ss readout + cap hint).
  const runMeter = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Uint8Array(analyser.fftSize)
    const tick = () => {
      const node = analyserRef.current
      if (!node) return
      node.getByteTimeDomainData(buf)
      let sumSquares = 0
      for (let i = 0; i < buf.length; i++) {
        const sample = (buf[i] - 128) / 128
        sumSquares += sample * sample
      }
      const rms = Math.sqrt(sumSquares / buf.length)
      const target = Math.min(1, rms * 3)
      const prev = smoothedLevelRef.current
      const next = prev + (target - prev) * (target > prev ? 0.5 : 0.12)
      smoothedLevelRef.current = next
      if (Math.abs(next - lastSetLevelRef.current) >= 0.02) {
        lastSetLevelRef.current = next
        setLevel(next)
      }
      const now = performance.now()
      if (now - lastElapsedTickRef.current >= 250) {
        lastElapsedTickRef.current = now
        setElapsedMs(now - recordingStartRef.current)
      }
      meterRafRef.current = requestAnimationFrame(tick)
    }
    meterRafRef.current = requestAnimationFrame(tick)
  }, [])

  const teardown = useCallback(() => {
    startGenerationRef.current++
    teardownAudio()
    socketRef.current?.disconnect()
    socketRef.current = null
    sessionIdRef.current = null
    setMaxDurationMs(null)
    updateInterim("")
    coordinator.deactivate(coordinatedStop)
  }, [teardownAudio, updateInterim, coordinator, coordinatedStop])

  const fail = useCallback(
    (message: string) => {
      // Don't throw away words the user already saw mid-segment — commit the
      // pending hypothesis before tearing the failed take down.
      flushInterim()
      setError(message)
      setState("error")
      teardown()
    },
    [teardown, flushInterim]
  )

  const start = useCallback(() => {
    if (!supportRef.current.supported) return
    if (state !== "idle" && state !== "error") return

    // Take the single active slot, flushing+stopping any other composer's take.
    coordinator.activate(coordinatedStop)
    setError(null)
    updateInterim("")
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
        setMaxDurationMs(session.maxDurationMs)

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
        streamRef.current = stream

        const AudioCtx =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        // Don't pin the context to 16kHz. Firefox (incl. Android) throws from
        // createMediaStreamSource when the context rate differs from the mic
        // track's native rate instead of resampling like Chrome does. Run at the
        // device's native rate and let the worklet downsample to the 16kHz the
        // upstream STT expects (its targetSampleRate handles the conversion).
        const audioContext = new AudioCtx()
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
        // Tap the source for level metering. The analyser is a pure sink (no
        // onward connection), so it never feeds audio back into the graph.
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        analyser.smoothingTimeConstant = 0.4
        source.connect(analyser)
        analyserRef.current = analyser
        // iOS Safari starts the context suspended; without this the worklet's
        // process() never runs and no audio frames are produced.
        if (audioContext.state === "suspended") await audioContext.resume()

        const socket = io(voiceUrl, { path: "/socket.io/", withCredentials: true, autoConnect: true })
        socketRef.current = socket

        socket.on("voice:transcript:delta", (delta: VoiceDelta) => {
          // Ignore deltas from a session we've already moved past so a stale
          // socket can't leak text into a new take (plan §3).
          if (delta.voiceSessionId !== sessionIdRef.current) return
          if (delta.isFinal) {
            // The segment endpointed: commit it for real and drop the live
            // hypothesis so the next segment starts from a clean preview.
            if (delta.text) onCommittedTextRef.current(delta.text)
            updateInterim("")
          } else {
            // Running hypothesis for the current segment — each partial replaces
            // the prior one rather than appending.
            updateInterim(delta.text)
          }
        })
        socket.on("voice:transcription:error", (e: { code?: string }) => fail(friendlyTranscriptionError(e?.code)))
        socket.on("voice:stopped", () => {
          // Server-initiated stop (e.g. the max-duration guard). Keep any pending
          // hypothesis and leave the recording state, not just tear down audio.
          flushInterim()
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
            recordingStartRef.current = performance.now()
            lastElapsedTickRef.current = 0
            setElapsedMs(0)
            runMeter()
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
  }, [state, workspaceId, language, fail, teardown, flushInterim, runMeter, coordinator, coordinatedStop])

  const stop = useCallback(() => {
    if (state !== "recording" && state !== "connecting") return
    coordinator.deactivate(coordinatedStop)
    setState("stopping")
    // Keep the in-flight hypothesis: the backend commits buffered audio on stop,
    // but we've already advanced past this session id (below), so its final delta
    // would be dropped — flush the local hypothesis so the tail isn't lost.
    flushInterim()
    // Invalidate any in-flight `voice:start` ACK so a late accept can't flip us
    // back to "recording" after we've decided to stop.
    startGenerationRef.current++
    // Stop capture immediately; tell the backend to commit the buffered audio.
    teardownAudio()
    const socket = socketRef.current
    socketRef.current = null
    sessionIdRef.current = null
    if (socket) {
      // The ack callback fires on the server's confirmation or on the timeout —
      // either way we disconnect and return to idle so the UI never wedges.
      socket.timeout(STOP_ACK_TIMEOUT_MS).emit("voice:stop", () => {
        socket.disconnect()
        setState("idle")
      })
    } else {
      setState("idle")
    }
  }, [state, teardownAudio, flushInterim, coordinator, coordinatedStop])
  // Keep the stable coordinator handle pointed at the latest stop().
  stopRef.current = stop

  // Backgrounding the tab throttles the rAF meter and (on mobile) suspends audio
  // capture, so a take left "recording" would silently record nothing while the
  // UI still says it's live. End it cleanly on hide instead: stop() flushes the
  // in-flight hypothesis and commits the landed text, so the user returns to
  // their words and an idle mic rather than a dead one they think is recording.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopRef.current()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [])

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
    interimText,
    level,
    elapsedMs,
    maxDurationMs,
    start,
    stop,
  }
}
