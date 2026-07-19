import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { CallManager, type CallManagerDeps, type CallSocket } from "./call-manager"
import type { MediaTransport } from "./media-transport"
import { getCallState, clearCallState, type CallRosterParticipant } from "@/stores/call-store"
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
    emit(event, payload, ack) {
      emitted.push({ event, payload })
      if (event === "call:leave") order.push("leave")
      if (event === "call:join") ack?.({ ok: true, data: socket.joinAck })
      else if (event === "call:leave") ack?.({ ok: true })
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
})

/** The mic track the manager published — reach it through the publish spy. */
function getMicTrack(transport: MediaTransport): MediaStreamTrack {
  const publish = transport.publish as unknown as ReturnType<typeof vi.fn>
  const micCall = publish.mock.calls.find((c: unknown[]) => c[0] === "mic")
  return micCall?.[1] as MediaStreamTrack
}
