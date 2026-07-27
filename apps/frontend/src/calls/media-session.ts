/**
 * The web's closest approximation of a system call overlay: on Android the Media
 * Session API renders a lock-screen notification carrying the call's title, a mute
 * toggle and a hang-up button, and signals to the OS that this page is doing
 * something worth keeping alive.
 *
 * A media session requires *actually playing* audio. `attachRemoteAudio` only
 * creates an `<audio>` per pulled remote track, so a call that is ringing out — or
 * a solo call, exactly when a lock-screen control matters most — has none. Hence
 * one long-lived silent element owned for the session's life, additive to the
 * per-track elements (which stay for the AEC reference and `setSinkId`).
 */

export const SILENT_WAV_SAMPLE_RATE = 8000
/**
 * Chromium classifies a player whose `duration` is under 5s as *transient*
 * (`kMinimumContentDuration`, `media/base/media_content_type.cc`) — a
 * notification blip, not content — and builds no controllable media session for
 * it. `loop = true` does not raise `duration`, so a short clip yields no
 * lock-screen notification at all. Stay clear of that floor.
 */
export const SILENT_WAV_SECONDS = 8

let silentWavDataUri: string | null = null

/**
 * 8-bit mono PCM silence as a `data:` URI — no network fetch, and the same
 * scheme the element used before it had to clear the 5s floor. Generated once
 * rather than embedded, so ~64KB of zeros stays out of the bundle.
 */
function getSilentWav(): string {
  if (silentWavDataUri) return silentWavDataUri
  const dataBytes = SILENT_WAV_SECONDS * SILENT_WAV_SAMPLE_RATE
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i)
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true)
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE, true)
  view.setUint16(32, 1, true)
  view.setUint16(34, 8, true)
  ascii(36, "data")
  view.setUint32(40, dataBytes, true)
  // Silence in unsigned 8-bit PCM is the midpoint, not zero.
  bytes.fill(0x80, 44)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  silentWavDataUri = `data:audio/wav;base64,${btoa(binary)}`
  return silentWavDataUri
}

const CALL_ACTIONS = ["hangup", "togglemicrophone", "togglecamera"] as const

type CallAction = (typeof CALL_ACTIONS)[number]

/** The `navigator.mediaSession` surface this module touches. */
export interface MediaSessionLike {
  metadata: unknown
  playbackState: string
  setActionHandler(action: string, handler: (() => void) | null): void
  setMicrophoneActive?(active: boolean): void
  setCameraActive?(active: boolean): void
}

export interface CallMediaSessionHandlers {
  hangup: () => void
  toggleMicrophone: () => void
  toggleCamera: () => void
}

export interface CallMediaSession {
  activate(metadata: { title: string; subtitle: string }): void
  setTitle(title: string): void
  setHandlers(handlers: CallMediaSessionHandlers): void
  setMicrophoneActive(active: boolean): void
  setCameraActive(active: boolean): void
  release(): void
}

/**
 * Injected so no test touches a real `navigator.mediaSession` (jsdom has none)
 * and no global is monkey-patched.
 */
export interface CallMediaSessionDeps {
  mediaSession: MediaSessionLike
  createAudioElement(): HTMLAudioElement
  createMetadata(init: { title: string; artist: string }): unknown
}

function defaultDeps(): CallMediaSessionDeps | null {
  if (typeof navigator === "undefined" || typeof document === "undefined") return null
  const mediaSession = (navigator as Navigator & { mediaSession?: MediaSessionLike }).mediaSession
  if (!mediaSession) return null
  const MetadataCtor = (globalThis as { MediaMetadata?: new (init: unknown) => unknown }).MediaMetadata
  return {
    mediaSession,
    createAudioElement: () => document.createElement("audio"),
    createMetadata: (init) => (MetadataCtor ? new MetadataCtor(init) : null),
  }
}

export function createCallMediaSession(deps?: CallMediaSessionDeps): CallMediaSession | null {
  const resolved = deps ?? defaultDeps()
  if (!resolved) return null
  const { mediaSession } = resolved

  let audio: HTMLAudioElement | null = null
  let subtitle = ""

  const writeMetadata = (title: string) => {
    mediaSession.metadata = resolved.createMetadata({ title, artist: subtitle })
  }

  // Each handler is registered on its own: an action the browser does not know
  // throws `TypeError`, and one unsupported action must not take the supported
  // ones down with it. Per-action tolerance of a documented browser behaviour,
  // not a swallowed error.
  const setAction = (action: CallAction, handler: (() => void) | null) => {
    try {
      mediaSession.setActionHandler(action, handler)
    } catch {
      // Unsupported action — the remaining handlers still register.
    }
  }

  return {
    activate({ title, subtitle: sub }) {
      subtitle = sub
      const el = resolved.createAudioElement()
      el.src = getSilentWav()
      el.loop = true
      // Not muted: a muted element gives the OS no session to attach to.
      el.muted = false
      audio = el
      void el.play?.()?.catch(() => {})
      writeMetadata(title)
      mediaSession.playbackState = "playing"
    },
    setTitle(title) {
      writeMetadata(title)
    },
    setHandlers(handlers) {
      setAction("hangup", handlers.hangup)
      setAction("togglemicrophone", handlers.toggleMicrophone)
      setAction("togglecamera", handlers.toggleCamera)
    },
    setMicrophoneActive(active) {
      mediaSession.setMicrophoneActive?.(active)
    },
    setCameraActive(active) {
      mediaSession.setCameraActive?.(active)
    },
    release() {
      audio?.pause?.()
      audio?.remove?.()
      audio = null
      for (const action of CALL_ACTIONS) setAction(action, null)
      mediaSession.metadata = null
      mediaSession.playbackState = "none"
    },
  }
}
