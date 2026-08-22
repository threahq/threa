import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test"
import type { Server } from "socket.io"
import { VOICE_DRAFT_CONTEXT_MAX_CHARS } from "@threa/types"
import { logger } from "../../lib/logger"
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
  const emitted: Array<{ event: string; payload?: unknown; callback?: (payload: unknown) => void }> = []
  let disconnected = false
  return {
    data: { workosUserId },
    on(event: string, cb: (...args: unknown[]) => unknown) {
      handlers.set(event, cb)
    },
    emit(event: string, payload?: unknown, callback?: (payload: unknown) => void) {
      emitted.push({ event, payload, ...(callback ? { callback } : {}) })
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
  voiceSteeringWords?: string[]
  workspaceSteeringWords?: string[]
  userPrefsThrows?: boolean
  workspaceSettingsThrows?: boolean
  polishTranscript?: (args: {
    rawTranscript: string
    level: string
    steeringTerms?: string[]
    draftBefore?: string
    draftAfter?: string
    signal?: AbortSignal
  }) => Promise<unknown>
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
    getPreferences: mock(async () => {
      if (overrides?.userPrefsThrows) throw new Error("user prefs unavailable")
      return {
        voicePolishLevel: overrides?.voicePolishLevel ?? "none",
        voiceSteeringWords: overrides?.voiceSteeringWords,
      }
    }),
  }
  const workspaceSettingsService = {
    getSettings: mock(async () => {
      if (overrides?.workspaceSettingsThrows) throw new Error("workspace settings unavailable")
      return { voiceSteeringWords: overrides?.workspaceSteeringWords }
    }),
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
    sessionCookies: {} as never,
    voiceTranscriptionService: voiceTranscriptionService as never,
    transcription: transcription as never,
    userPreferencesService: userPreferencesService as never,
    workspaceSettingsService: workspaceSettingsService as never,
    polishTranscript: polishTranscript as never,
  })

  const socket = fakeSocket()
  connectionHandler!(socket)

  return {
    socket,
    upstream,
    transcription,
    voiceTranscriptionService,
    userPreferencesService,
    workspaceSettingsService,
    polishTranscript,
  }
}

const START_PAYLOAD = { workspaceId: "ws_1", voiceSessionId: "voicesess_1" }

afterEach(() => jest.useRealTimers())

describe("registerVoiceGateway voice:start", () => {
  it("opens the upstream and relays deltas as voice:transcript:delta tagged with the session id", async () => {
    const { socket, upstream, transcription } = setup()
    const cb = mock(() => {})

    await socket.trigger("voice:start", START_PAYLOAD, cb)

    expect(cb).toHaveBeenCalledWith({ ok: true, protocolVersion: 3 })
    expect(transcription.open).toHaveBeenCalledWith({
      model: "elevenlabs:scribe-v2-realtime",
      language: undefined,
      // No user steering words → the baked-in product terms still bias the model.
      vocabulary: ["Threa", "Ariadne"],
    })

    upstream.fireDelta({ text: "hi", isFinal: true })
    upstream.fireError({ code: "INPUT_ERROR", message: "bad audio" })
    // The error emit awaits the polish drain (microtask) before propagating,
    // even when polish is off, so wait one tick before asserting.
    await new Promise((r) => setTimeout(r, 0))

    expect(socket.emitted).toContainEqual({
      event: "voice:transcript:delta",
      payload: { voiceSessionId: "voicesess_1", revision: 1, text: "hi", isFinal: true },
    })
    expect(socket.emitted).toContainEqual({
      event: "voice:transcription:error",
      payload: { voiceSessionId: "voicesess_1", code: "INPUT_ERROR", message: "bad audio" },
    })
  })

  it("biases the upstream and every polish pass toward baked-in plus user steering words (deduped)", async () => {
    const seenSteering: Array<string[] | undefined> = []
    const { socket, upstream, transcription } = setup({
      voicePolishLevel: "opinionated",
      // "Ariadne" duplicates a baked-in term (case-insensitively) and must collapse.
      voiceSteeringWords: ["ariadne", "Langfuse"],
      polishTranscript: async (args) => {
        seenSteering.push(args.steeringTerms)
        return `P(${args.rawTranscript})`
      },
    })

    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    expect(transcription.open).toHaveBeenCalledWith(
      expect.objectContaining({ vocabulary: ["Threa", "Ariadne", "Langfuse"] })
    )

    upstream.fireDelta({ text: "ship it", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(seenSteering).toEqual([["Threa", "Ariadne", "Langfuse"]])
  })

  it("unions the workspace-shared list with the per-user list (and the baked-in terms)", async () => {
    const { socket, transcription } = setup({
      // "Threa" collides with a baked-in term; the user term is additive.
      workspaceSteeringWords: ["Acme", "Threa"],
      voiceSteeringWords: ["MyTool"],
    })

    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    expect(transcription.open).toHaveBeenCalledWith(
      expect.objectContaining({ vocabulary: ["Threa", "Ariadne", "Acme", "MyTool"] })
    )
  })

  it("keeps polish and per-user steering while warning when workspace settings fail", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger)
    const seenLevels: string[] = []
    const { socket, upstream, transcription } = setup({
      voicePolishLevel: "opinionated",
      voiceSteeringWords: ["MyTool"],
      workspaceSettingsThrows: true,
      polishTranscript: async ({ rawTranscript, level }) => {
        seenLevels.push(level)
        return `P(${rawTranscript})`
      },
    })

    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    // Workspace lookup failed, but user prefs are intact: base ∪ user, polish on.
    expect(transcription.open).toHaveBeenCalledWith(
      expect.objectContaining({ vocabulary: ["Threa", "Ariadne", "MyTool"] })
    )
    upstream.fireDelta({ text: "hi", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))
    expect(seenLevels).toEqual(["opinionated"])
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1" }),
      "Voice workspace settings lookup failed"
    )
  })

  it("keeps workspace steering while warning when user preferences fail", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => logger)
    const { socket, transcription } = setup({
      workspaceSteeringWords: ["Acme"],
      userPrefsThrows: true,
    })

    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    // User prefs failed → polish off + no user terms, but workspace terms still apply.
    expect(transcription.open).toHaveBeenCalledWith(
      expect.objectContaining({ vocabulary: ["Threa", "Ariadne", "Acme"] })
    )
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1" }),
      "Voice user preferences lookup failed"
    )
  })

  it("negotiates v4 and clamps invalid or future requests safely", async () => {
    for (const [requested, expected] of [
      [4, 4],
      [99, 4],
      ["bad", 3],
    ] as const) {
      const { socket } = setup()
      const cb = mock(() => {})
      await socket.trigger("voice:start", { ...START_PAYLOAD, maxProtocolVersion: requested }, cb)
      expect(cb).toHaveBeenCalledWith({ ok: true, protocolVersion: expected })
      await socket.trigger("disconnect")
    }
  })

  it("emits discriminated v4 interim deltas and omits empty committed deltas", async () => {
    const { socket, upstream } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, maxProtocolVersion: 4 },
      mock(() => {})
    )
    upstream.fireDelta({ text: "draft", isFinal: false })
    upstream.fireDelta({ text: "   ", isFinal: true })
    expect(socket.emitted.filter((event) => event.event === "voice:transcript:delta")).toEqual([
      {
        event: "voice:transcript:delta",
        payload: { protocolVersion: 4, voiceSessionId: "voicesess_1", revision: 0, text: "draft", isFinal: false },
      },
    ])
    await socket.trigger("disconnect", "client namespace disconnect")
  })

  it("marks hard-split v4 continuations so the client does not invent whitespace", async () => {
    const { socket, upstream } = setup({ voicePolishLevel: "none" })
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, maxProtocolVersion: 4 },
      mock(() => {})
    )
    upstream.fireDelta({ text: "😀".repeat(1_201), isFinal: true })
    const deltas = socket.emitted.filter((event) => event.event === "voice:transcript:delta")
    expect(deltas).toHaveLength(2)
    expect(deltas[1]?.payload).toMatchObject({ isFinal: true, joinPrevious: true })
    await socket.trigger("disconnect", "client namespace disconnect")
  })

  it("emits each v4 raw delta before its acknowledged replacement", async () => {
    const { socket, upstream } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, maxProtocolVersion: 4 },
      mock(() => {})
    )
    upstream.fireDelta({ text: "hello", isFinal: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const rawIndex = socket.emitted.findIndex((event) => event.event === "voice:transcript:delta")
    const operationIndex = socket.emitted.findIndex((event) => event.event === "voice:transcript:polished")
    expect(rawIndex).toBeGreaterThanOrEqual(0)
    expect(operationIndex).toBeGreaterThan(rawIndex)
    const operation = socket.emitted[operationIndex]!
    const operationId = (operation.payload as { operationId: string }).operationId
    operation.callback?.({ operationId, status: "applied" })
    await socket.trigger("disconnect")
  })

  it("refuses a start that is missing identifiers", async () => {
    const { socket, transcription } = setup()
    const cb = mock(() => {})

    await socket.trigger("voice:start", {}, cb)

    expect(cb).toHaveBeenCalledWith({ ok: false, error: "workspaceId and voiceSessionId required", protocolVersion: 3 })
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

    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Session already started", protocolVersion: 3 })
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
    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Session ended before it started", protocolVersion: 3 })
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
    expect(cb).toHaveBeenCalledWith({ ok: false, error: "Failed to start voice session", protocolVersion: 3 })
  })
})

describe("registerVoiceGateway lifecycle", () => {
  it("keeps gateway failure and disconnect diagnostics content-free", async () => {
    const sentinel = "PRIVATE_TRANSCRIPT_ERROR_REASON_SENTINEL"
    const logs: unknown[][] = []
    const info = spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args)
      return logger
    })
    const warn = spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
      logs.push(args)
      return logger
    })
    try {
      const { socket, upstream, voiceTranscriptionService } = setup()
      upstream.flush = mock(async () => {
        throw new Error(sentinel)
      })
      upstream.close = mock(async () => {
        throw Object.assign(new Error(sentinel), { code: sentinel })
      })
      voiceTranscriptionService.finishSession.mockImplementation(async () => {
        throw new Error(sentinel)
      })
      await socket.trigger(
        "voice:start",
        START_PAYLOAD,
        mock(() => {})
      )
      await socket.trigger(
        "voice:stop",
        { mode: "format" },
        mock(() => {})
      )
      await socket.trigger("disconnect", sentinel)
      const serialized = JSON.stringify(logs)
      expect(serialized).not.toContain(sentinel)
      expect(serialized).toContain('"reason":"other"')
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it("stops an empty v4 session without coordinator or polish work", async () => {
    const { socket, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, maxProtocolVersion: 4 },
      mock(() => {})
    )
    await socket.trigger(
      "voice:stop",
      { mode: "format" },
      mock(() => {})
    )
    expect(polishTranscript).not.toHaveBeenCalled()
    expect(socket.emitted).toContainEqual({
      event: "voice:stopped",
      payload: { reason: "stopped", revision: 0, outcome: "empty_input" },
    })
  })

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
    expect(socket.emitted).toContainEqual({
      event: "voice:stopped",
      payload: { reason: "stopped", revision: 0, outcome: "empty_input" },
    })
    expect(stopCb).toHaveBeenCalledWith({ ok: true })
  })

  it("ignores a provider final that arrives after flush settled while authoritative v4 formatting runs", async () => {
    let markFinalStarted!: () => void
    let resolveFinal!: (value: string) => void
    const finalStarted = new Promise<void>((resolve) => {
      markFinalStarted = resolve
    })
    const finalResult = new Promise<string>((resolve) => {
      resolveFinal = resolve
    })
    const { socket, upstream } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: async () => {
        markFinalStarted()
        return await finalResult
      },
    })
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, maxProtocolVersion: 4 },
      mock(() => {})
    )
    upstream.fireDelta({ text: "the visible tail", isFinal: false })

    const stopping = socket.trigger(
      "voice:stop",
      { mode: "format" },
      mock(() => {})
    ) as Promise<void>
    await finalStarted
    // A provider may deliver this after its flush timeout has already resolved.
    // The promoted interim is now the terminal source of truth.
    upstream.fireDelta({ text: "the visible tail", isFinal: true })
    resolveFinal("The visible tail.")

    let operation = socket.emitted.find((event) => event.event === "voice:transcript:polished")
    for (let attempts = 0; attempts < 10 && !operation; attempts++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      operation = socket.emitted.find((event) => event.event === "voice:transcript:polished")
    }
    expect(operation).toBeDefined()
    const operationPayload = operation!.payload as { operationId: string; sources: unknown[] }
    operation!.callback?.({ operationId: operationPayload.operationId, status: "applied" })
    await stopping

    const finalDeltas = socket.emitted.filter(
      (event) => event.event === "voice:transcript:delta" && (event.payload as { isFinal: boolean }).isFinal
    )
    expect(finalDeltas.map((event) => event.payload)).toEqual([
      expect.objectContaining({ revision: 1, text: "the visible tail", isFinal: true }),
    ])
    expect(operationPayload.sources).toEqual([{ chunkId: expect.any(String), throughRevision: 1 }])
    expect(socket.emitted).toContainEqual({
      event: "voice:stopped",
      payload: { reason: "stopped", revision: 1, outcome: "success" },
    })
  })

  it("max duration follows the authoritative format path before disconnecting", async () => {
    jest.useFakeTimers()
    const { socket, upstream, voiceTranscriptionService } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )
    upstream.fireDelta({ text: "final words", isFinal: false })

    jest.advanceTimersByTime(10 * 60 * 1_000)
    jest.useRealTimers()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(upstream.flush).toHaveBeenCalledTimes(1)
    expect(voiceTranscriptionService.finishSession).toHaveBeenCalledTimes(1)
    expect(voiceTranscriptionService.abortSession).not.toHaveBeenCalled()
    expect(socket.emitted).toContainEqual({
      event: "voice:stopped",
      payload: expect.objectContaining({ reason: "max_duration", outcome: "success" }),
    })
    expect(socket.disconnected).toBe(true)
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

  it("a send-as-is upgrade interrupts an in-flight format flush and finishes once", async () => {
    let releaseFlush!: () => void
    const flush = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    const { socket, upstream, voiceTranscriptionService } = setup()
    upstream.flush = mock(() => flush)
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    const formatting = socket.trigger(
      "voice:stop",
      { mode: "format" },
      mock(() => {})
    ) as Promise<void>
    await Promise.resolve()
    const sending = socket.trigger(
      "voice:stop",
      { mode: "send_as_is" },
      mock(() => {})
    ) as Promise<void>
    await sending

    expect(upstream.close).toHaveBeenCalledTimes(1)
    expect(voiceTranscriptionService.finishSession).toHaveBeenCalledTimes(1)
    expect(voiceTranscriptionService.abortSession).not.toHaveBeenCalled()
    releaseFlush()
    await formatting
  })

  it("abort wins while send-as-is is blocked closing", async () => {
    let releaseClose!: (result: { totalAudioMs: number }) => void
    const close = new Promise<{ totalAudioMs: number }>((resolve) => {
      releaseClose = resolve
    })
    const { socket, upstream, voiceTranscriptionService } = setup()
    upstream.close = mock(() => close)
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    const sending = socket.trigger(
      "voice:stop",
      { mode: "send_as_is" },
      mock(() => {})
    ) as Promise<void>
    await Promise.resolve()
    const aborting = socket.trigger("disconnect") as Promise<void>
    releaseClose({ totalAudioMs: 12 })
    await Promise.all([sending, aborting])

    expect(voiceTranscriptionService.abortSession).toHaveBeenCalledTimes(1)
    expect(voiceTranscriptionService.finishSession).not.toHaveBeenCalled()
    expect(socket.emitted.some((event) => event.event === "voice:stopped")).toBe(false)
  })

  it("send-as-is cancels authoritative formatting without waiting for a late provider", async () => {
    let startedFinal!: () => void
    let resolveFinal!: (value: string) => void
    const finalStarted = new Promise<void>((resolve) => {
      startedFinal = resolve
    })
    const final = new Promise<string>((resolve) => {
      resolveFinal = resolve
    })
    const { socket, upstream, voiceTranscriptionService } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: async ({ signal }) => {
        if (!signal?.aborted) startedFinal()
        return final
      },
    })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )
    upstream.fireDelta({ text: "tail", isFinal: false })

    const formatting = socket.trigger(
      "voice:stop",
      { mode: "format" },
      mock(() => {})
    ) as Promise<void>
    await finalStarted
    const sending = socket.trigger(
      "voice:stop",
      { mode: "send_as_is" },
      mock(() => {})
    ) as Promise<void>
    await sending

    expect(voiceTranscriptionService.finishSession).toHaveBeenCalledTimes(1)
    expect(socket.emitted.some((event) => event.event === "voice:transcript:polished")).toBe(false)
    resolveFinal("late")
    await formatting
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
    expect(interimDelta?.payload).toEqual({ voiceSessionId: "voicesess_1", revision: 0, text: "hello", isFinal: false })
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
      payload: { voiceSessionId: "voicesess_1", revision: 0, text: "   ", isFinal: true },
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
    expect(socket.emitted.find((e) => e.event === "voice:transcription:error")).toBeDefined()

    // Resolve the polish. The drain awaits it, then emits the error.
    resolvePolish!()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const errorIdx = socket.emitted.findIndex((e) => e.event === "voice:transcription:error")
    const polishedIdx = socket.emitted.findIndex((e) => e.event === "voice:transcript:polished")
    expect(polishedIdx).toBe(-1)
    expect(errorIdx).toBeGreaterThanOrEqual(0)
  })

  it("forwards the capped draft context from voice:start to every polish pass", async () => {
    const seen: Array<{ draftBefore?: string; draftAfter?: string }> = []
    const { socket, upstream } = setup({
      voicePolishLevel: "opinionated",
      polishTranscript: async (args: { rawTranscript: string; draftBefore?: string; draftAfter?: string }) => {
        seen.push({ draftBefore: args.draftBefore, draftAfter: args.draftAfter })
        return `P(${args.rawTranscript})`
      },
    })
    // Oversized before-text: the gateway keeps the END (closest to the caret).
    const longBefore = "x".repeat(VOICE_DRAFT_CONTEXT_MAX_CHARS + 1000) + " merge the poor frequence"
    await socket.trigger(
      "voice:start",
      { ...START_PAYLOAD, draftBefore: longBefore, draftAfter: "before the standup" },
      mock(() => {})
    )

    upstream.fireDelta({ text: "one", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))
    upstream.fireDelta({ text: "two", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))

    expect(seen).toHaveLength(2)
    for (const call of seen) {
      expect(call.draftAfter).toBe("before the standup")
      expect(call.draftBefore?.length).toBe(VOICE_DRAFT_CONTEXT_MAX_CHARS)
      expect(call.draftBefore?.endsWith("merge the poor frequence")).toBe(true)
    }
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

  it("promotes the pending interim to a synthetic polished final when the upstream errors before committing it", async () => {
    // ElevenLabs' spurious "insufficient funds" close fires before
    // committed_transcript lands, so the speech since the last commit lives
    // only as interim text. Without promotion the client's flushInterim
    // would land that text in the editor as raw, unpolished words.
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "let me start at nine", isFinal: false })
    upstream.fireDelta({ text: "let me start at nine no sorry eight", isFinal: false })
    upstream.fireError({ code: "UPSTREAM_CLOSED", message: "10s ElevenLabs disconnect" })

    // Two micro-ticks: one for the polish promise to resolve, one for the
    // drain .then() to run after it.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(polishTranscript).not.toHaveBeenCalled()
    expect(
      socket.emitted.filter((e) => e.event === "voice:transcript:delta" && (e.payload as { isFinal: boolean }).isFinal)
    ).toHaveLength(0)
  })

  it("a real final clears the pending interim so the error path doesn't re-emit it", async () => {
    // Without the clear, a final at t=1 followed by an error at t=2 would
    // double-commit: once via the real final, again via promotion of the
    // stale interim that preceded it.
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "opinionated" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "hello", isFinal: false })
    upstream.fireDelta({ text: "hello world", isFinal: true })
    await new Promise((r) => setTimeout(r, 0))
    upstream.fireError({ code: "UPSTREAM_CLOSED", message: "10s ElevenLabs disconnect" })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(polishTranscript).toHaveBeenCalledTimes(1)
    const finalDeltas = socket.emitted.filter(
      (e) => e.event === "voice:transcript:delta" && (e.payload as { isFinal: boolean }).isFinal
    )
    expect(finalDeltas).toHaveLength(1)
    expect(finalDeltas[0].payload).toMatchObject({ text: "hello world" })
  })

  it("promotes the pending interim as a plain (untagged) final when polish is off", async () => {
    // Polish off + pending interim on error: still commit the text so the
    // user doesn't lose it, but without a chunkId (no tracking, no polish).
    const { socket, upstream, polishTranscript } = setup({ voicePolishLevel: "none" })
    await socket.trigger(
      "voice:start",
      START_PAYLOAD,
      mock(() => {})
    )

    upstream.fireDelta({ text: "halfway through a thought", isFinal: false })
    upstream.fireError({ code: "UPSTREAM_CLOSED", message: "10s ElevenLabs disconnect" })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(polishTranscript).not.toHaveBeenCalled()
    expect(
      socket.emitted.filter((e) => e.event === "voice:transcript:delta" && (e.payload as { isFinal: boolean }).isFinal)
    ).toHaveLength(0)
  })
})
