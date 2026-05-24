import { describe, expect, it, mock } from "bun:test"
import type { Server } from "socket.io"
import { registerVoiceGateway } from "./realtime-gateway"
import type { TranscriptionSession } from "./transcription/strategy"

type DeltaCb = (delta: { text: string; isFinal: boolean }) => void
type ErrorCb = (e: { code: string; message: string }) => void

interface FakeUpstream extends TranscriptionSession {
  fireDelta: DeltaCb
  fireError: ErrorCb
}

function fakeUpstream(): FakeUpstream {
  let deltaCb: DeltaCb = () => {}
  let errorCb: ErrorCb = () => {}
  return {
    pushAudio: mock(() => {}),
    flush: mock(async () => {}),
    onDelta: (cb) => {
      deltaCb = cb
    },
    onError: (cb) => {
      errorCb = cb
    },
    close: mock(async () => ({ totalAudioMs: 0 })),
    get fireDelta() {
      return deltaCb
    },
    get fireError() {
      return errorCb
    },
  }
}

function fakeSocket(workosUserId = "workos_1") {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const emitted: Array<{ event: string; payload?: unknown }> = []
  let disconnected = false
  return {
    data: { workosUserId },
    on(event: string, cb: (...args: unknown[]) => unknown) {
      handlers.set(event, cb)
    },
    emit(event: string, payload?: unknown) {
      emitted.push({ event, payload })
    },
    disconnect() {
      disconnected = true
    },
    emitted,
    get disconnected() {
      return disconnected
    },
    trigger(event: string, ...args: unknown[]) {
      return handlers.get(event)?.(...args)
    },
  }
}

function setup(overrides?: {
  open?: () => Promise<TranscriptionSession>
  getRelaySession?: (...args: unknown[]) => Promise<unknown>
  voicePolishLevel?: "none" | "minor" | "opinionated"
  polishTranscript?: (args: { rawTranscript: string; level: string }) => Promise<string>
}) {
  const upstream = fakeUpstream()
  const transcription = { open: mock(overrides?.open ?? (async () => upstream)) }
  const voiceTranscriptionService = {
    getRelaySession: mock(
      overrides?.getRelaySession ??
        (async () => ({ userId: "user_1", model: "elevenlabs:scribe-v2-realtime", language: null }))
    ),
    finishSession: mock(async () => {}),
    abortSession: mock(async () => {}),
  }
  const userPreferencesService = {
    getPreferences: mock(async () => ({ voicePolishLevel: overrides?.voicePolishLevel ?? "none" })),
  }
  const polishTranscript = mock(
    overrides?.polishTranscript ?? (async ({ rawTranscript }: { rawTranscript: string }) => `P(${rawTranscript})`)
  )

  let connectionHandler: ((socket: unknown) => void) | undefined
  const namespace = {
    use: mock(() => {}),
    on: (event: string, cb: (socket: unknown) => void) => {
      if (event === "connection") connectionHandler = cb
    },
  }
  const io = { of: mock(() => namespace) } as unknown as Server

  registerVoiceGateway(io, {
    authService: {} as never,
    voiceTranscriptionService: voiceTranscriptionService as never,
    transcription: transcription as never,
    userPreferencesService: userPreferencesService as never,
    polishTranscript: polishTranscript as never,
  })

  const socket = fakeSocket()
  connectionHandler!(socket)

  return { socket, upstream, transcription, voiceTranscriptionService, userPreferencesService, polishTranscript }
}

const START_PAYLOAD = { workspaceId: "ws_1", voiceSessionId: "voicesess_1" }

describe("registerVoiceGateway voice:start", () => {
  it("opens the upstream and relays deltas as voice:transcript:delta tagged with the session id", async () => {
    const { socket, upstream, transcription } = setup()
    const cb = mock(() => {})

    await socket.trigger("voice:start", START_PAYLOAD, cb)

    expect(cb).toHaveBeenCalledWith({ ok: true })
    expect(transcription.open).toHaveBeenCalledWith({ model: "elevenlabs:scribe-v2-realtime", language: undefined })

    upstream.fireDelta({ text: "hi", isFinal: true })
    upstream.fireError({ code: "INPUT_ERROR", message: "bad audio" })
    // The error emit now awaits the polish drain (microtask) before propagating,
    // even when polish is off, so wait one tick before asserting.
    await new Promise((r) => setTimeout(r, 0))

    expect(socket.emitted).toContainEqual({
      event: "voice:transcript:delta",
      payload: { voiceSessionId: "voicesess_1", text: "hi", isFinal: true },
    })
    expect(socket.emitted).toContainEqual({
      event: "voice:transcription:error",
      payload: { voiceSessionId: "voicesess_1", code: "INPUT_ERROR", message: "bad audio" },
    })
  })

  it("refuses a start that is missing identifiers", async () => {
    const { socket, transcription } = setup()
    const cb = mock(() => {})

    await socket.trigger("voice:start", {}, cb)

    expect(cb).toHaveBeenCalledWith({ ok: false, error: "workspaceId and voiceSessionId required" })
    expect(transcription.open).not.toHaveBeenCalled()
  })

  it("refuses a second start while a session is already active", async () => {
    const { socket } = setup()
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    const cb = mock(() => {})
    await socket.trigger("voice:start", START_PAYLOAD, cb)

    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Session already started" })
  })

  it("tears down the upstream when the socket disconnects mid-start", async () => {
    let resolveOpen!: (s: TranscriptionSession) => void
    const upstream = fakeUpstream()
    const openPromise = new Promise<TranscriptionSession>((r) => {
      resolveOpen = r
    })
    const { socket, voiceTranscriptionService } = setup({ open: () => openPromise })
    const cb = mock(() => {})

    const startP = socket.trigger("voice:start", START_PAYLOAD, cb)
    // Disconnect arrives before the upstream finishes opening.
    socket.trigger("disconnect")
    resolveOpen(upstream)
    await startP

    expect(upstream.close).toHaveBeenCalled()
    expect(voiceTranscriptionService.abortSession).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
      totalAudioMs: 0,
    })
    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Session ended before it started" })
  })

  it("aborts the resolved session when opening the upstream fails", async () => {
    const { socket, voiceTranscriptionService } = setup({
      open: async () => {
        throw new Error("upstream unreachable")
      },
    })
    const cb = mock(() => {})

    await socket.trigger("voice:start", START_PAYLOAD, cb)

    expect(voiceTranscriptionService.abortSession).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
      totalAudioMs: 0,
    })
    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Failed to start voice session" })
  })
})

describe("registerVoiceGateway lifecycle", () => {
  it("voice:stop flushes, closes, finishes the session, and emits voice:stopped", async () => {
    const { socket, upstream, voiceTranscriptionService } = setup()
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    const stopCb = mock(() => {})
    await socket.trigger("voice:stop", stopCb)

    expect(upstream.flush).toHaveBeenCalled()
    expect(upstream.close).toHaveBeenCalled()
    expect(voiceTranscriptionService.finishSession).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
      totalAudioMs: 0,
    })
    expect(socket.emitted).toContainEqual({ event: "voice:stopped", payload: { reason: "stopped" } })
    expect(stopCb).toHaveBeenCalledWith({ ok: true })
  })

  it("disconnect aborts the session without flushing", async () => {
    const { socket, upstream, voiceTranscriptionService } = setup()
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    await socket.trigger("disconnect")

    expect(upstream.flush).not.toHaveBeenCalled()
    expect(voiceTranscriptionService.abortSession).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "user_1",
      sessionId: "voicesess_1",
      totalAudioMs: 0,
    })
    expect(voiceTranscriptionService.finishSession).not.toHaveBeenCalled()
  })

  it("pushes decoded audio frames to the upstream", async () => {
    const { socket, upstream } = setup()
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    socket.trigger("voice:audio", new Uint8Array([1, 2, 3, 4]).buffer)

    expect(upstream.pushAudio).toHaveBeenCalledTimes(1)
    expect(Buffer.isBuffer((upstream.pushAudio as ReturnType<typeof mock>).mock.calls[0][0])).toBe(true)
  })
})

describe("registerVoiceGateway polish", () => {
  it("emits a final raw delta tagged with the session chunkId and a polished event for it", async () => {
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hello world", isFinal: true })
    // Polish resolves async; flush queued microtasks.
    await new Promise((r) => setTimeout(r, 0))

    expect(polishTranscript).toHaveBeenCalledTimes(1)
    const finalDelta = socket.emitted.find((e) => e.event === "voice:transcript:delta")
    expect(finalDelta?.payload).toMatchObject({
      voiceSessionId: "voicesess_1",
      text: "hello world",
      isFinal: true,
    })
    const finalChunkId = (finalDelta?.payload as { chunkId?: string }).chunkId
    expect(typeof finalChunkId).toBe("string")
    expect(finalChunkId).toBeTruthy()

    const polishedEvent = socket.emitted.find((e) => e.event === "voice:transcript:polished")
    expect(polishedEvent?.payload).toMatchObject({
      voiceSessionId: "voicesess_1",
      chunkId: finalChunkId,
      raw: "hello world",
      polished: "P(hello world)",
    })
  })

  it("interim deltas always ship as plain transcript:delta with no chunkId, even with polish enabled", async () => {
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hello", isFinal: false })
    await Promise.resolve()

    expect(polishTranscript).not.toHaveBeenCalled()
    const interimDelta = socket.emitted.find((e) => e.event === "voice:transcript:delta")
    expect(interimDelta?.payload).toEqual({ voiceSessionId: "voicesess_1", text: "hello", isFinal: false })
  })

  it("leaves the raw delta in place when polish rejects, with no polished event", async () => {
    const { socket, upstream } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: async () => {
        throw new Error("polish kaboom")
      },
    })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hi there", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))

    const finalDelta = socket.emitted.find((e) => e.event === "voice:transcript:delta")
    expect(finalDelta?.payload).toMatchObject({
      voiceSessionId: "voicesess_1",
      text: "hi there",
      isFinal: true,
    })
    expect(socket.emitted.find((e) => e.event === "voice:transcript:polished")).toBeUndefined()
  })

  it("skips polish for empty final segments and forwards them as plain deltas with no chunkId", async () => {
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "   ", isFinal: true })
    await Promise.resolve()

    expect(polishTranscript).not.toHaveBeenCalled()
    expect(socket.emitted).toContainEqual({
      event: "voice:transcript:delta",
      payload: { voiceSessionId: "voicesess_1", text: "   ", isFinal: true },
    })
  })

  it("forwards the user's polish level to the polish transcript function", async () => {
    const seenLevels: string[] = []
    const { socket, upstream } = setup({
      voicePolishLevel: "minor",
      polishTranscript: async ({ rawTranscript, level }: { rawTranscript: string; level: string }) => {
        seenLevels.push(level)
        return `P(${rawTranscript})`
      },
    })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hello", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(seenLevels).toEqual(["minor"])
  })

  it("drains the in-flight polish before emitting the upstream error so the polished swap reaches the client first", async () => {
    let resolvePolish: (() => void) | null = null
    const { socket, upstream } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: ({ rawTranscript }: { rawTranscript: string }) =>
        new Promise<string>((r) => {
          resolvePolish = () => r(`P(${rawTranscript})`)
        }),
    })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hello world", isFinal: true })
    // Polish is now in flight (hung on the unresolved promise above).
    await Promise.resolve()
    upstream.fireError({ code: "UPSTREAM_CLOSED", message: "10s ElevenLabs disconnect" })

    // The error must not have shipped yet — polish hasn't resolved.
    await Promise.resolve()
    expect(socket.emitted.find((e) => e.event === "voice:transcription:error")).toBeUndefined()

    // Resolve the polish. The drain awaits it, then emits the error.
    resolvePolish!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const errorIdx = socket.emitted.findIndex((e) => e.event === "voice:transcription:error")
    const polishedIdx = socket.emitted.findIndex((e) => e.event === "voice:transcript:polished")
    expect(polishedIdx).toBeGreaterThanOrEqual(0)
    expect(errorIdx).toBeGreaterThan(polishedIdx)
  })

  it("polishes the cumulative raw transcript and reuses the same session chunkId", async () => {
    const seenInputs: string[] = []
    const { socket, upstream } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: async ({ rawTranscript }: { rawTranscript: string }) => {
        seenInputs.push(rawTranscript)
        return `P(${rawTranscript})`
      },
    })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "one", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))
    upstream.fireDelta({ text: "two", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))

    // Each polish sees the FULL transcript so far, so a self-correction in a
    // later chunk can rewrite the earlier text.
    expect(seenInputs).toEqual(["one", "one two"])

    const polishedEvents = socket.emitted.filter((e) => e.event === "voice:transcript:polished")
    expect(polishedEvents).toHaveLength(2)
    const chunkIds = polishedEvents.map((e) => (e.payload as { chunkId: string }).chunkId)
    expect(chunkIds[0]).toBeTruthy()
    expect(chunkIds[1]).toBe(chunkIds[0])
    expect(polishedEvents[1].payload).toMatchObject({
      raw: "one two",
      polished: "P(one two)",
    })
  })
})
