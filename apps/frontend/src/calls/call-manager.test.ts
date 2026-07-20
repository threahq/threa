import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  CallManager,
  CallCaptureError,
  CallStartCancelledError,
  type CallManagerDeps,
  type CallSocket,
} from "./call-manager"
import type { MediaTransport } from "./media-transport"
import { getCallState, clearCallState, resetCallStoreCache, type CallRosterParticipant } from "@/stores/call-store"
import { isDictationExternalHeld, setDictationExternalHold } from "@/contexts/dictation-coordinator-context"

// Shared teardown-order log: the mic track, socket, and transport push into it so
// the ordered-hangup test can pin emit-leave → close-transport → stop-tracks.
let order: string[]

function makeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return {
    kind,
    enabled: true,
    stop: vi.fn(() => order.push(`stopTrack:${kind}`)),
    applyConstraints: vi.fn(async () => {}),
    addEventListener: vi.fn(),
  } as unknown as MediaStreamTrack
}

function makeStream(kinds: Array<"audio" | "video">) {
  const tracks = kinds.map(makeTrack)
  return {
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getTracks: () => tracks,
    _track: tracks[0],
  } as unknown as MediaStream & { _track: MediaStreamTrack }
}

function makeTransport() {
  const events: string[] = []
  const t: MediaTransport & { _events: string[] } = {
    connectionState: "new",
    onRemoteTrack: null,
    onRemoteTrackEnded: null,
    onConnectionStateChange: null,
    connect: vi.fn(async () => {
      events.push("connect")
    }),
    publish: vi.fn(async (kind: string) => {
      events.push(`publish:${kind}`)
    }),
    unpublish: vi.fn(async (kind: string) => {
      events.push(`unpublish:${kind}`)
    }),
    setPublishEncoding: vi.fn(async () => {}),
    pull: vi.fn(async (ref) => {
      events.push(`pull:${ref.trackName}`)
    }),
    stopPull: vi.fn(async (ref) => {
      events.push(`stopPull:${ref.trackName}`)
    }),
    getStats: vi.fn(async () => ({ rttMs: null, packetLoss: null, qualityLimitation: null, encodeTimeMs: null })),
    close: vi.fn(async () => {
      events.push("close")
      order.push("close")
    }),
    _events: events,
  }
  return t as MediaTransport & { _events: string[]; publish: ReturnType<typeof vi.fn> }
}

interface FakeSocket extends CallSocket {
  handlers: Map<string, (...a: unknown[]) => void>
  emitted: Array<{ event: string; payload: unknown }>
  joinAck: {
    endpointId: string
    epoch: number
    rosterVersion: number
    roster: CallRosterParticipant[]
    leaseTtlMs: number
  }
  /** When true, `call:join` stores its ack on `pendingJoinAck` instead of resolving it. */
  deferJoin: boolean
  pendingJoinAck: ((result: unknown) => void) | null
  fire(event: string, ...args: unknown[]): void
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const emitted: Array<{ event: string; payload: unknown }> = []
  const socket: FakeSocket = {
    connected: true,
    joinAck: { endpointId: "ep_1", epoch: 1, rosterVersion: 0, roster: [], leaseTtlMs: 45_000 },
    handlers,
    emitted,
    deferJoin: false,
    pendingJoinAck: null,
    emit(event, payload, ack) {
      emitted.push({ event, payload })
      if (event === "call:leave") order.push("leave")
      if (event === "call:join") {
        if (socket.deferJoin) socket.pendingJoinAck = ack ?? null
        else ack?.({ ok: true, data: socket.joinAck })
      } else if (event === "call:leave") ack?.({ ok: true })
      else if (event === "call:lease:renew") ack?.({ ok: true, data: { leaseExpiresAt: new Date().toISOString() } })
    },
    on(event, handler) {
      handlers.set(event, handler)
    },
    off(event) {
      handlers.delete(event)
    },
    disconnect: vi.fn(),
    fire(event, ...args) {
      handlers.get(event)?.(...args)
    },
  }
  return socket
}

function makeDeps(socket: FakeSocket, transport: MediaTransport) {
  let inc = 0
  const deps: CallManagerDeps = {
    startCallRest: vi.fn(async ({ workspaceId, streamId, mode }) => ({
      call: { id: "call_1", workspaceId, streamId, mode },
      created: true,
      participant: { id: "p_1" },
      endpoint: { id: "ep_rest" },
      rosterVersion: 0,
      roster: [],
    })),
    connectSocket: vi.fn(() => socket),
    createTransport: vi.fn(() => transport),
    acquireUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
      const kinds: Array<"audio" | "video"> = []
      if (c.audio) kinds.push("audio")
      if (c.video) kinds.push("video")
      return makeStream(kinds.length ? kinds : ["audio"])
    }),
    createAudioContext: () => null,
    enumerateDevices: vi.fn(async () => []),
    locks: null,
    requestWakeLock: vi.fn(async () => null),
    mintIncarnation: vi.fn(() => `inc-${++inc}`),
    singleActiveCapture: false,
  }
  return deps
}

function participant(overrides: Partial<CallRosterParticipant>): CallRosterParticipant {
  return {
    userId: "usr_x",
    participantStatus: "joined",
    endpointId: "ep_peer",
    connectionStatus: "connected",
    mediaState: {},
    publishedTracks: [],
    ...overrides,
  }
}

describe("CallManager", () => {
  beforeEach(() => {
    order = []
    clearCallState()
    setDictationExternalHold(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("join happy path: REST → socket join → connect → publish mic → connected", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = new CallManager(deps, null)

    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    const join = socket.emitted.find((e) => e.event === "call:join")
    expect(join?.payload).toMatchObject({ workspaceId: "ws_1", callId: "call_1", mediaIncarnation: "inc-1" })
    expect(transport.connect).toHaveBeenCalledWith({ endpointId: "ep_1", mediaIncarnation: "inc-1" })
    expect(transport.publish).toHaveBeenCalledWith("mic", expect.anything())
    expect(getCallState().phase).toBe("connected")
    expect(getCallState().callId).toBe("call_1")
    expect(isDictationExternalHeld()).toBe(true)
  })

  it("video mode publishes the camera; audio_only does not", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    expect(transport._events).toContain("publish:camera")
  })

  it("drops a stale/duplicate roster version, applies a newer one", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // Newer version applies.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 5, roster: [participant({ userId: "usr_1" })] })
    expect(getCallState().rosterVersion).toBe(5)
    expect(getCallState().roster).toHaveLength(1)

    // Stale (lower) version is dropped.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 2, roster: [] })
    expect(getCallState().rosterVersion).toBe(5)
    expect(getCallState().roster).toHaveLength(1)
  })

  it("track-registry diff drives pull then stopPull", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 2,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "mic", trackName: "peer:mic" }],
        }),
      ],
    })
    expect(transport.pull).toHaveBeenCalledWith({ sessionId: "cf-peer", trackName: "peer:mic" })

    // Peer leaves the roster → stopPull.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 3, roster: [] })
    expect(transport.stopPull).toHaveBeenCalledWith({ sessionId: "cf-peer", trackName: "peer:mic" })
  })

  it("skips peers with no cfSessionId (0.2 roster gap) rather than pulling an unaddressable ref", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 2,
      roster: [
        participant({ userId: "usr_1", cfSessionId: null, publishedTracks: [{ kind: "mic", trackName: "peer:mic" }] }),
      ],
    })
    expect(transport.pull).not.toHaveBeenCalled()
  })

  it("renews the lease at TTL/3", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.emitted.length = 0
    // TTL 45s → renew every 15s.
    vi.advanceTimersByTime(15_000)
    expect(socket.emitted.filter((e) => e.event === "call:lease:renew")).toHaveLength(1)
    vi.advanceTimersByTime(15_000)
    expect(socket.emitted.filter((e) => e.event === "call:lease:renew")).toHaveLength(2)
  })

  it("mute gates track.enabled and emits call:state", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    const micTrack = getMicTrack(transport)
    manager.setMuted(true)
    expect(micTrack.enabled).toBe(false)
    expect(getCallState().local.muted).toBe(true)
    expect(socket.emitted.find((e) => e.event === "call:state")?.payload).toEqual({ muted: true })
  })

  it("ordered teardown: emit leave → close transport → stop tracks", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    order = []

    await manager.leaveCall()

    expect(order[0]).toBe("leave")
    expect(order[1]).toBe("close")
    expect(order.slice(2)).toContain("stopTrack:audio")
    expect(getCallState().phase).toBe("idle")
    expect(isDictationExternalHeld()).toBe(false)
  })

  it("transient socket reconnect rejoins with the SAME incarnation", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = new CallManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    expect(deps.mintIncarnation).toHaveBeenCalledTimes(1)

    socket.emitted.length = 0
    socket.fire("disconnect")
    expect(getCallState().phase).toBe("reconnecting")
    socket.fire("connect")
    await Promise.resolve()

    const rejoin = socket.emitted.find((e) => e.event === "call:join")
    expect(rejoin?.payload).toMatchObject({ mediaIncarnation: "inc-1" })
    // A transient reconnect must NOT mint a new incarnation.
    expect(deps.mintIncarnation).toHaveBeenCalledTimes(1)
  })

  it("rejoin after leaving mints a NEW incarnation", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = new CallManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await manager.leaveCall()

    const socket2 = makeSocket()
    const transport2 = makeTransport()
    // Reuse the same deps identity for mintIncarnation continuity.
    ;(deps.connectSocket as ReturnType<typeof vi.fn>).mockReturnValue(socket2)
    ;(deps.createTransport as ReturnType<typeof vi.fn>).mockReturnValue(transport2)

    await manager.rejoin({ workspaceId: "ws_1", streamId: "stream_1", callId: "call_1", mode: "audio_only" })
    expect(deps.mintIncarnation).toHaveBeenCalledTimes(2)
    const join = socket2.emitted.find((e) => e.event === "call:join")
    expect(join?.payload).toMatchObject({ mediaIncarnation: "inc-2" })
  })

  // ── session-generation guard (findings 1-6) ─────────────────────────────────

  it("double startCall throws synchronously while the first is joining (in-flight guard)", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)

    // The first start suspends at its first await with the `starting` sentinel set.
    const first = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    // A second start must throw in the caller's stack, not leak a parallel session.
    expect(() => manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })).toThrow(
      /already active/
    )

    await first
    expect(manager.isActive()).toBe(true)
    // Exactly one session was ever minted (one incarnation, one socket).
    expect(socket.emitted.filter((e) => e.event === "call:join")).toHaveLength(1)
  })

  it("a stale reconnect-join continuation no-ops after teardown", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // A socket reconnect fires a rejoin whose ack we hold in flight.
    socket.deferJoin = true
    socket.fire("disconnect")
    socket.fire("connect")
    expect(socket.pendingJoinAck).not.toBeNull()

    // The user leaves while the rejoin is still in flight.
    await manager.leaveCall()
    expect(manager.isActive()).toBe(false)
    expect(getCallState().phase).toBe("idle")

    // The rejoin resolves late — its `.then` must NOT resurrect a phantom "connected".
    socket.pendingJoinAck?.({ ok: true, data: socket.joinAck })
    await Promise.resolve()
    await Promise.resolve()
    expect(getCallState().phase).toBe("idle")
    expect(manager.isActive()).toBe(false)
  })

  it("leaveCall during the joining window cancels the start and stops the mic", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    // Park the start at acquireWakeLock — one await past the mic capture — so the
    // cancel lands with a live capture already in place.
    let releaseWake: () => void = () => {}
    ;(deps.requestWakeLock as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWake = () => resolve(null)
        })
    )
    const manager = new CallManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    // Drain all microtasks so runStart reaches the parked wake-lock request.
    await new Promise((r) => setTimeout(r, 0))
    const micTrack = getMicTrack(transport)
    expect(micTrack).toBeTruthy()
    expect(manager.isActive()).toBe(true)

    // User cancels mid-join; the in-flight start must roll back.
    const leaving = manager.leaveCall()
    releaseWake()
    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    await leaving

    expect(manager.isActive()).toBe(false)
    expect(getCallState().phase).toBe("idle")
    expect(micTrack.stop).toHaveBeenCalled()
  })

  it("overlapping input-device switches serialize (never two captures at once)", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    let inFlight = 0
    let maxConcurrent = 0
    ;(deps.acquireUserMedia as ReturnType<typeof vi.fn>).mockImplementation(async (c: MediaStreamConstraints) => {
      inFlight++
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await Promise.resolve()
      await Promise.resolve()
      inFlight--
      const kinds: Array<"audio" | "video"> = ["audio"]
      if (c.video) kinds.push("video")
      return makeStream(kinds)
    })
    const manager = new CallManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // Fire two switches without awaiting the first — the chain must serialize them.
    const a = manager.switchInputDevice("dev-a")
    const b = manager.switchInputDevice("dev-b")
    await Promise.all([a, b])

    // A concurrent second capture would be fatal on iOS single-active-capture.
    expect(maxConcurrent).toBe(1)
    // Serialized in request order → settles at the last requested device.
    expect(getCallState().local.devices.selectedInputId).toBe("dev-b")
  })

  it("iOS mid-call recapture failure rolls back to the prior capture with a typed error", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    deps.singleActiveCapture = true
    let calls = 0
    ;(deps.acquireUserMedia as ReturnType<typeof vi.fn>).mockImplementation(async (c: MediaStreamConstraints) => {
      calls++
      // The device-switch acquire fails (e.g. NotReadableError); the rollback re-acquire succeeds.
      if (calls === 2) throw new Error("device busy")
      const kinds: Array<"audio" | "video"> = ["audio"]
      if (c.video) kinds.push("video")
      return makeStream(kinds)
    })
    const manager = new CallManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    const err = await manager.switchInputDevice("dev-x").catch((e) => e)
    expect(err).toBeInstanceOf(CallCaptureError)
    expect(err.code).toBe("capture_failed")

    // Startup + failed switch + rollback re-acquire = 3 getUserMedia calls; audio restored.
    expect(deps.acquireUserMedia).toHaveBeenCalledTimes(3)
    expect(manager.isActive()).toBe(true)
    // The store surfaces the typed failure for the UI.
    expect(getCallState().captureError).toMatchObject({ code: "capture_failed" })
  })

  it("a roster event dispatched before hangupSync no-ops after the flush", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = new CallManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // Capture the handler as if a roster broadcast were already dispatched into the loop.
    const rosterHandler = socket.handlers.get("call:roster")
    expect(rosterHandler).toBeTruthy()

    // Account switch / logout flush → hangupSync.
    resetCallStoreCache()
    expect(manager.isActive()).toBe(false)
    // Symmetric with teardown: the socket handlers were detached.
    expect(socket.handlers.has("call:roster")).toBe(false)

    // The already-in-flight event still fires — it must NOT write the prior
    // account's roster into the just-reset store.
    rosterHandler?.({ callId: "call_1", rosterVersion: 99, roster: [participant({ userId: "usr_z" })] })
    expect(getCallState().roster).toHaveLength(0)
    expect(getCallState().rosterVersion).toBe(0)
  })
})

/** The mic track the manager published — reach it through the publish spy. */
function getMicTrack(transport: MediaTransport): MediaStreamTrack {
  const publish = transport.publish as unknown as ReturnType<typeof vi.fn>
  const micCall = publish.mock.calls.find((c: unknown[]) => c[0] === "mic")
  return micCall?.[1] as MediaStreamTrack
}
