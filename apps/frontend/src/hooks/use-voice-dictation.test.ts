import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, it, expect, vi } from "vitest"
import type { JSONContent, VoiceStartAck, VoiceTranscriptDelta } from "@threahq/types"
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
  handlers = new Map<string, (...args: unknown[]) => void>()
  startPayloads: unknown[] = []
  stopCallbacks: Array<() => void> = []
  stopPayloads: unknown[] = []
  disconnected = false
  private timeoutMs: number | null = null
  constructor(private readonly ack: VoiceStartAck) {}
  on(event: string, callback: (...args: unknown[]) => void) {
    this.handlers.set(event, callback)
    return this
  }
  emit(event: string, ...args: unknown[]) {
    if (event === "voice:start") {
      this.startPayloads.push(args[0])
      ;(args[1] as (ack: VoiceStartAck) => void)(this.ack)
    }
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
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args)
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

const paragraph = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})

function contentText(contentJson: JSONContent): string {
  return `${contentJson.text ?? ""}${(contentJson.content ?? []).map(contentText).join("")}`
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

  it.each([
    ["transport disconnect", "disconnect", undefined],
    ["upstream error", "voice:transcription:error", { code: "UPSTREAM_CLOSED" }],
  ])("commits the exact visible interim once before teardown on %s", async (_label, event, payload) => {
    const inserted = vi.fn(() => true)
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "the last visible words",
        isFinal: false,
      })
    )

    act(() => {
      harness.sockets[0].fire(event, payload)
      // A provider error can be followed by both terminal and disconnect
      // notifications. Detached callbacks must not recover the same text twice.
      harness.sockets[0].fire("voice:stopped", { reason: "stopped", revision: 1, outcome: "provider_error" })
      harness.sockets[0].fire("disconnect", undefined)
    })

    expect(inserted).toHaveBeenCalledOnce()
    expect(inserted).toHaveBeenCalledWith({
      chunkId: "local_recovery_1",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "the last visible words" }] }],
      },
    })
    expect(harness.result.current.interimText).toBe("")
    expect(harness.result.current.state).toBe("error")
  })

  it("flushes visible interim before a terminal provider outcome locks tracking", async () => {
    const order: string[] = []
    const inserted = vi.fn(() => {
      order.push("insert")
      return true
    })
    const lockAll = vi.fn(() => order.push("lock"))
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], {
      onPolishedChunkInserted: inserted,
      onLockAllChunks: lockAll,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    lockAll.mockClear()
    order.length = 0
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "keep this tail",
        isFinal: false,
      })
      harness.sockets[0].fire("voice:stopped", {
        reason: "stopped",
        revision: 1,
        outcome: "provider_error",
      })
    })

    expect(order).toEqual(["insert", "lock"])
    expect(inserted).toHaveBeenCalledOnce()
    expect(inserted).toHaveBeenCalledWith({
      chunkId: "local_recovery_1",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "keep this tail" }] }],
      },
    })
    expect(harness.result.current.interimText).toBe("")
    expect(harness.result.current.state).toBe("idle")
  })

  it("preserves visible interim as-is when the page is backgrounded", async () => {
    const inserted = vi.fn(() => true)
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "survive the network switch",
        isFinal: false,
      })
    )

    const previous = Object.getOwnPropertyDescriptor(document, "visibilityState")
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" })
    try {
      act(() => document.dispatchEvent(new Event("visibilitychange")))
    } finally {
      if (previous) Object.defineProperty(document, "visibilityState", previous)
      else delete (document as unknown as { visibilityState?: string }).visibilityState
    }

    expect(inserted).toHaveBeenCalledOnce()
    expect(inserted).toHaveBeenCalledWith({
      chunkId: "local_recovery_1",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "survive the network switch" }] }],
      },
    })
    expect(harness.sockets[0].stopPayloads).toEqual([{ mode: "send_as_is" }])
    expect(harness.result.current.state).toBe("idle")
  })

  it("commits visible interim when scope navigation unmounts the active take", async () => {
    const inserted = vi.fn(() => true)
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "keep this across navigation",
        isFinal: false,
      })
    )

    harness.unmount()

    expect(inserted).toHaveBeenCalledOnce()
    expect(inserted).toHaveBeenCalledWith({
      chunkId: "local_recovery_1",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "keep this across navigation" }] }],
      },
    })
  })

  it("keeps explicit abort as the only terminal path that discards interim", async () => {
    const inserted = vi.fn()
    const harness = hookHarness([{ ok: true, protocolVersion: 3 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "discard intentionally",
        isFinal: false,
      })
      harness.result.current.abort()
    })

    expect(inserted).not.toHaveBeenCalled()
    expect(harness.committed).not.toHaveBeenCalled()
    expect(harness.sockets[0].stopPayloads).toEqual([{ mode: "abort" }])
  })

  it("commits only the v4 recovery chunk immediately and locks accepted chunks after terminal grace", async () => {
    const inserted = vi.fn(() => true)
    const lockChunk = vi.fn()
    const lockAll = vi.fn()
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], {
      onPolishedChunkInserted: inserted,
      onChunksReplace: () => "applied",
      onLockChunk: lockChunk,
      onLockAllChunks: lockAll,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    vi.useFakeTimers()
    try {
      act(() => {
        harness.sockets[0].fire("voice:transcript:delta", {
          protocolVersion: 4,
          voiceSessionId: "voicesess_1",
          revision: 1,
          text: "accepted raw",
          isFinal: true,
          chunkId: "accepted",
          contentJson: paragraph("accepted raw"),
        })
        harness.sockets[0].fire("voice:transcript:polished", {
          protocolVersion: 4,
          operationId: "accepted-operation",
          voiceSessionId: "voicesess_1",
          authoritative: false,
          resultChunkId: "accepted",
          throughRevision: 1,
          sources: [{ chunkId: "accepted", throughRevision: 1 }],
          raw: "accepted raw",
          polished: "Accepted polished.",
          rawContentJson: paragraph("accepted raw"),
          polishedContentJson: paragraph("Accepted polished."),
        })
        harness.sockets[0].fire("voice:transcript:delta", {
          protocolVersion: 4,
          voiceSessionId: "voicesess_1",
          revision: 1,
          text: "visible v4 tail",
          isFinal: false,
        })
        harness.sockets[0].fire("disconnect", undefined)
        harness.sockets[0].fire("disconnect", undefined)
      })

      expect(inserted).toHaveBeenCalledTimes(2)
      expect(inserted).toHaveBeenLastCalledWith({
        chunkId: "local_recovery_1",
        contentJson: paragraph("visible v4 tail"),
      })
      expect(lockChunk).toHaveBeenCalledWith({ chunkId: "local_recovery_1" })
      expect(lockAll).toHaveBeenCalledOnce()
      expect(harness.result.current.chunks.size).toBe(1)
      expect(harness.result.current.error).toBe("Dictation connection lost")

      act(() => vi.advanceTimersByTime(8_001))
      expect(lockAll).toHaveBeenCalledTimes(2)
      expect(harness.result.current.chunks.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("canonically inserts send-as-is interim recovery synchronously before the composer snapshot", async () => {
    const order: string[] = []
    const inserted = vi.fn(({ contentJson }: { contentJson: JSONContent }) => {
      order.push("insert")
      expect(contentJson).toEqual({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", marks: [{ type: "bold" }], text: "recovered" }] }],
      })
      return true
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

  it("preserves failed tracked final and interim insertions once and ACKs unavailable v4 sources missing", async () => {
    const inserted = vi.fn(() => false)
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    const contentJson: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "final" }] }],
    }
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "final",
        isFinal: true,
        chunkId: "a",
        contentJson,
      })
    )
    const acknowledgements: unknown[] = []
    act(() =>
      harness.sockets[0].fire(
        "voice:transcript:polished",
        {
          protocolVersion: 4,
          operationId: "missing-operation",
          voiceSessionId: "voicesess_1",
          authoritative: true,
          resultChunkId: "a",
          throughRevision: 1,
          sources: [{ chunkId: "a", throughRevision: 1 }],
          raw: "final",
          polished: "Final.",
          rawContentJson: contentJson,
          polishedContentJson: contentJson,
        },
        (ack: unknown) => acknowledgements.push(ack)
      )
    )
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 2,
        text: "interim",
        isFinal: false,
        chunkId: "b",
        contentJson,
      })
    )
    act(() => harness.result.current.prepareSendAsIs())

    expect(harness.committed.mock.calls.map(([text]) => text)).toEqual(["final", "interim"])
    expect(acknowledgements).toEqual([{ operationId: "missing-operation", status: "missing" }])
  })

  it("preserves hard-join semantics when a tracked continuation falls back to committed text", async () => {
    const inserted = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], { onPolishedChunkInserted: inserted })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "hel",
        isFinal: true,
        chunkId: "a",
        contentJson: paragraph("hel"),
      })
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 2,
        text: "lo",
        isFinal: true,
        chunkId: "b",
        afterChunkId: "a",
        joinPrevious: true,
        contentJson: paragraph("lo"),
      })
    })
    const acknowledgements: unknown[] = []
    act(() =>
      harness.sockets[0].fire(
        "voice:transcript:polished",
        {
          protocolVersion: 4,
          operationId: "missing-hard-split",
          voiceSessionId: "voicesess_1",
          authoritative: true,
          resultChunkId: "b",
          throughRevision: 2,
          sources: [{ chunkId: "b", throughRevision: 2 }],
          raw: "lo",
          polished: "lo",
          rawContentJson: paragraph("lo"),
          polishedContentJson: paragraph("lo"),
        },
        (ack: unknown) => acknowledgements.push(ack)
      )
    )

    expect(harness.committed.mock.calls).toEqual([["lo", { joinPrevious: true }]])
    expect(acknowledgements).toEqual([{ operationId: "missing-hard-split", status: "missing" }])
  })

  it("ACKs a changed source revision stale without invoking the editor", async () => {
    const replaced = vi.fn(() => "applied" as const)
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], {
      onPolishedChunkInserted: () => true,
      onChunksReplace: replaced,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => {
      for (const [revision, text] of [
        [1, "first"],
        [2, "newer"],
      ] as const)
        harness.sockets[0].fire("voice:transcript:delta", {
          protocolVersion: 4,
          voiceSessionId: "voicesess_1",
          revision,
          text,
          isFinal: true,
          chunkId: "a",
          contentJson: paragraph(text),
        })
    })
    const acknowledgements: unknown[] = []
    act(() =>
      harness.sockets[0].fire(
        "voice:transcript:polished",
        {
          protocolVersion: 4,
          operationId: "stale-operation",
          voiceSessionId: "voicesess_1",
          authoritative: false,
          resultChunkId: "a",
          throughRevision: 1,
          sources: [{ chunkId: "a", throughRevision: 1 }],
          raw: "first",
          polished: "First.",
          rawContentJson: paragraph("first"),
          polishedContentJson: paragraph("First."),
        },
        (ack: unknown) => acknowledgements.push(ack)
      )
    )

    expect({ acknowledgements, editorCalls: replaced.mock.calls }).toEqual({
      acknowledgements: [{ operationId: "stale-operation", status: "stale" }],
      editorCalls: [],
    })
  })

  it("reconciles only an edited source after a locked ACK and keeps independent chunks toggleable", async () => {
    const replaced = vi.fn(({ resultChunkId }: { resultChunkId: string }) =>
      resultChunkId === "ab" ? ("locked" as const) : ("applied" as const)
    )
    const swapped = vi.fn((_args: { chunkId: string; contentJson: JSONContent }) => true)
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], {
      onPolishedChunkInserted: () => true,
      onChunksReplace: replaced,
      onGetChunkContent: (chunkId) => (chunkId === "a" ? null : paragraph(`editor ${chunkId}`)),
      onChunkSwap: swapped,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() => {
      for (const [index, chunkId] of ["a", "b", "c"].entries())
        harness.sockets[0].fire("voice:transcript:delta", {
          protocolVersion: 4,
          voiceSessionId: "voicesess_1",
          revision: index + 1,
          text: chunkId,
          isFinal: true,
          chunkId,
          ...(index ? { afterChunkId: ["a", "b"][index - 1] } : {}),
          contentJson: paragraph(chunkId),
        })
    })
    const acknowledgements: unknown[] = []
    const apply = (
      operationId: string,
      resultChunkId: string,
      sources: Array<{ chunkId: string; throughRevision: number }>
    ) =>
      harness.sockets[0].fire(
        "voice:transcript:polished",
        {
          protocolVersion: 4,
          operationId,
          voiceSessionId: "voicesess_1",
          authoritative: false,
          resultChunkId,
          throughRevision: Math.max(...sources.map((source) => source.throughRevision)),
          sources,
          raw: sources.map((source) => source.chunkId).join(" "),
          polished: sources.map((source) => source.chunkId.toUpperCase()).join(" "),
          rawContentJson: paragraph(sources.map((source) => source.chunkId).join(" ")),
          polishedContentJson: paragraph(sources.map((source) => source.chunkId.toUpperCase()).join(" ")),
        },
        (ack: unknown) => acknowledgements.push(ack)
      )
    act(() => {
      apply("accept-a", "a", [{ chunkId: "a", throughRevision: 1 }])
      apply("accept-b", "b", [{ chunkId: "b", throughRevision: 2 }])
      apply("accept-c", "c", [{ chunkId: "c", throughRevision: 3 }])
      apply("lock-ab", "ab", [
        { chunkId: "a", throughRevision: 1 },
        { chunkId: "b", throughRevision: 2 },
      ])
    })

    expect(acknowledgements).toEqual([
      { operationId: "accept-a", status: "applied" },
      { operationId: "accept-b", status: "applied" },
      { operationId: "accept-c", status: "applied" },
      { operationId: "lock-ab", status: "locked" },
    ])
    expect([...harness.result.current.chunks].map(([chunkId, record]) => ({ chunkId, locked: record.locked }))).toEqual(
      [
        { chunkId: "a", locked: true },
        { chunkId: "b", locked: false },
        { chunkId: "c", locked: false },
      ]
    )
    act(() => harness.result.current.setShowOriginal(true))
    expect(swapped.mock.calls.map(([args]) => args.chunkId)).toEqual(["b", "c"])
  })

  it("appends alias-chain deltas once and keeps canonical raw and polished whitespace in sync", async () => {
    const inserted = vi.fn((_args: { chunkId: string; afterChunkId?: string; contentJson: JSONContent }) => true)
    const swapped = vi.fn((_args: { chunkId: string; contentJson: JSONContent }) => true)
    const replaced = vi.fn(() => "applied" as const)
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], {
      onPolishedChunkInserted: inserted,
      onChunksReplace: replaced,
      onChunkSwap: swapped,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    act(() =>
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "base",
        isFinal: true,
        chunkId: "a",
        contentJson: paragraph("base"),
      })
    )
    const deliverOperation = (args: {
      operationId: string
      sourceId: string
      throughRevision: number
      resultChunkId: string
      raw: string
      polished: string
      rawContentJson: JSONContent
      polishedContentJson: JSONContent
    }) => {
      const { sourceId, ...operation } = args
      harness.sockets[0].fire("voice:transcript:polished", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        authoritative: false,
        sources: [{ chunkId: sourceId, throughRevision: operation.throughRevision }],
        ...operation,
      })
    }
    act(() =>
      deliverOperation({
        operationId: "a-to-r",
        sourceId: "a",
        throughRevision: 1,
        resultChunkId: "r",
        raw: "base ",
        polished: "Polished ",
        rawContentJson: paragraph("base "),
        polishedContentJson: paragraph("Polished "),
      })
    )
    const tailDelta = {
      protocolVersion: 4,
      voiceSessionId: "voicesess_1",
      revision: 2,
      text: "tail",
      isFinal: true,
      chunkId: "a",
      contentJson: paragraph("tail"),
    } as const
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", tailDelta)
      harness.sockets[0].fire("voice:transcript:delta", tailDelta)
    })
    const firstRecord = harness.result.current.chunks.get("r")!
    expect({
      raw: firstRecord.raw,
      rawJson: contentText(firstRecord.rawContentJson!),
      polished: firstRecord.polished,
      polishedJson: contentText(firstRecord.polishedContentJson!),
    }).toEqual({ raw: "base tail", rawJson: "base tail", polished: "Polished tail", polishedJson: "Polished tail" })

    act(() =>
      deliverOperation({
        operationId: "r-to-s",
        sourceId: "r",
        throughRevision: 2,
        resultChunkId: "s",
        raw: "base tail",
        polished: "Polished tail",
        rawContentJson: paragraph("base tail"),
        polishedContentJson: paragraph("Polished tail"),
      })
    )
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        ...tailDelta,
        revision: 3,
        text: "again",
        contentJson: paragraph("again"),
      })
      harness.sockets[0].fire("voice:transcript:delta", {
        ...tailDelta,
        revision: 4,
        text: "next",
        chunkId: "b",
        afterChunkId: "a",
        contentJson: paragraph("next"),
      })
    })

    const finalRecord = harness.result.current.chunks.get("s")!
    expect({
      raw: finalRecord.raw,
      rawJson: contentText(finalRecord.rawContentJson!),
      polished: finalRecord.polished,
      polishedJson: contentText(finalRecord.polishedContentJson!),
      insertions: inserted.mock.calls.map(([args]) => ({ chunkId: args.chunkId, afterChunkId: args.afterChunkId })),
    }).toEqual({
      raw: "base tail again",
      rawJson: "base tail again",
      polished: "Polished tail again",
      polishedJson: "Polished tail again",
      insertions: [
        { chunkId: "a", afterChunkId: undefined },
        { chunkId: "r", afterChunkId: undefined },
        { chunkId: "s", afterChunkId: undefined },
        { chunkId: "b", afterChunkId: "s" },
      ],
    })
    act(() => harness.result.current.setShowOriginal(true))
    expect(contentText(swapped.mock.calls.at(-1)![0].contentJson)).toBe("base tail again")
    act(() => harness.result.current.setShowOriginal(false))
    expect(contentText(swapped.mock.calls.at(-1)![0].contentJson)).toBe("Polished tail again")
  })

  it("negotiates v4, applies sealed per-source operations, and ACKs duplicate delivery exactly once", async () => {
    const inserted = vi.fn((_args: { chunkId: string }) => true)
    const replaced = vi.fn(() => "applied" as const)
    const acknowledgements: unknown[] = []
    const harness = hookHarness([{ ok: true, protocolVersion: 4 }], {
      onPolishedChunkInserted: inserted,
      onChunksReplace: replaced,
    })
    act(() => harness.result.current.start())
    await waitFor(() => expect(harness.result.current.state).toBe("recording"))
    expect(harness.sockets[0].startPayloads[0]).toMatchObject({ maxProtocolVersion: 4 })
    const contentJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "raw" }] }] }
    act(() => {
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 1,
        text: "raw",
        isFinal: true,
        chunkId: "a",
        contentJson,
      })
      harness.sockets[0].fire("voice:transcript:delta", {
        protocolVersion: 4,
        voiceSessionId: "voicesess_1",
        revision: 2,
        text: "newer other chunk",
        isFinal: true,
        chunkId: "b",
        afterChunkId: "a",
        contentJson,
      })
    })
    const operation = {
      protocolVersion: 4,
      operationId: "operation_1",
      voiceSessionId: "voicesess_1",
      authoritative: true,
      resultChunkId: "a",
      throughRevision: 1,
      sources: [{ chunkId: "a", throughRevision: 1 }],
      raw: "raw",
      polished: "polished",
      rawContentJson: contentJson,
      polishedContentJson: contentJson,
    } as const
    act(() => {
      harness.sockets[0].fire("voice:transcript:polished", operation, (ack: unknown) => acknowledgements.push(ack))
      harness.sockets[0].fire("voice:transcript:polished", operation, (ack: unknown) => acknowledgements.push(ack))
    })

    expect(inserted.mock.calls.map(([args]) => args.chunkId)).toEqual(["a", "b"])
    expect(replaced).toHaveBeenCalledTimes(1)
    expect(acknowledgements).toEqual([
      { operationId: "operation_1", status: "applied" },
      { operationId: "operation_1", status: "applied" },
    ])
  })

  it("normalizes v2 Markdown and preserves exact v3 raw and polished JSON payloads", async () => {
    let current: JSONContent | null = null
    const inserted = vi.fn(({ contentJson }: { contentJson: JSONContent }) => {
      current = contentJson
      return true
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
        return true
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
