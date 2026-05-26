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
  /**
   * Present only on finals when polish is enabled for the session. The same
   * chunkId is reused for every final + every polished event in the session,
   * so the editor tracks one growing range and the end-of-session polish swap
   * targets it directly.
   */
  chunkId?: string
}

interface VoicePolishedChunk {
  voiceSessionId: string
  chunkId: string
  raw: string
  polished: string
}

export interface DictationChunkRecord {
  /** Cumulative raw text the chunk would revert to if the toggle flips to "Show original". */
  raw: string
  /**
   * Latest polished snapshot from the backend. Each new final delta triggers
   * a cumulative polish whose output supersedes this — so an earlier
   * misspoken phrase can be rewritten by a later self-correction.
   */
  polished: string
  /** Whether the editor currently shows the polished or the raw text for this chunk. */
  currentlyShowing: "polished" | "raw"
  /**
   * True once the chunk can no longer be swapped (the user edited inside it
   * or the post-session grace window expired). Locked chunks stay in the doc
   * as plain text.
   */
  locked: boolean
}

interface UseVoiceDictationOptions {
  workspaceId: string
  /**
   * Called with a committed (final) transcript span when polish is OFF for
   * this session. When polish is ON, `onPolishedChunkInserted` is called
   * instead and this never fires for that chunk.
   */
  onCommittedText: (text: string) => void
  /**
   * Insert a polished chunk into the editor with tracking, so a later toggle
   * can swap it back to raw. The text passed is whatever the toggle currently
   * resolves to (polished by default).
   */
  onPolishedChunkInserted?: (args: { chunkId: string; text: string }) => void
  /**
   * Swap a tracked chunk's text in the editor. Must return true if the swap
   * landed cleanly, false if the chunk was missing or the user edited inside
   * it (the hook then locks that chunk locally so the toggle stops touching it).
   */
  onChunkSwap?: (args: { chunkId: string; newText: string; expectedText: string }) => boolean
  /** Drop tracking for all polished chunks (e.g. session-expired or new take starting). */
  onLockAllChunks?: () => void
  /**
   * Read the live text currently inside a tracked chunk straight from the
   * editor. The editor's decoration is the source of truth — when the user
   * edits text adjacent to the chunk, ProseMirror's mapping updates the
   * tracked range, and we want the actual mapped text rather than a
   * parallel prediction. Returns null when the chunkId isn't tracked.
   */
  onGetChunkText?: (chunkId: string) => string | null
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
  /**
   * Map of polished chunks landed in this session, keyed by chunkId. Empty
   * when polish is off for the session or no final chunks have arrived yet.
   * Insertion order matches the order the chunks landed in the editor.
   */
  chunks: ReadonlyMap<string, DictationChunkRecord>
  /** True when there's at least one unlocked polished chunk the toggle can act on. */
  hasUnlockedChunks: boolean
  /** True when the toggle currently shows raw transcripts; false when it shows polished. */
  showOriginal: boolean
  /** Flip the session-wide toggle. Walks every unlocked chunk and swaps its text in the editor. */
  setShowOriginal: (target: boolean) => void
  /**
   * Non-fatal warning that the selected input device is producing silence.
   * Fires in two cases:
   *   - Initial silence: the analyser has been at zero since the take began
   *     (Bluetooth headset stuck on A2DP, wired headphones with no working
   *     mic, OS-muted input) — surfaces fast (~2.5s).
   *   - Lost signal: the take was capturing audio and then went dead (HFP
   *     dropped, USB glitch) — surfaces slower (~5s) so legitimate pauses
   *     don't nag.
   * Null otherwise. Clears automatically once signal returns.
   */
  noAudioWarning: string | null
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

// Silence-detection thresholds. Two failure modes to catch:
//
// 1. Initial silence: the analyser was at zero from the moment the take began.
//    The selected input is dead (Bluetooth headset stuck on A2DP, wired
//    headphones with no working mic, OS-muted input). Fires fast (2.5s)
//    because there's no ambiguity — a working mic shows ambient ADC dither
//    within milliseconds.
//
// 2. Lost signal: the take WAS capturing audio and then went silent — e.g. a
//    Bluetooth headset that briefly entered HFP and then dropped back, a USB
//    glitch, a profile renegotiation. Fires slower (5s) to give legitimate
//    pauses (taking a breath, thinking mid-sentence) room before nagging.
//
// `peakLevelInTakeRef >= NO_AUDIO_PEAK_THRESHOLD` separates the two cases:
// peak only ever ratchets up, so if it's still below the floor we're in
// case 1; otherwise we're in case 2 and the question becomes "how long since
// the LAST signal crossing".
export const NO_AUDIO_INITIAL_WAIT_MS = 2500
export const NO_AUDIO_SILENCE_WAIT_MS = 5000
export const NO_AUDIO_PEAK_THRESHOLD = 0.003

export function shouldWarnNoAudio(args: { elapsedMs: number; silenceMs: number; peakLevel: number }): boolean {
  if (args.peakLevel >= NO_AUDIO_PEAK_THRESHOLD) {
    return args.silenceMs >= NO_AUDIO_SILENCE_WAIT_MS
  }
  return args.elapsedMs >= NO_AUDIO_INITIAL_WAIT_MS
}

export function noAudioWarningMessage(args: { deviceLabel: string | null; everHadSignal: boolean }): string {
  const device = args.deviceLabel && args.deviceLabel.trim().length > 0 ? args.deviceLabel : "your microphone"
  return args.everHadSignal
    ? `Audio from ${device} dropped — check it's still active or switch inputs`
    : `We're not hearing audio from ${device} — try a different input device`
}

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

// Once a session ends, polished chunks stay swappable for a short window so
// the user can flip the toggle on their way to read what landed. Kept short
// so the "Showing polished" pill doesn't linger past the moment they're
// glancing at it — the user wants to send the message, not stare at the
// toggle.
const POST_SESSION_LOCK_MS = 8_000

/**
 * Drives one voice-dictation session: create the session over HTTP, capture
 * mic audio as PCM16 frames via an AudioWorklet, stream them up the dedicated
 * `/voice` socket namespace, and surface transcript spans. Committed (final)
 * spans are forwarded to `onCommittedText`; the in-flight hypothesis is exposed
 * live via `interimText` so callers can show words as they're spoken.
 *
 * When the user has polish enabled in preferences, the backend additionally
 * emits `voice:transcript:polished` for each final chunk. The hook tracks each
 * polished chunk so the session-wide "Show original" toggle can swap chunks
 * between raw and polished text in-place — until the post-session grace window
 * expires or the user edits inside a chunk, at which point that chunk locks.
 */
export function useVoiceDictation(options: UseVoiceDictationOptions): UseVoiceDictationResult {
  const {
    workspaceId,
    onCommittedText,
    onPolishedChunkInserted,
    onChunkSwap,
    onLockAllChunks,
    onGetChunkText,
    language,
  } = options
  const [state, setState] = useState<VoiceDictationState>("idle")
  const [error, setError] = useState<string | null>(null)
  const [interimText, setInterimText] = useState("")
  const [level, setLevel] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [maxDurationMs, setMaxDurationMs] = useState<number | null>(null)
  const [chunks, setChunks] = useState<Map<string, DictationChunkRecord>>(() => new Map())
  const [showOriginal, setShowOriginalState] = useState(false)
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
  // Silence detection. Peak tracks the highest smoothed level seen in the
  // current take (used as a "have we EVER had signal" proxy — it only ratchets
  // up). `lastSignalAt` tracks the timestamp of the most recent tick that
  // crossed the threshold, so the lost-signal warning can measure "time since
  // we last heard anything". `deviceLabel` is the human-readable input name
  // from the MediaStreamTrack so the warning can name the offending mic.
  // `warningShownRef` mirrors the React state so the rAF tick can avoid
  // setState churn when the condition hasn't flipped.
  const peakLevelInTakeRef = useRef(0)
  const lastSignalAtRef = useRef(0)
  const deviceLabelRef = useRef<string | null>(null)
  const warningShownRef = useRef(false)
  const [noAudioWarning, setNoAudioWarning] = useState<string | null>(null)
  // Bumped on every start() and every teardown/stop so a `voice:start` ACK that
  // resolves after the user has already stopped (or torn down) can't flip the
  // state machine back to "recording" with nothing behind it.
  const startGenerationRef = useRef(0)
  // Keep the latest callbacks without re-subscribing the socket or re-binding
  // start()/stop(). The polished-chunk callback in particular fires from inside
  // a socket handler that captured the editor handle at subscribe time.
  const onCommittedTextRef = useRef(onCommittedText)
  onCommittedTextRef.current = onCommittedText
  const onPolishedChunkInsertedRef = useRef(onPolishedChunkInserted)
  onPolishedChunkInsertedRef.current = onPolishedChunkInserted
  const onChunkSwapRef = useRef(onChunkSwap)
  onChunkSwapRef.current = onChunkSwap
  const onLockAllChunksRef = useRef(onLockAllChunks)
  onLockAllChunksRef.current = onLockAllChunks
  const onGetChunkTextRef = useRef(onGetChunkText)
  onGetChunkTextRef.current = onGetChunkText
  // Read by the socket handler at insert time so the chunk lands in whichever
  // mode the toggle currently shows (the toggle can be flipped mid-session).
  const showOriginalRef = useRef(showOriginal)
  showOriginalRef.current = showOriginal
  // Post-session lock window: a single timer expires the whole session at once,
  // dropping editor-side tracking and clearing chunks state so the toggle hides.
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The session-wide chunkId for the active take, set on the first final
  // delta the backend tags. Reset when a new take starts.
  const sessionChunkIdRef = useRef<string | null>(null)

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
    peakLevelInTakeRef.current = 0
    lastSignalAtRef.current = 0
    deviceLabelRef.current = null
    if (warningShownRef.current) {
      warningShownRef.current = false
      setNoAudioWarning(null)
    }
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
      if (next > peakLevelInTakeRef.current) peakLevelInTakeRef.current = next
      if (Math.abs(next - lastSetLevelRef.current) >= 0.02) {
        lastSetLevelRef.current = next
        setLevel(next)
      }
      const now = performance.now()
      // Stamp the last-signal timestamp every tick the smoothed level crosses
      // the floor. Used by the lost-signal branch of shouldWarnNoAudio so a
      // take that briefly captured audio then went dead (e.g. headphone HFP
      // dropping back to A2DP mid-take) is still surfaced to the user.
      if (next >= NO_AUDIO_PEAK_THRESHOLD) lastSignalAtRef.current = now
      if (now - lastElapsedTickRef.current >= 250) {
        lastElapsedTickRef.current = now
        const elapsed = now - recordingStartRef.current
        setElapsedMs(elapsed)
        const peak = peakLevelInTakeRef.current
        const everHadSignal = peak >= NO_AUDIO_PEAK_THRESHOLD
        // Time since last signal crossing. If we've never had signal,
        // lastSignalAt is still 0 / take-start, so this reduces to elapsed —
        // but the initial-silence branch in shouldWarnNoAudio ignores it
        // anyway and gates on elapsed alone.
        const silenceMs = everHadSignal ? now - lastSignalAtRef.current : elapsed
        const shouldWarn = shouldWarnNoAudio({ elapsedMs: elapsed, silenceMs, peakLevel: peak })
        if (shouldWarn && !warningShownRef.current) {
          warningShownRef.current = true
          setNoAudioWarning(noAudioWarningMessage({ deviceLabel: deviceLabelRef.current, everHadSignal }))
        } else if (!shouldWarn && warningShownRef.current) {
          warningShownRef.current = false
          setNoAudioWarning(null)
        }
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

  // Drop tracking for every polished chunk: tell the editor to drop its
  // decorations, clear our local map, and reset the toggle. Used by the
  // post-session lock timer and on the start of a fresh take.
  const lockAllChunks = useCallback(() => {
    if (lockTimerRef.current !== null) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
    onLockAllChunksRef.current?.()
    setChunks((prev) => (prev.size === 0 ? prev : new Map()))
    setShowOriginalState(false)
    sessionChunkIdRef.current = null
  }, [])

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
    // Starting a new take supersedes any polished chunks from the previous
    // session — drop their tracking and reset the toggle so the new take begins
    // from a clean slate.
    lockAllChunks()
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
        // Capture the device label so the silence-detection warning can name
        // the offending input ("AirPods Pro", "MacBook Pro Microphone"). The
        // label is populated post-permission; if the browser hides it we fall
        // back to a generic phrasing in the message builder.
        deviceLabelRef.current = stream.getAudioTracks()[0]?.label || null

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
          if (!delta.isFinal) {
            // Running hypothesis for the current segment — each partial replaces
            // the prior one rather than appending.
            updateInterim(delta.text)
            return
          }
          // Final segment. With polish on, the backend tags it with a
          // session-wide chunkId so the editor extends a single tracked
          // range we can later swap to the polished snapshot. Without
          // a chunkId, it's a plain commit (polish off, or an empty/
          // terminating final).
          if (delta.chunkId && delta.text) {
            // First final of the take latches the session-wide chunkId.
            // Subsequent finals extend the same tracked range in the editor;
            // we no longer predict the chunk's text here — the editor's
            // decoration is the source of truth and we read it via
            // onGetChunkText when we need the canonical expectedText.
            if (!sessionChunkIdRef.current) sessionChunkIdRef.current = delta.chunkId
            onPolishedChunkInsertedRef.current?.({ chunkId: delta.chunkId, text: delta.text })
          } else if (delta.text) {
            onCommittedTextRef.current(delta.text)
          }
          updateInterim("")
        })
        socket.on("voice:transcript:polished", (chunk: VoicePolishedChunk) => {
          // Stale chunk from a previous take — ignore it so polishing latency
          // can't leak text into a new session.
          if (chunk.voiceSessionId !== sessionIdRef.current) return
          if (chunk.chunkId !== sessionChunkIdRef.current) return
          // Swap the editor's session chunk to whichever mode the toggle is
          // showing right now (the toggle can be flipped mid-session). If the
          // editor accepts, update bookkeeping; if it rejects (the user edited
          // inside the chunk), lock and forget — the user's edit wins.
          //
          // The expectedText comes from the editor itself rather than a
          // hook-side prediction: ProseMirror's mapping is the source of
          // truth for what's currently inside the tracked range (including
          // any spaces the extension absorbed when extending the chunk).
          const target = showOriginalRef.current ? chunk.raw : chunk.polished
          const expected = onGetChunkTextRef.current?.(chunk.chunkId) ?? null
          let accepted = true
          if (expected === null) {
            // No tracked chunk in the editor — either it was never inserted
            // here or it has already been locked/cleared. Drop our tracking
            // for it so the toggle never tries to act on a missing chunk.
            accepted = false
          } else if (target !== expected) {
            accepted =
              onChunkSwapRef.current?.({ chunkId: chunk.chunkId, newText: target, expectedText: expected }) ?? false
          }
          setChunks((prev) => {
            const next = new Map(prev)
            if (!accepted) {
              const existing = prev.get(chunk.chunkId)
              if (existing) next.set(chunk.chunkId, { ...existing, locked: true })
              return next
            }
            next.set(chunk.chunkId, {
              raw: chunk.raw,
              polished: chunk.polished,
              currentlyShowing: showOriginalRef.current ? "raw" : "polished",
              locked: false,
            })
            return next
          })
          if (!accepted) sessionChunkIdRef.current = null
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
            peakLevelInTakeRef.current = 0
            lastSignalAtRef.current = recordingStartRef.current
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
  }, [
    state,
    workspaceId,
    language,
    fail,
    teardown,
    flushInterim,
    runMeter,
    coordinator,
    coordinatedStop,
    lockAllChunks,
  ])

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
    // The take is over — start the post-session lock countdown. The user gets a
    // grace window to flip the toggle and read what landed before the chunks
    // freeze as plain text. A new take or another stop resets the timer.
    if (lockTimerRef.current !== null) clearTimeout(lockTimerRef.current)
    lockTimerRef.current = setTimeout(() => {
      lockTimerRef.current = null
      lockAllChunks()
    }, POST_SESSION_LOCK_MS)
  }, [state, teardownAudio, flushInterim, coordinator, coordinatedStop, lockAllChunks])
  // Keep the stable coordinator handle pointed at the latest stop().
  stopRef.current = stop

  // Flip the session-wide toggle. Walks every unlocked chunk, asks the editor
  // to swap its text, and tracks the result. If the editor refuses the swap
  // (the user typed inside that chunk), the chunk locks locally so the toggle
  // stops touching it on future flips.
  //
  // The editor swap is a side effect, so we do it *outside* of any state
  // updater — calling editor mutations inside a setState updater would fire
  // them twice under concurrent rendering. Reads the live `chunks` map via
  // closure; that's fine because the toggle button is only enabled when there
  // is at least one chunk to act on (so the closure is fresh).
  const setShowOriginal = useCallback(
    (target: boolean) => {
      if (target === showOriginal) return
      if (chunks.size === 0) {
        setShowOriginalState(target)
        return
      }
      const next = new Map(chunks)
      for (const [chunkId, record] of chunks) {
        if (record.locked) continue
        const newText = target ? record.raw : record.polished
        // Query the editor for the true current text of this chunk. ProseMirror
        // mapping absorbs adjacent edits into the tracked range, so the live
        // decoration text is the only reliable expectedText.
        const expectedText =
          onGetChunkTextRef.current?.(chunkId) ?? (record.currentlyShowing === "raw" ? record.raw : record.polished)
        if (newText === expectedText) {
          // No textual difference (polish was a no-op for this chunk). Still
          // update the bookkeeping so currentlyShowing reflects the user's
          // intent.
          next.set(chunkId, { ...record, currentlyShowing: target ? "raw" : "polished" })
          continue
        }
        const accepted = onChunkSwapRef.current?.({ chunkId, newText, expectedText }) ?? false
        if (accepted) {
          next.set(chunkId, { ...record, currentlyShowing: target ? "raw" : "polished" })
        } else {
          // The editor rejected the swap (the user edited inside the chunk or
          // the decoration was already gone) — give up on tracking this one so
          // the toggle never tries to swap it again.
          next.set(chunkId, { ...record, locked: true })
          if (chunkId === sessionChunkIdRef.current) sessionChunkIdRef.current = null
        }
      }
      setChunks(next)
      setShowOriginalState(target)
    },
    [chunks, showOriginal]
  )

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
  // so it doesn't linger until the max-duration guard. Also clear the lock
  // timer so it doesn't fire against a torn-down editor handle.
  useEffect(() => {
    return () => {
      const sessionId = sessionIdRef.current
      const hadSocket = socketRef.current !== null
      teardown()
      if (lockTimerRef.current !== null) {
        clearTimeout(lockTimerRef.current)
        lockTimerRef.current = null
      }
      if (sessionId && !hadSocket) {
        void voiceApi.abortSession(workspaceId, sessionId).catch(() => {})
      }
    }
  }, [teardown, workspaceId])

  let hasUnlockedChunks = false
  for (const record of chunks.values()) {
    if (!record.locked) {
      hasUnlockedChunks = true
      break
    }
  }

  return {
    state,
    supported: supportRef.current.supported,
    unsupportedReason: supportRef.current.reason,
    error,
    interimText,
    level,
    elapsedMs,
    maxDurationMs,
    chunks,
    hasUnlockedChunks,
    showOriginal,
    setShowOriginal,
    noAudioWarning,
    start,
    stop,
  }
}
