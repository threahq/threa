import { describe, it, expect, vi } from "vitest"
import {
  createCallMediaSession,
  SILENT_WAV_SAMPLE_RATE,
  type CallMediaSessionDeps,
  type MediaSessionLike,
} from "./media-session"

/** Chromium's `kMinimumContentDuration`: below it a player is transient and gets no media session. */
const CHROMIUM_MIN_CONTENT_SECONDS = 5

function decodeWav(dataUri: string) {
  const binary = atob(dataUri.slice("data:audio/wav;base64,".length))
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const dataBytes = view.getUint32(40, true)
  const byteRate = view.getUint32(28, true)
  return {
    riff: binary.slice(0, 4),
    wave: binary.slice(8, 12),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes,
    seconds: dataBytes / byteRate,
    /** Unsigned 8-bit PCM silence is the midpoint; zeros would be full-scale negative. */
    allSilent: bytes.slice(44).every((b) => b === 0x80),
  }
}

interface FakeAudio {
  src: string
  loop: boolean
  muted: boolean
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function makeAudio(): FakeAudio {
  return {
    src: "",
    loop: false,
    muted: true,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    remove: vi.fn(),
  }
}

interface FakeMediaSession extends MediaSessionLike {
  handlers: Map<string, (() => void) | null>
  /** Actions whose `setActionHandler` throws `TypeError`, as an unsupported one does. */
  unsupported: Set<string>
}

function makeMediaSession(unsupported: string[] = []): FakeMediaSession {
  const handlers = new Map<string, (() => void) | null>()
  return {
    metadata: null,
    playbackState: "none",
    handlers,
    unsupported: new Set(unsupported),
    setActionHandler(action, handler) {
      if (this.unsupported.has(action)) throw new TypeError(`Unsupported action: ${action}`)
      handlers.set(action, handler)
    },
    setMicrophoneActive: vi.fn(),
    setCameraActive: vi.fn(),
  }
}

function build(unsupported: string[] = []) {
  const audio = makeAudio()
  const mediaSession = makeMediaSession(unsupported)
  const deps: CallMediaSessionDeps = {
    mediaSession,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
    createMetadata: (init) => init,
  }
  const session = createCallMediaSession(deps)
  if (!session) throw new Error("expected a media session")
  return { session, audio, mediaSession }
}

describe("createCallMediaSession", () => {
  it("activate plays a looping, unmuted silent element and publishes the metadata", () => {
    const { session, audio, mediaSession } = build()

    session.activate({ title: "#design", subtitle: "Threa" })

    expect({
      src: audio.src.startsWith("data:audio/wav;base64,"),
      loop: audio.loop,
      muted: audio.muted,
      played: audio.play.mock.calls.length > 0,
      metadata: mediaSession.metadata,
      playbackState: mediaSession.playbackState,
    }).toEqual({
      src: true,
      loop: true,
      muted: false,
      played: true,
      metadata: { title: "#design", artist: "Threa" },
      playbackState: "playing",
    })
  })

  it("the silent element clears Chromium's transient-media floor, or there is no notification at all", () => {
    const { session, audio } = build()

    session.activate({ title: "#design", subtitle: "Threa" })
    const wav = decodeWav(audio.src)

    expect(wav.seconds).toBeGreaterThan(CHROMIUM_MIN_CONTENT_SECONDS)
    expect({
      riff: wav.riff,
      wave: wav.wave,
      format: wav.format,
      channels: wav.channels,
      sampleRate: wav.sampleRate,
      bitsPerSample: wav.bitsPerSample,
      dataBytes: wav.dataBytes,
      allSilent: wav.allSilent,
    }).toEqual({
      riff: "RIFF",
      wave: "WAVE",
      format: 1,
      channels: 1,
      sampleRate: SILENT_WAV_SAMPLE_RATE,
      bitsPerSample: 8,
      dataBytes: wav.seconds * SILENT_WAV_SAMPLE_RATE,
      allSilent: true,
    })
  })

  it("setTitle rewrites the title, keeping the subtitle from activate", () => {
    const { session, mediaSession } = build()
    session.activate({ title: "Call", subtitle: "Threa" })

    session.setTitle("Grace")

    expect(mediaSession.metadata).toEqual({ title: "Grace", artist: "Threa" })
  })

  it("an unsupported action still leaves the supported handlers registered", () => {
    const { session, mediaSession } = build(["hangup"])
    const toggleMicrophone = vi.fn()

    session.setHandlers({ hangup: vi.fn(), toggleMicrophone, toggleCamera: vi.fn() })

    // `hangup` threw TypeError and never registered; the rest must be unaffected.
    expect(mediaSession.handlers.has("hangup")).toBe(false)
    mediaSession.handlers.get("togglemicrophone")?.()
    expect(toggleMicrophone).toHaveBeenCalled()
    expect(mediaSession.handlers.has("togglecamera")).toBe(true)
  })

  it("mirrors the mic and camera state onto the notification toggles", () => {
    const { session, mediaSession } = build()

    session.setMicrophoneActive(false)
    session.setCameraActive(true)

    expect(mediaSession.setMicrophoneActive).toHaveBeenCalledWith(false)
    expect(mediaSession.setCameraActive).toHaveBeenCalledWith(true)
  })

  it("release pauses and removes the element, clears every handler and nulls the metadata", () => {
    const { session, audio, mediaSession } = build()
    session.activate({ title: "#design", subtitle: "Threa" })
    session.setHandlers({ hangup: vi.fn(), toggleMicrophone: vi.fn(), toggleCamera: vi.fn() })

    session.release()

    expect({
      paused: audio.pause.mock.calls.length,
      removed: audio.remove.mock.calls.length,
      handlers: Object.fromEntries(mediaSession.handlers),
      metadata: mediaSession.metadata,
      playbackState: mediaSession.playbackState,
    }).toEqual({
      paused: 1,
      removed: 1,
      handlers: { hangup: null, togglemicrophone: null, togglecamera: null },
      metadata: null,
      playbackState: "none",
    })
  })
})
