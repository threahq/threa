import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, it, expect, vi } from "vitest"
import type { JSONContent, VoiceStartAck, VoiceTranscriptDelta } from "@threa/types"
import {
  friendlyTranscriptionError,
  shouldWarnNoAudio,
  noAudioWarningMessage,
  NO_AUDIO_INITIAL_WAIT_MS,
  NO_AUDIO_SILENCE_WAIT_MS,
  resetVoiceTakeProtocol,
  useVoiceDictation,
} from "./use-voice-dictation"

class FakeSocket {
  handlers = new Map<string, (payload: unknown) => void>()
  stopCallbacks: Array<() => void> = []
  stopPayloads: unknown[] = []
  disconnected = false
  private timeoutMs: number | null = null
  constructor(private readonly ack: VoiceStartAck) {}
  on(event: string, callback: (payload: unknown) => void) {
    this.handlers.set(event, callback)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    if (event === "voice:start") (args[1] as (ack: VoiceStartAck) => void)(this.ack)
    if (event === "voice:stop") {
      this.stopPayloads.push(args[0])
      const callback = args.at(-1)
      if (typeof callback === "function") {
        this.stopCallbacks.push(callback as () => void)
        if (this.timeoutMs !== null) setTimeout(callback as () => void, this.timeoutMs)
      }
    }
    return this
  }
  timeout(ms: number) {
    this.timeoutMs = ms
    return this
  }
  disconnect() {
    this.disconnected = true
    return this
  }
  fire(event: string, payload: unknown) {
    this.handlers.get(event)?.(payload)
  }
}

class FakeAudioContext {
  state = "running"
  destination = {}
  audioWorklet = { addModule: async () => {} }
  onstatechange: (() => void) | null = null
  resume = async () => {}
  close = async () => {}
  createMediaStreamSource = () => ({ connect: () => {} })
  createGain = () => ({ gain: { value: 0 }, connect: () => {} })
  createAnalyser = () => ({
    fftSize: 1024,
    smoothingTimeConstant: 0,
    disconnect: () => {},
    getByteTimeDomainData: () => {},
  })
}

class FakeWorklet {
  port = { close: () => {}, onmessage: null }
  connect() {}
  disconnect() {}
}

const stream = {
  getAudioTracks: () => [{ label: "Test mic", onmute: null, onunmute: null }],
  getTracks: () => [{ stop: () => {} }],
}

beforeEach(() => {
  localStorage.setItem("threa-ws-config:ws_1", JSON.stringify({ region: "test", wsUrl: "https://voice.test" }))
  Object.defineProperty(window, "AudioContext", { configurable: true, value: FakeAudioContext })
  Object.defineProperty(globalThis, "AudioWorkletNode", { configurable: true, value: FakeWorklet })
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  })
  vi.stubGlobal("requestAnimationFrame", () => 1)
  vi.stubGlobal("cancelAnimationFrame", () => {})
})

function hookHarness(acks: VoiceStartAck[], callbacks: Partial<Parameters<typeof useVoiceDictation>[0]> = {}) {
  const sockets: FakeSocket[] = []
  let session = 0
  const abortSession = vi.fn(async () => {})
  const dependencies = {
    createSocket: (() => {
      const socket = new FakeSocket(acks[sockets.length])
      sockets.push(socket)
      return socket
    }) as never,
    createSession: vi.fn(async () => ({
      voiceSessionId: `voicesess_${++session}`,
      model: "test",
      provider: "test",
      region: "test",
      expiresAt: "later",
      maxDurationMs: 600_000,
    })),
    abortSession,
  }
  const committed = vi.fn()
  const rendered = renderHook(() =>
    useVoiceDictation({ workspaceId: "ws_1", onCommittedText: committed, dependencies, ...callbacks })
  )
  return { ...rendered, sockets, committed, abortSession, dependencies }
}

describe("useVoiceDictation lifecycle", () => {
  it("accepts a lower revision in a second real hook session", async () => {
    const harness = hookHarness([
      { ok: true, protocolVersion: 2 },
      { ok: true, protocolVersion: 2 },
    ])
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 5,
        text: "first",
        isFinal: true,
      } satisfies VoiceTranscriptDelta)
    )
    act(() => harness.result.current.stop())
    act(() => harness.sockets[0].stopCallbacks[0]())
    await waitFor(() => expect(harness.result.current.state).toBe("idle"))

    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[1].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_2",
        revision: 1,
        text: "second",
        isFinal: true,
      } satisfies VoiceTranscriptDelta)
    )

    expect(harness.committed.mock.calls.map(([text]) => text)).toEqual(["first", "second"])
  })

  it("resets v2 capability before a legacy session and disconnects legacy send-as-is immediately", async () => {
    const harness = hookHarness([
      { ok: true, protocolVersion: 2 },
      { ok: true, protocolVersion: 1 },
    ])
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => harness.result.current.prepareSendAsIs())
    expect(harness.sockets[0].disconnected).toBe(false)
    act(() => harness.sockets[0].stopCallbacks[0]())

    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => harness.result.current.prepareSendAsIs())

    expect(harness.sockets[1].stopPayloads).toEqual([])
    expect(harness.sockets[1].disconnected).toBe(true)
  })

  it("retains a v2 send-as-is socket through ACK and timeout", async () => {
    vi.useFakeTimers()
    const harness = hookHarness([
      { ok: true, protocolVersion: 2 },
      { ok: true, protocolVersion: 2 },
    ])
    act(() => harness.result.current.start())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => harness.result.current.prepareSendAsIs())
    expect(harness.sockets[0].disconnected).toBe(false)
    act(() => harness.sockets[0].stopCallbacks[0]())
    expect(harness.sockets[0].disconnected).toBe(true)

    act(() => harness.result.current.start())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => harness.result.current.prepareSendAsIs())
    expect(harness.sockets[1].disconnected).toBe(false)
    act(() => vi.advanceTimersByTime(3_000))
    expect(harness.sockets[1].disconnected).toBe(true)
    vi.useRealTimers()
  })

  it("gives deliberate formatting the full backend processing budget", async () => {
    vi.useFakeTimers()
    const harness = hookHarness([{ ok: true, protocolVersion: 2 }])
    act(() => harness.result.current.start())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => harness.result.current.stop())
    act(() => vi.advanceTimersByTime(7_000))
    expect(harness.sockets[0].disconnected).toBe(false)
    act(() => vi.advanceTimersByTime(5_000))
    expect(harness.sockets[0].disconnected).toBe(true)
    vi.useRealTimers()
  })

  it("ignores detached send-as-is socket lifecycle callbacks during a new take", async () => {
    const harness = hookHarness([
      { ok: true, protocolVersion: 2 },
      { ok: true, protocolVersion: 2 },
    ])
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => harness.result.current.prepareSendAsIs())
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))

    act(() => {
      harness.sockets[0].fire("voice:stopped", { reason: "stopped", revision: 0, outcome: "success" })
      harness.sockets[0].fire("disconnect", undefined)
    })

    expect(harness.result.current.state).toBe("recording")
    expect(harness.result.current.error).toBeNull()
  })

  it("aborts over HTTP after session creation but before socket setup", async () => {
    let releaseMic!: () => void
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            releaseMic = () => resolve(stream)
          }),
      },
    })
    const harness = hookHarness([{ ok: true, protocolVersion: 2 }])
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.dependencies.createSession).toHaveBeenCalledTimes(1))
    act(() => harness.result.current.abort())

    expect(harness.abortSession).toHaveBeenCalledWith("ws_1", "voicesess_1")
    releaseMic()
  })

  it("stops a microphone stream that resolves after abort", async () => {
    let releaseMic!: () => void
    const stopTrack = vi.fn()
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            releaseMic = () =>
              resolve({ getAudioTracks: () => [], getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream)
          }),
      },
    })
    const harness = hookHarness([{ ok: true, protocolVersion: 2 }])
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.dependencies.createSession).toHaveBeenCalledTimes(1))
    act(() => harness.result.current.abort())
    await act(async () => releaseMic())

    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(harness.sockets).toHaveLength(0)
  })

  it("canonically inserts send-as-is interim recovery synchronously before the composer snapshot", async () => {
    const order: string[] = []
    const inserted = vi.fn(({ contentJson }: { contentJson: JSONContent }) => {
      order.push("insert")
      expect(contentJson).toEqual({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "recovered" }] }],
      })
    })
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "**recovered**",
        isFinal: false,
      })
    )
    act(() => {
      harness.result.current.prepareSendAsIs()
      order.push("snapshot")
    })

    expect(order).toEqual(["insert", "snapshot"])
    expect(inserted).toHaveBeenCalledTimes(1)
    expect(harness.committed).not.toHaveBeenCalled()
  })

  it("normalizes v2 Markdown and preserves exact v3 raw and polished JSON payloads", async () => {
    let current: JSONContent | null = null
    const inserted = vi.fn(({ contentJson }: { contentJson: JSONContent }) => {
      current = contentJson
    })
    const swapped = vi.fn(({ contentJson }: { contentJson: JSONContent }) => {
      current = contentJson
      return true
    })
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], {
      onPolishedChunkInserted: inserted,
      onGetChunkContent: () => current,
      onChunkSwap: swapped,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "**legacy final**",
        isFinal: true,
        chunkId: "chunk_1",
      })
    })
    expect(current).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "legacy final" }] }],
    })

    const rawContentJson: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "italic" }], text: "raw exact" }] }],
    }
    const polishedContentJson: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "code" }], text: "polished exact" }] }],
    }
    act(() => {
      harness.sockets[0].fire("voice:transcript:polished", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        chunkId: "chunk_1",
        authoritative: true,
        raw: "ignored raw wire text",
        polished: "ignored polished wire text",
        rawContentJson,
        polishedContentJson,
      })
    })
    expect(swapped).toHaveBeenLastCalledWith({ chunkId: "chunk_1", contentJson: polishedContentJson })
    act(() => harness.result.current.setShowOriginal(true))
    expect(swapped).toHaveBeenLastCalledWith({ chunkId: "chunk_1", contentJson: rawContentJson })
  })

  it("locks stale polished comparison state when authoritative formatting fails or the take aborts", async () => {
    let chunkContent: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "raw tail" }] }],
    }
    const lockAll = vi.fn()
    const harness = hookHarness([{ ok: true, protocolVersion: 2 }], {
      onPolishedChunkInserted: ({ contentJson }) => {
        chunkContent = contentJson
      },
      onGetChunkContent: () => chunkContent,
      onChunkSwap: ({ contentJson }) => {
        chunkContent = contentJson
        return true
      },
      onLockAllChunks: lockAll,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    lockAll.mockClear()
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "raw tail",
        isFinal: true,
        chunkId: "chunk_1",
      })
      harness.sockets[0].fire("voice:transcript:polished", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        chunkId: "chunk_1",
        raw: "raw tail",
        polished: "polished",
      })
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 2,
        text: "new tail",
        isFinal: true,
        chunkId: "chunk_1",
      })
      harness.sockets[0].fire("voice:stopped", { reason: "stopped", revision: 2, outcome: "provider_error" })
    })

    expect(harness.result.current.hasUnlockedChunks).toBe(false)
    expect(lockAll).toHaveBeenCalledTimes(1)
    act(() => harness.result.current.abort())
    expect(lockAll).toHaveBeenCalledTimes(2)
  })
})

describe("resetVoiceTakeProtocol", () => {
  it("accepts low revisions and legacy capability again in a second session", () => {
    const acceptedRevision = { current: 5 }
    const protocolVersion = { current: 2 }

    resetVoiceTakeProtocol({ acceptedRevision, protocolVersion })

    expect({ acceptedRevision: acceptedRevision.current, protocolVersion: protocolVersion.current }).toEqual({
      acceptedRevision: 0,
      protocolVersion: 1,
    })
  })
})

describe("friendlyTranscriptionError", () => {
  it("phrases known upstream codes as short human copy", () => {
    expect(friendlyTranscriptionError("UPSTREAM_CLOSED")).toBe("Dictation stopped unexpectedly")
    expect(friendlyTranscriptionError("INPUT_ERROR")).toBe("Couldn't make out the audio")
  })

  it("never echoes a raw provider string — unknown/leaky codes fall back to generic copy", () => {
    expect(friendlyTranscriptionError(undefined)).toBe("Dictation hit a problem")
    // Even if a raw provider message arrives in `code`, we don't surface it.
    expect(friendlyTranscriptionError("ElevenLabs realtime closed (code 1000)")).toBe("Dictation hit a problem")
  })
})

describe("shouldWarnNoAudio — initial silence branch (peak still below floor)", () => {
  it("waits out the grace window — a take just starting is never silent enough to flag", () => {
    expect(shouldWarnNoAudio({ elapsedMs: 0, silenceMs: 0, peakLevel: 0 })).toBe(false)
    expect(
      shouldWarnNoAudio({
        elapsedMs: NO_AUDIO_INITIAL_WAIT_MS - 1,
        silenceMs: NO_AUDIO_INITIAL_WAIT_MS - 1,
        peakLevel: 0,
      })
    ).toBe(false)
  })

  it("flags inputs that produced literal zero past the grace window", () => {
    expect(
      shouldWarnNoAudio({ elapsedMs: NO_AUDIO_INITIAL_WAIT_MS, silenceMs: NO_AUDIO_INITIAL_WAIT_MS, peakLevel: 0 })
    ).toBe(true)
    expect(shouldWarnNoAudio({ elapsedMs: 10_000, silenceMs: 10_000, peakLevel: 0 })).toBe(true)
  })
})

describe("shouldWarnNoAudio — lost-signal branch (peak above floor, was working)", () => {
  it("does not flag short pauses — a user pausing mid-sentence shouldn't get nagged", () => {
    expect(shouldWarnNoAudio({ elapsedMs: 8_000, silenceMs: 1_000, peakLevel: 0.3 })).toBe(false)
    expect(shouldWarnNoAudio({ elapsedMs: 8_000, silenceMs: NO_AUDIO_SILENCE_WAIT_MS - 1, peakLevel: 0.3 })).toBe(false)
  })

  it("flags inputs that produced audio briefly and then went dead — the actual headphone-dropout case", () => {
    // The reported bug: a single "yes" came through (peak crossed threshold),
    // then headphones dropped HFP and the analyser went back to zeros. The
    // initial-silence check above already passed, so we need the silence-since-last-signal
    // check to catch the drop.
    expect(shouldWarnNoAudio({ elapsedMs: 10_000, silenceMs: NO_AUDIO_SILENCE_WAIT_MS, peakLevel: 0.4 })).toBe(true)
    expect(shouldWarnNoAudio({ elapsedMs: 12_000, silenceMs: 7_000, peakLevel: 0.4 })).toBe(true)
  })

  it("uses the silence window even early in the take — peak above floor switches to the lost-signal threshold immediately", () => {
    // elapsed is small, but peak is high → we're in the lost-signal branch.
    // Silence below 5s doesn't fire; at or above does.
    expect(shouldWarnNoAudio({ elapsedMs: 3_000, silenceMs: 2_500, peakLevel: 0.4 })).toBe(false)
    expect(shouldWarnNoAudio({ elapsedMs: 6_500, silenceMs: NO_AUDIO_SILENCE_WAIT_MS, peakLevel: 0.4 })).toBe(true)
  })
})

describe("noAudioWarningMessage", () => {
  it("names the offending device when the browser revealed its label", () => {
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: false })).toContain("AirPods Pro")
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: true })).toContain("AirPods Pro")
  })

  it("falls back to a generic phrase when the label is null or whitespace — labels are gated on permission and may be empty", () => {
    expect(noAudioWarningMessage({ deviceLabel: null, everHadSignal: false })).toContain("your microphone")
    expect(noAudioWarningMessage({ deviceLabel: "", everHadSignal: false })).toContain("your microphone")
    expect(noAudioWarningMessage({ deviceLabel: "   ", everHadSignal: false })).toContain("your microphone")
  })

  it("uses different phrasing for never-had-signal vs lost-signal — the remedy is different", () => {
    // Initial silence → try a different input device (the current one is dead).
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: false })).toMatch(/not hearing/i)
    // Lost signal → check the current input or switch (it WAS working).
    expect(noAudioWarningMessage({ deviceLabel: "AirPods Pro", everHadSignal: true })).toMatch(/dropped/i)
  })
})
