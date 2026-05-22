import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import * as cachedWsConfig from "@/lib/cached-ws-config"
import { voiceApi } from "@/api/voice"
import { useVoiceDictation } from "./use-voice-dictation"

// socket.io-client's `io` is a non-configurable ESM export, so spyOn can't wrap
// it — mock the third-party transport itself and route through a mutable holder
// so each test gets the fresh fake socket built in beforeEach.
const socketHolder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock("socket.io-client", () => ({ io: () => socketHolder.current }))

const SESSION_ID = "voicesess_test"

// Captures the handlers the hook registers so a test can drive server pushes
// (delta / disconnect) and resolve the start/stop acks synchronously.
function makeFakeSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {}
  const socket = {
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers[event] = cb
      return socket
    },
    emit(event: string, _payload: unknown, ack?: (result: { ok: boolean }) => void) {
      if (event === "voice:start") ack?.({ ok: true })
      return socket
    },
    timeout() {
      return { emit: (_event: string, ack?: () => void) => ack?.() }
    },
    disconnect: vi.fn(),
  }
  return { socket, handlers }
}

const audioNode = () => ({ connect: vi.fn(), disconnect: vi.fn() })

class FakeAudioContext {
  state = "running"
  destination = audioNode()
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  createMediaStreamSource = vi.fn(audioNode)
  createGain = vi.fn(() => ({ ...audioNode(), gain: { value: 0 } }))
  createAnalyser = vi.fn(() => ({
    ...audioNode(),
    fftSize: 0,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: vi.fn(),
  }))
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn().mockResolvedValue(undefined)
}

class FakeAudioWorkletNode {
  port = { onmessage: null as unknown, postMessage: vi.fn(), close: vi.fn() }
  connect = vi.fn()
  disconnect = vi.fn()
}

function defineGlobal(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
}

describe("useVoiceDictation lifecycle", () => {
  let fake: ReturnType<typeof makeFakeSocket>

  beforeEach(() => {
    fake = makeFakeSocket()
    defineGlobal(window, "AudioContext", FakeAudioContext)
    defineGlobal(globalThis, "AudioWorkletNode", FakeAudioWorkletNode)
    defineGlobal(navigator, "mediaDevices", {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    })
    // Keep the rAF meter loop from actually scheduling — start() only needs the
    // first call to succeed, not a running loop.
    defineGlobal(globalThis, "requestAnimationFrame", () => 0)
    defineGlobal(globalThis, "cancelAnimationFrame", () => {})
    defineGlobal(document, "visibilityState", "visible")

    vi.spyOn(cachedWsConfig, "getCachedWsConfig").mockReturnValue({ wsUrl: "http://localhost:3000" } as never)
    vi.spyOn(voiceApi, "createSession").mockResolvedValue({
      voiceSessionId: SESSION_ID,
      model: "elevenlabs:scribe-v2-realtime",
      provider: "elevenlabs",
      region: "us",
      expiresAt: "2026-01-01T00:00:00.000Z",
      maxDurationMs: 600_000,
    })
    vi.spyOn(voiceApi, "abortSession").mockResolvedValue(undefined)
    socketHolder.current = fake.socket
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function startRecording(onCommittedText: (text: string) => void) {
    const view = renderHook(() => useVoiceDictation({ workspaceId: "ws_1", onCommittedText }))
    act(() => view.result.current.start())
    await waitFor(() => expect(view.result.current.state).toBe("recording"))
    return view
  }

  // Feeds a not-yet-final hypothesis the way the gateway streams partials.
  function pushInterim(text: string) {
    act(() => fake.handlers["voice:transcript:delta"]({ voiceSessionId: SESSION_ID, text, isFinal: false }))
  }

  it("commits the in-flight hypothesis and goes idle when the tab is hidden", async () => {
    const onCommittedText = vi.fn()
    const { result } = await startRecording(onCommittedText)
    pushInterim("hello there")
    expect(result.current.interimText).toBe("hello there")

    act(() => {
      defineGlobal(document, "visibilityState", "hidden")
      document.dispatchEvent(new Event("visibilitychange"))
    })

    await waitFor(() => expect(result.current.state).toBe("idle"))
    // The take ended cleanly: the words the user saw are kept, not dropped.
    expect(onCommittedText).toHaveBeenCalledWith("hello there")
    expect(result.current.interimText).toBe("")
  })

  it("preserves landed text and surfaces an error when the socket drops", async () => {
    const onCommittedText = vi.fn()
    const { result } = await startRecording(onCommittedText)
    pushInterim("partial words")

    act(() => fake.handlers["disconnect"]())

    await waitFor(() => expect(result.current.state).toBe("error"))
    expect(onCommittedText).toHaveBeenCalledWith("partial words")
    expect(result.current.error).toBe("Dictation connection lost")
  })

  it("stays idle on hide when no take is active", async () => {
    const { result } = renderHook(() => useVoiceDictation({ workspaceId: "ws_1", onCommittedText: vi.fn() }))
    expect(result.current.state).toBe("idle")

    act(() => {
      defineGlobal(document, "visibilityState", "hidden")
      document.dispatchEvent(new Event("visibilitychange"))
    })

    expect(result.current.state).toBe("idle")
  })
})
