import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  CallManager,
  CallCaptureError,
  CallStartCancelledError,
  type CallManagerDeps,
  type CallSocket,
} from "./call-manager"
import type { CallTransportTransfer } from "@threahq/types"
import type { MediaTransport } from "./media-transport"
import {
  AUDIO_CAPTURE_CONSTRAINTS,
  VIDEO_CAPTURE_CONSTRAINTS,
  PULL_RETRY_DELAY_MS,
  PULL_RETRY_MAX_ATTEMPTS,
  WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE,
  WATCHDOG_SAMPLE_MS,
} from "./config"
import { ApiError } from "@/api/client"
import { getCallState, clearCallState, resetCallStoreCache, type CallRosterParticipant } from "@/stores/call-store"
import { isDictationExternalHeld, setDictationExternalHold } from "@/contexts/dictation-coordinator-context"
import { clearCallLifecycleLog, getCallLifecycleEvents } from "./lifecycle-log"
import type { CallMediaSession, CallMediaSessionHandlers } from "./media-session"

// Shared teardown-order log: the mic track, socket, and transport push into it so
// the ordered-hangup test can pin emit-leave → close-transport → stop-tracks.
let order: string[]

function makeTrack(kind: "audio" | "video"): MediaStreamTrack {
  return {
    kind,
    enabled: true,
    readyState: "live",
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
    syncPeers: vi.fn(async () => {}),
    hasInboundByteProgress: vi.fn(async () => true),
    hasEstablishedOwnPublications: vi.fn(() => true),
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
    mediaTransport: "sfu" | "p2p"
    transportGeneration: number
  }
  /** When true, `call:join` stores its ack on `pendingJoinAck` instead of resolving it. */
  deferJoin: boolean
  pendingJoinAck: ((result: unknown) => void) | null
  /** When true, `call:join` acks with a failure so the join promise rejects. */
  failJoin: boolean
  /** The ack `call:lease:renew` replies with. */
  leaseRenewAck: unknown
  fire(event: string, ...args: unknown[]): void
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  const emitted: Array<{ event: string; payload: unknown }> = []
  const socket: FakeSocket = {
    connected: true,
    joinAck: {
      endpointId: "ep_1",
      epoch: 1,
      rosterVersion: 0,
      roster: [],
      leaseTtlMs: 45_000,
      mediaTransport: "sfu",
      transportGeneration: 1,
    },
    handlers,
    emitted,
    deferJoin: false,
    pendingJoinAck: null,
    failJoin: false,
    leaseRenewAck: { ok: true, data: { leaseExpiresAt: new Date().toISOString() } },
    emit(event, payload, ack) {
      emitted.push({ event, payload })
      if (event === "call:leave") order.push("leave")
      if (event === "call:join") {
        if (socket.failJoin) ack?.({ ok: false, code: "JOIN_FAILED" })
        else if (socket.deferJoin) socket.pendingJoinAck = ack ?? null
        else ack?.({ ok: true, data: socket.joinAck })
      } else if (event === "call:leave") ack?.({ ok: true })
      else if (event === "call:lease:renew") ack?.(socket.leaseRenewAck)
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

interface FakeMediaSession extends CallMediaSession {
  handlers: CallMediaSessionHandlers | null
  /** Which actions each `setHandlers` registered, in order — the gesture set, then the session set. */
  registered: Array<Record<keyof CallMediaSessionHandlers, boolean>>
  releases: number
  activations: Array<{ title: string; subtitle: string }>
}

/**
 * A media session that records into the transport's event log, so a test can pin
 * `activate` against `connect`/`publish:mic` in one ordering (INV-24).
 */
function makeMediaSession(events: string[]): FakeMediaSession {
  const fake: FakeMediaSession = {
    handlers: null,
    registered: [],
    releases: 0,
    activations: [],
    activate: vi.fn((metadata: { title: string; subtitle: string }) => {
      fake.activations.push(metadata)
      events.push("mediaSession:activate")
    }),
    setTitle: vi.fn(),
    setHandlers: vi.fn((handlers: CallMediaSessionHandlers) => {
      fake.handlers = handlers
      fake.registered.push({
        hangup: handlers.hangup !== null,
        toggleMicrophone: handlers.toggleMicrophone !== null,
        toggleCamera: handlers.toggleCamera !== null,
      })
    }),
    setMicrophoneActive: vi.fn(),
    setCameraActive: vi.fn(),
    release: vi.fn(() => {
      fake.releases++
    }),
  }
  return fake
}

function startResponse({
  callId = "call_1",
  workspaceId = "ws_1",
  streamId = "stream_1",
  mode = "audio_only",
}: { callId?: string; workspaceId?: string; streamId?: string; mode?: "audio_only" | "video" } = {}) {
  return {
    call: { id: callId, workspaceId, streamId, mode, mediaTransport: "sfu" as const, transportGeneration: 1 },
    created: true,
    participant: { id: "p_1" },
    endpoint: { id: "ep_rest" },
    chatAnchorId: "event_chat_1",
    rosterVersion: 0,
    roster: [],
  }
}

function makeDeps(socket: FakeSocket, transport: MediaTransport, mediaSession: CallMediaSession | null = null) {
  let inc = 0
  const deps: CallManagerDeps = {
    startCallRest: vi.fn(async ({ workspaceId, streamId, mode }) => startResponse({ workspaceId, streamId, mode })),
    leaveCallRest: vi.fn(async () => {}),
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
    createMediaSession: vi.fn(() => mediaSession),
    singleActiveCapture: false,
  }
  return deps
}

function transferSnapshot(phase: CallTransportTransfer["phase"], version: number): CallTransportTransfer {
  return {
    id: "callxfer_1",
    version,
    source: { generation: 1, transport: "sfu" },
    target: { generation: 2, transport: "p2p" },
    membershipRevision: 4,
    phase,
    cause: "explicit",
    failureCode: phase === "failed" ? "TARGET_FAILED" : null,
    recoveryCode: null,
    sessions: [
      {
        id: "calltsess_self",
        endpointId: "ep_1",
        endpointEpoch: 1,
        mediaIncarnation: "inc-1",
        generation: 2,
        transport: "p2p",
        status: "preparing",
        providerSessionId: null,
        publicationRevision: 1,
        publishedTracks: [],
      },
      {
        id: "calltsess_peer",
        endpointId: "ep_peer",
        endpointEpoch: 1,
        mediaIncarnation: "inc_peer",
        generation: 2,
        transport: "p2p",
        status: "preparing",
        providerSessionId: null,
        publicationRevision: 1,
        publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "target_mic", transportGeneration: 2 }],
      },
    ],
    obligations: [
      {
        endpointId: "ep_1",
        endpointEpoch: 1,
        mediaIncarnation: "inc-1",
        membershipRevision: 4,
        trackRevision: 1,
        expectedPublications: [
          {
            endpointId: "ep_peer",
            endpointEpoch: 1,
            mediaIncarnation: "inc_peer",
            kind: "mic",
            publicationId: "target_mic",
            publicationRevision: 1,
            muted: false,
          },
        ],
        readyPublications: [],
        ownPublicationsReady: true,
        switched: phase !== "preparing",
        sourceReleased: false,
        restoredToSource: false,
      },
    ],
  }
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

// Every manager built by a test, so the afterEach can hang up the ones a test
// left connected. A live session keeps its document/window lifecycle listeners
// attached, and those write into the shared lifecycle log from later tests.
const managers: CallManager[] = []

function newManager(deps: CallManagerDeps, audioContainer: HTMLElement | null): CallManager {
  const manager = new CallManager(deps, audioContainer)
  managers.push(manager)
  return manager
}

describe("CallManager", () => {
  beforeEach(() => {
    order = []
    clearCallState()
    setDictationExternalHold(false)
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    for (const manager of managers.splice(0)) {
      await manager.leaveCall()
    }
  })

  it("join happy path: REST → socket join → connect → publish mic → connected", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)

    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    const join = socket.emitted.find((e) => e.event === "call:join")
    expect(join?.payload).toMatchObject({ workspaceId: "ws_1", callId: "call_1", mediaIncarnation: "inc-1" })
    expect(transport.connect).toHaveBeenCalledWith({ endpointId: "ep_1", mediaIncarnation: "inc-1" })
    expect(transport.publish).toHaveBeenCalledWith("mic", expect.anything())
    expect(getCallState().phase).toBe("connected")
    expect(getCallState().callId).toBe("call_1")
    expect(isDictationExternalHeld()).toBe(true)
  })

  it("should finish initial capture before connected controls and a queued camera change", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    let releaseConnect!: () => void
    vi.spyOn(transport, "connect").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = resolve
        })
    )
    const manager = newManager(deps, null)
    const starting = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled())
    transport.onConnectionStateChange?.("connected")
    const phaseBeforeCapture = getCallState().phase
    const cameraChange = manager.setCameraOn(true)
    await Promise.resolve()
    const capturesBeforeConnect = vi.mocked(deps.acquireUserMedia).mock.calls.length
    releaseConnect()
    await Promise.all([starting, cameraChange])
    expect({
      phaseBeforeCapture,
      capturesBeforeConnect,
      requestedVideo: vi.mocked(deps.acquireUserMedia).mock.calls.map(([constraints]) => Boolean(constraints.video)),
      finalCameraOn: getCallState().local.cameraOn,
    }).toEqual({
      phaseBeforeCapture: "joining",
      capturesBeforeConnect: 0,
      requestedVideo: [false, true],
      finalCameraOn: true,
    })
  })

  it("join defaults to mic-on / camera-off even in video mode; camera publishes only on setCameraOn", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    // Plan §In-call features: join is mic-on, camera-off — no camera capture yet.
    expect(transport._events).toContain("publish:mic")
    expect(transport._events).not.toContain("publish:camera")
    expect(getCallState().local.cameraOn).toBe(false)

    await manager.setCameraOn(true)
    expect(transport._events).toContain("publish:camera")
    expect(getCallState().local.cameraOn).toBe(true)
  })

  it("joins with the camera publishing when cameraOn is requested (Start with camera)", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })
    // Camera is up at join, not deferred to a setCameraOn tap.
    expect(transport._events).toContain("publish:mic")
    expect(transport._events).toContain("publish:camera")
    expect(getCallState().local.cameraOn).toBe(true)
  })

  it("adopts the server-returned mode over the requested mode (join-existing audio_only)", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    // The launch surface hardcodes "video", but this stream already hosts an
    // audio_only call — the server returns audio_only and the client must adopt it.
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockResolvedValue({
      call: {
        id: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "audio_only",
        mediaTransport: "sfu",
        transportGeneration: 1,
      },
      created: false,
      participant: { id: "p_1" },
      endpoint: { id: "ep_rest" },
      chatAnchorId: "event_chat_1",
      rosterVersion: 0,
      roster: [],
    })
    const manager = newManager(deps, null)

    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    expect(getCallState().mode).toBe("audio_only")
    // The adopted mode caps the camera: setCameraOn is a no-op, never tripping the server gate.
    await manager.setCameraOn(true)
    expect(transport._events).not.toContain("publish:camera")
  })

  it("audio_only mode ignores setCameraOn", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await manager.setCameraOn(true)
    expect(transport._events).not.toContain("publish:camera")
  })

  it("drops a stale/duplicate roster version, applies a newer one", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
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

  it("should map existing SFU publications and replace them when the provider session changes", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const announce = (version: number, cfSessionId: string) =>
      socket.fire("call:roster", {
        callId: "call_1",
        rosterVersion: version,
        roster: [
          participant({
            endpointId: "ep_peer",
            cfSessionId,
            publishedTracks: [{ kind: "mic", trackName: "peer:mic" }],
          }),
        ],
      })
    announce(2, "cf-old")
    const oldRef = { endpointId: "ep_peer", kind: "mic", publicationId: "cf-old:peer:mic" }
    expect(transport.syncPeers).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          publications: [{ ref: oldRef, providerLocator: { sessionId: "cf-old", trackName: "peer:mic" } }],
        }),
      ],
      1
    )
    expect(transport.pull).toHaveBeenCalledWith(oldRef)
    announce(3, "cf-new")
    expect(transport.pull).toHaveBeenCalledWith({ ...oldRef, publicationId: "cf-new:peer:mic" })
    expect(transport.stopPull).toHaveBeenCalledWith(oldRef)
  })

  it("track-registry diff drives pull then stopPull", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
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
    expect(transport.pull).toHaveBeenCalledWith({
      endpointId: "ep_peer",
      kind: "mic",
      publicationId: "cf-peer:peer:mic",
    })

    // Peer leaves the roster → stopPull.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 3, roster: [] })
    expect(transport.stopPull).toHaveBeenCalledWith({
      endpointId: "ep_peer",
      kind: "mic",
      publicationId: "cf-peer:peer:mic",
    })
  })

  it("should retry a failed pull against the live roster instead of losing the track for the call", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    ;(transport.pull as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("pull timed out"))
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 2,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "camera", trackName: "peer:camera" }],
        }),
      ],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.pull).toHaveBeenCalledTimes(1)

    // No further roster event arrives — the track didn't change. The retry
    // timer re-diffs against the store's roster and pulls again.
    await vi.advanceTimersByTimeAsync(PULL_RETRY_DELAY_MS)
    expect(transport.pull).toHaveBeenCalledTimes(2)
    expect(transport.pull).toHaveBeenLastCalledWith({
      endpointId: "ep_peer",
      kind: "camera",
      publicationId: "cf-peer:peer:camera",
    })
  })

  it("should stop retrying a pull at the attempt cap", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    ;(transport.pull as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("pull timed out"))
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 2,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "camera", trackName: "peer:camera" }],
        }),
      ],
    })
    for (let i = 0; i < PULL_RETRY_MAX_ATTEMPTS + 2; i++) {
      await vi.advanceTimersByTimeAsync(PULL_RETRY_DELAY_MS)
    }
    expect(transport.pull).toHaveBeenCalledTimes(PULL_RETRY_MAX_ATTEMPTS)

    // The cap also binds roster-driven re-diffs: any peer's mute toggle bumps
    // the roster, and a capped dead track must not re-hold the negotiation
    // queue on every such broadcast.
    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 3,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "camera", trackName: "peer:camera" }],
        }),
      ],
    })
    await vi.advanceTimersByTimeAsync(PULL_RETRY_DELAY_MS)
    expect(transport.pull).toHaveBeenCalledTimes(PULL_RETRY_MAX_ATTEMPTS)

    // But a track that leaves the roster and comes back (peer republished the
    // same trackName) gets fresh attempts.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 4, roster: [] })
    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 5,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "camera", trackName: "peer:camera" }],
        }),
      ],
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.pull).toHaveBeenCalledTimes(PULL_RETRY_MAX_ATTEMPTS + 1)
  })

  it("should ignore a stale pull rejection after the track was removed and re-added mid-flight", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    let rejectFirst!: (err: Error) => void
    ;(transport.pull as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue(undefined)
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    const peerRoster = (version: number) => ({
      callId: "call_1",
      rosterVersion: version,
      roster: [
        participant({
          userId: "usr_1",
          endpointId: "ep_peer",
          cfSessionId: "cf-peer",
          publishedTracks: [{ kind: "camera", trackName: "peer:camera" }],
        }),
      ],
    })
    const peerCameraRef = { endpointId: "ep_peer", kind: "camera", publicationId: "cf-peer:peer:camera" }
    socket.fire("call:roster", peerRoster(2))
    // Track removed and re-added while the first pull is still in flight.
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 3, roster: [] })
    socket.fire("call:roster", peerRoster(4))
    expect((transport.pull as ReturnType<typeof vi.fn>).mock.calls).toEqual([[peerCameraRef], [peerCameraRef]])

    // The STALE pull's rejection must not evict the replacement pull's entry —
    // otherwise the next roster broadcast starts a duplicate pull.
    rejectFirst(new Error("stale pull timed out"))
    await vi.waitFor(() => expect(getCallState().rosterVersion).toBe(4))
    socket.fire("call:roster", { ...peerRoster(5) })
    expect((transport.pull as ReturnType<typeof vi.fn>).mock.calls).toEqual([[peerCameraRef], [peerCameraRef]])
  })

  it("passes a logical publication to the transport without exposing an SFU locator", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 2,
      roster: [
        participant({
          userId: "usr_1",
          epoch: 1,
          mediaIncarnation: "inc_peer",
          cfSessionId: null,
          publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "peer:mic", transportGeneration: 1 }],
        }),
      ],
    })
    expect(transport.pull).toHaveBeenCalledWith({ endpointId: "ep_peer", kind: "mic", publicationId: "peer:mic" })
  })

  it("should preserve the remote audio element for the same logical publication", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const container = document.createElement("div")
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(private readonly tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio")
        }
      }
    )
    const manager = newManager(makeDeps(socket, transport), container)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const ref = { endpointId: "ep_peer", kind: "mic" as const, publicationId: "pub_1" }
    const track = makeTrack("audio")
    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 1,
      roster: [
        participant({
          epoch: 1,
          mediaIncarnation: "inc_peer",
          publishedTracks: [
            { kind: "mic", trackName: "peer:mic", publicationId: ref.publicationId, transportGeneration: 1 },
          ],
        }),
      ],
    })

    transport.onRemoteTrack?.({ ref, track })
    const first = container.querySelector("audio")
    transport.onRemoteTrack?.({ ref, track })

    expect({
      elements: container.querySelectorAll("audio").length,
      sameElement: container.querySelector("audio") === first,
      playCalls: play.mock.calls.length,
    }).toEqual({
      elements: 1,
      sameElement: true,
      playCalls: 1,
    })
  })

  it("should attach current P2P media delivered during peer sync", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const container = document.createElement("div")
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(private readonly tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio")
        }
      }
    )
    const track = makeTrack("audio")
    transport.syncPeers = vi.fn(async (peers) => {
      const ref = peers[0]?.publications[0]?.ref
      if (ref) transport.onRemoteTrack?.({ ref, track })
    })
    const manager = newManager(makeDeps(socket, transport), container)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 1,
      roster: [
        participant({
          epoch: 1,
          mediaIncarnation: "inc_peer",
          publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "pub_audio", transportGeneration: 1 }],
        }),
      ],
    })

    expect((container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks()[0]).toBe(track)
  })

  it("should keep replacement media when an old publication ends late", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const container = document.createElement("div")
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(private readonly tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio")
        }
        getVideoTracks() {
          return this.tracks.filter((track) => track.kind === "video")
        }
      }
    )
    const manager = newManager(makeDeps(socket, transport), container)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    const oldAudio = { endpointId: "ep_peer", kind: "mic" as const, publicationId: "pub_audio_old" }
    const newAudio = { ...oldAudio, publicationId: "pub_audio_new" }
    const oldVideo = { endpointId: "ep_peer", kind: "camera" as const, publicationId: "pub_video_old" }
    const newVideo = { ...oldVideo, publicationId: "pub_video_new" }
    const replacementAudio = makeTrack("audio")
    const replacementVideo = makeTrack("video")
    const announce = (version: number, audioRef: typeof oldAudio, videoRef: typeof oldVideo) =>
      socket.fire("call:roster", {
        callId: "call_1",
        rosterVersion: version,
        roster: [
          participant({
            epoch: 1,
            mediaIncarnation: "inc_peer",
            publishedTracks: [
              {
                kind: "mic",
                trackName: "peer:mic",
                publicationId: audioRef.publicationId,
                transportGeneration: 1,
              },
              {
                kind: "camera",
                trackName: "peer:camera",
                publicationId: videoRef.publicationId,
                transportGeneration: 1,
              },
            ],
          }),
        ],
      })

    announce(1, oldAudio, oldVideo)
    transport.onRemoteTrack?.({ ref: oldAudio, track: makeTrack("audio") })
    transport.onRemoteTrack?.({ ref: oldVideo, track: makeTrack("video") })
    announce(2, newAudio, newVideo)
    transport.onRemoteTrack?.({ ref: newAudio, track: replacementAudio })
    transport.onRemoteTrack?.({ ref: newVideo, track: replacementVideo })
    transport.onRemoteTrack?.({ ref: oldAudio, track: makeTrack("audio") })
    transport.onRemoteTrack?.({ ref: oldVideo, track: makeTrack("video") })
    transport.onRemoteTrackEnded?.(oldAudio)
    transport.onRemoteTrackEnded?.(oldVideo)

    expect({
      audioElements: container.querySelectorAll("audio").length,
      audioTrack: (container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks()[0],
      videoTrack: manager.getVideoStream("ep_peer")?.getVideoTracks()[0],
    }).toEqual({ audioElements: 1, audioTrack: replacementAudio, videoTrack: replacementVideo })
  })

  it("renews the lease at TTL/3", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.emitted.length = 0
    // TTL 45s → renew every 15s.
    vi.advanceTimersByTime(15_000)
    expect(socket.emitted.filter((e) => e.event === "call:lease:renew")).toHaveLength(1)
    vi.advanceTimersByTime(15_000)
    expect(socket.emitted.filter((e) => e.event === "call:lease:renew")).toHaveLength(2)
  })

  it("gives the call up when another device takes it over, without leaving server-side", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    socket.fire("call:endpoint:closed", { callId: "call_1", endpointId: "ep_1", reason: "taken_over" })
    await vi.waitFor(() => expect(getCallState().phase).toBe("idle"))

    // No leave of any kind: `call:leave` would cancel this user's own outgoing
    // ring, and the REST self-leave closes EVERY endpoint — including the device
    // that just took over.
    expect(socket.emitted.some((e) => e.event === "call:leave")).toBe(false)
    expect(deps.leaveCallRest).not.toHaveBeenCalled()
    expect(transport.close).toHaveBeenCalled()
    // The notice outlives the teardown that cleared the rest of the call state.
    expect(getCallState().displacedCall).toEqual({
      callId: "call_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "video",
      reason: "taken_over",
    })
  })

  it("ignores an endpoint-closed event for another call or another endpoint", async () => {
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:endpoint:closed", { callId: "call_other", endpointId: "ep_1" })
    socket.fire("call:endpoint:closed", { callId: "call_1", endpointId: "ep_stale" })

    expect(getCallState().phase).toBe("connected")
    expect(getCallState().displacedCall).toBeNull()
  })

  it("still explains itself when only the lease renew reports the lost endpoint", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // The backstop for a device that lost the socket push.
    socket.emit = ((event: string, _p: unknown, ack?: (r: unknown) => void) => {
      if (event === "call:lease:renew") ack?.({ ok: false, code: "CALL_LEASE_SUPERSEDED" })
    }) as CallSocket["emit"]
    vi.advanceTimersByTime(15_000)
    await vi.waitFor(() => expect(getCallState().phase).toBe("idle"))

    // NOT `taken_over`: a swept lease and a superseded one are the same null from
    // `renewLease`, so this signal cannot name another device.
    expect(getCallState().displacedCall).toMatchObject({
      callId: "call_1",
      streamId: "stream_1",
      reason: "connection_lost",
    })
  })

  it("mute gates track.enabled and emits call:state", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
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
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    order = []

    await manager.leaveCall()

    expect(order[0]).toBe("leave")
    expect(order[1]).toBe("close")
    expect(order.slice(2)).toContain("stopTrack:audio")
    expect(getCallState().phase).toBe("idle")
    expect(isDictationExternalHeld()).toBe(false)
  })

  it("should refetch the authoritative transfer snapshot after a durable call prompt", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const transfer = {
      id: "callxfer_1",
      version: 2,
      source: { generation: 1, transport: "sfu" as const },
      target: { generation: 2, transport: "p2p" as const },
      membershipRevision: 0,
      phase: "preparing" as const,
      cause: "explicit" as const,
      failureCode: null,
      recoveryCode: null,
      sessions: [
        {
          id: "calltsess_1",
          endpointId: "ep_1",
          endpointEpoch: 1,
          mediaIncarnation: "inc-1",
          generation: 2,
          transport: "p2p" as const,
          status: "preparing" as const,
          providerSessionId: null,
          publicationRevision: 0,
          publishedTracks: [],
        },
      ],
      obligations: [],
    }
    deps.getCallSnapshot = vi.fn(async () => ({
      call: {
        id: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "audio_only" as const,
        mediaTransport: "sfu" as const,
        transportGeneration: 1,
      },
      created: false,
      participant: { id: "p_1" },
      endpoint: { id: "ep_1" },
      chatAnchorId: "event_chat_1",
      rosterVersion: 0,
      roster: [],
      mediaTransport: "sfu" as const,
      transportGeneration: 1,
      transfer,
    }))
    const manager = newManager(deps, document.body)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    socket.fire("call:transport_transfer_changed", { callId: "call_1", version: 2 })
    await vi.waitFor(() => {
      expect(deps.getCallSnapshot).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_1" })
      expect(deps.createTransport).toHaveBeenCalledTimes(2)
      expect(transport.connect).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }))
    })
  })

  it("should keep source playback and delay switched acknowledgement until ended target media recovers", async () => {
    const socket = makeSocket()
    const source = makeTransport()
    const target = makeTransport()
    const deps = makeDeps(socket, source)
    vi.mocked(deps.createTransport).mockReturnValueOnce(source).mockReturnValueOnce(target)
    deps.acknowledgeTransferReady = vi.fn(async () => ({}))
    deps.acknowledgeTransferSwitched = vi.fn(async () => ({}))
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(private readonly tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio")
        }
      }
    )
    const container = document.createElement("div")
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    const manager = newManager(deps, container)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const roster = [
      participant({
        epoch: 1,
        mediaIncarnation: "inc_peer",
        publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "source_mic", transportGeneration: 1 }],
      }),
    ]
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster })
    const sourceTrack = makeTrack("audio")
    source.onRemoteTrack?.({
      ref: { endpointId: "ep_peer", kind: "mic", publicationId: "source_mic" },
      track: sourceTrack,
    })
    const preparing = transferSnapshot("preparing", 1)
    preparing.obligations[0]!.switched = false
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster, transfer: preparing })
    await vi.waitFor(() => expect(target.syncPeers).toHaveBeenCalled())
    const targetRef = { endpointId: "ep_peer", kind: "mic" as const, publicationId: "target_mic" }
    const endedTargetTrack = makeTrack("audio")
    target.onRemoteTrack?.({ ref: targetRef, track: endedTargetTrack })
    await vi.waitFor(() => expect(deps.acknowledgeTransferReady).toHaveBeenCalledTimes(1))

    target.onRemoteTrackEnded?.(targetRef)
    const committing = transferSnapshot("committing", 2)
    committing.obligations[0]!.switched = false
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster, transfer: committing })
    await vi.waitFor(() => expect(target.syncPeers).toHaveBeenCalledTimes(2))

    expect({
      switchedAcks: vi.mocked(deps.acknowledgeTransferSwitched).mock.calls.length,
      sourceCloseCalls: vi.mocked(source.close).mock.calls.length,
      output: (container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks(),
      audioOutputs: container.querySelectorAll("audio").length,
    }).toEqual({ switchedAcks: 0, sourceCloseCalls: 0, output: [sourceTrack], audioOutputs: 1 })

    const recoveredTargetTrack = makeTrack("audio")
    target.onRemoteTrack?.({ ref: targetRef, track: recoveredTargetTrack })
    await vi.waitFor(() => expect(deps.acknowledgeTransferSwitched).toHaveBeenCalledTimes(1))
    expect({
      output: (container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks(),
      audioOutputs: container.querySelectorAll("audio").length,
    }).toEqual({ output: [recoveredTargetTrack], audioOutputs: 1 })
  })

  it("should retry the exact switched acknowledgement after a lost response without a server mutation", async () => {
    const socket = makeSocket()
    const source = makeTransport()
    const target = makeTransport()
    const deps = makeDeps(socket, source)
    vi.mocked(deps.createTransport).mockReturnValueOnce(source).mockReturnValueOnce(target)
    const committing = transferSnapshot("committing", 2)
    committing.obligations[0]!.switched = false
    committing.obligations[0]!.expectedPublications = []
    deps.acknowledgeTransferSwitched = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({})
    deps.getCallSnapshot = vi.fn(async () => ({
      call: {
        id: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "audio_only" as const,
        mediaTransport: "sfu" as const,
        transportGeneration: 1,
      },
      created: false,
      participant: { id: "p_1" },
      endpoint: { id: "ep_1" },
      chatAnchorId: "event_chat_1",
      rosterVersion: 0,
      roster: [],
      transfer: committing,
    }))
    const manager = newManager(deps, document.body)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster: [], transfer: committing })
    await vi.waitFor(() => expect(deps.acknowledgeTransferSwitched).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(deps.acknowledgeTransferSwitched).toHaveBeenCalledTimes(2), {
      timeout: PULL_RETRY_DELAY_MS + 1000,
    })

    expect(vi.mocked(deps.acknowledgeTransferSwitched).mock.calls.map(([call]) => call.body)).toEqual([
      vi.mocked(deps.acknowledgeTransferSwitched).mock.calls[0]![0].body,
      vi.mocked(deps.acknowledgeTransferSwitched).mock.calls[0]![0].body,
    ])
  })

  it("should rebuild target setup when the authoritative retry has the same version", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const source = makeTransport()
    const failedTarget = makeTransport()
    failedTarget.connect = vi.fn().mockRejectedValueOnce(new Error("credentials unavailable"))
    const repairedTarget = makeTransport()
    const deps = makeDeps(socket, source)
    vi.mocked(deps.createTransport)
      .mockReturnValueOnce(source)
      .mockReturnValueOnce(failedTarget)
      .mockReturnValueOnce(repairedTarget)
    const preparing = transferSnapshot("preparing", 1)
    deps.getCallSnapshot = vi.fn(async () => ({
      call: {
        id: "call_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "audio_only" as const,
        mediaTransport: "sfu" as const,
        transportGeneration: 1,
      },
      created: false,
      participant: { id: "p_1" },
      endpoint: { id: "ep_1" },
      chatAnchorId: "event_chat_1",
      rosterVersion: 0,
      roster: [],
      transfer: preparing,
    }))
    const manager = newManager(deps, document.body)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 0, roster: [], transfer: preparing })
    await vi.waitFor(() => expect(failedTarget.close).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(PULL_RETRY_DELAY_MS)
    await vi.waitFor(() => expect(repairedTarget.connect).toHaveBeenCalledTimes(1))

    expect(repairedTarget.publish).toHaveBeenCalledWith("mic", expect.anything())
  })

  it("should acknowledge source restoration only after usable playback and retain target until failed", async () => {
    const socket = makeSocket()
    const source = makeTransport()
    const target = makeTransport()
    const deps = makeDeps(socket, source)
    vi.mocked(deps.createTransport).mockReturnValueOnce(source).mockReturnValueOnce(target)
    deps.acknowledgeTransferRestored = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({})
    const container = document.createElement("div")
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(private readonly tracks: MediaStreamTrack[]) {}
        getAudioTracks() {
          return this.tracks.filter((track) => track.kind === "audio")
        }
      }
    )
    const manager = newManager(deps, container)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const roster = [
      participant({
        epoch: 1,
        mediaIncarnation: "inc_peer",
        publishedTracks: [{ kind: "mic", trackName: "peer:mic", publicationId: "source_mic", transportGeneration: 1 }],
      }),
    ]
    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster })
    const sourceTrack = makeTrack("audio")
    source.onRemoteTrack?.({
      ref: { endpointId: "ep_peer", kind: "mic", publicationId: "source_mic" },
      track: sourceTrack,
    })

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 1,
      roster,
      transfer: transferSnapshot("preparing", 1),
    })
    await vi.waitFor(() => expect(target.syncPeers).toHaveBeenCalled())
    const targetTrack = makeTrack("audio")
    target.onRemoteTrack?.({
      ref: { endpointId: "ep_peer", kind: "mic", publicationId: "target_mic" },
      track: targetTrack,
    })
    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 1,
      roster,
      transfer: transferSnapshot("committing", 2),
    })
    await vi.waitFor(() =>
      expect((container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks()[0]).toBe(targetTrack)
    )

    socket.fire("call:roster", {
      callId: "call_1",
      rosterVersion: 1,
      roster,
      transfer: transferSnapshot("aborting", 3),
    })
    await vi.waitFor(() => expect(deps.acknowledgeTransferRestored).toHaveBeenCalledTimes(2))
    expect({
      bodies: vi.mocked(deps.acknowledgeTransferRestored).mock.calls.map(([call]) => call.body),
      restoredTrack: (container.querySelector("audio")?.srcObject as MediaStream).getAudioTracks()[0],
      targetCloseCalls: vi.mocked(target.close).mock.calls.length,
    }).toEqual({
      bodies: [
        {
          transferId: "callxfer_1",
          generation: 2,
          endpointId: "ep_1",
          endpointEpoch: 1,
          mediaIncarnation: "inc-1",
          membershipRevision: 4,
          trackRevision: 1,
        },
        {
          transferId: "callxfer_1",
          generation: 2,
          endpointId: "ep_1",
          endpointEpoch: 1,
          mediaIncarnation: "inc-1",
          membershipRevision: 4,
          trackRevision: 1,
        },
      ],
      restoredTrack: sourceTrack,
      targetCloseCalls: 0,
    })

    socket.fire("call:roster", { callId: "call_1", rosterVersion: 1, roster, transfer: transferSnapshot("failed", 4) })
    await vi.waitFor(() => expect(target.close).toHaveBeenCalledTimes(1))
  })

  it("transient socket reconnect rejoins with the SAME incarnation", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)
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
    const manager = newManager(deps, null)
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
    const manager = newManager(makeDeps(socket, transport), null)

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
    const manager = newManager(makeDeps(socket, transport), null)
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
    const manager = newManager(deps, null)

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
    const manager = newManager(deps, null)
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

  // ── camera selection + mobile flip ──────────────────────────────────────────

  it("switchCameraDevice writes selectedCameraId and recaptures video with the exact deviceId", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    await manager.setCameraOn(true)

    await manager.switchCameraDevice("cam-2")

    expect(getCallState().local.devices.selectedCameraId).toBe("cam-2")
    expect(getCallState().local.devices.facingMode).toBeNull()
    // Recaptures mic+camera in one stream (iOS rule) with the chosen camera; the
    // whole constraints object is asserted in one comparison (INV-24).
    expect(lastAcquireConstraints(deps)).toEqual({
      audio: AUDIO_CAPTURE_CONSTRAINTS,
      video: { ...VIDEO_CAPTURE_CONSTRAINTS, deviceId: { exact: "cam-2" } },
    })
    // The video track was republished (not dropped) and the call stays up.
    expect(transport._events.filter((e) => e === "publish:camera").length).toBeGreaterThanOrEqual(2)
    expect(manager.isActive()).toBe(true)
  })

  it("switchCameraDevice with the camera off stores the pref and applies it on the next setCameraOn", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)
    // Join defaults to camera-off, so the switch only records the preference.
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    await manager.switchCameraDevice("cam-9")

    expect(getCallState().local.devices.selectedCameraId).toBe("cam-9")
    // No recapture while the camera is off — only the join's mic acquisition ran.
    expect(deps.acquireUserMedia).toHaveBeenCalledTimes(1)
    expect(transport._events).not.toContain("publish:camera")

    await manager.setCameraOn(true)
    expect(lastAcquireConstraints(deps)).toEqual({
      audio: AUDIO_CAPTURE_CONSTRAINTS,
      video: { ...VIDEO_CAPTURE_CONSTRAINTS, deviceId: { exact: "cam-9" } },
    })
  })

  it("flipCamera toggles facingMode, clears the deviceId pref, and recaptures video", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
    // Seed an explicit device pref, then turn the camera on with it.
    await manager.switchCameraDevice("cam-1")
    await manager.setCameraOn(true)

    await manager.flipCamera()

    // First flip goes to the back camera and clears the explicit deviceId.
    expect(getCallState().local.devices.facingMode).toBe("environment")
    expect(getCallState().local.devices.selectedCameraId).toBeNull()
    expect(lastAcquireConstraints(deps)).toEqual({
      audio: AUDIO_CAPTURE_CONSTRAINTS,
      video: { ...VIDEO_CAPTURE_CONSTRAINTS, facingMode: "environment" },
    })

    // A second flip toggles back to the front camera.
    await manager.flipCamera()
    expect(getCallState().local.devices.facingMode).toBe("user")
    expect(lastAcquireConstraints(deps)).toEqual({
      audio: AUDIO_CAPTURE_CONSTRAINTS,
      video: { ...VIDEO_CAPTURE_CONSTRAINTS, facingMode: "user" },
    })
  })

  it("iOS mid-call recapture failure rolls back to the prior capture with a typed error", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    deps.singleActiveCapture = true
    let calls = 0
    ;(deps.acquireUserMedia as ReturnType<typeof vi.fn>).mockImplementation(async (c: MediaStreamConstraints) => {
      calls++
      // The device-switch acquire fails (NotReadableError); the rollback re-acquire succeeds.
      if (calls === 2) throw Object.assign(new Error("device busy"), { name: "NotReadableError" })
      const kinds: Array<"audio" | "video"> = ["audio"]
      if (c.video) kinds.push("video")
      return makeStream(kinds)
    })
    const manager = newManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    const err = await manager.switchInputDevice("dev-x").catch((e) => e)
    expect(err).toBeInstanceOf(CallCaptureError)
    expect(err.code).toBe("capture_failed")

    // Startup + failed switch + rollback re-acquire = 3 getUserMedia calls; audio restored.
    expect(deps.acquireUserMedia).toHaveBeenCalledTimes(3)
    expect(manager.isActive()).toBe(true)
    // The store surfaces the typed failure with its taxonomy class for the UI.
    expect(getCallState().captureError).toMatchObject({ code: "capture_failed", kind: "device_busy" })
  })

  it("a roster event dispatched before hangupSync no-ops after the flush", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
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

  // ── F1: a failed/cancelled start settles the server (no ghost endpoint / ring) ──

  it("F1: a socket-join failure after the REST start settles the server via REST self-leave", async () => {
    const socket = makeSocket()
    socket.failJoin = true
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)

    await expect(manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })).rejects.toThrow()

    expect(manager.isActive()).toBe(false)
    // The REST start admitted the participant + leased the endpoint before the join
    // failed; the self-leave closes it so the endpoint isn't a ~45s zombie / the DM
    // peer keeps ringing.
    expect(deps.leaveCallRest).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_1" })
  })

  it("F1: a cancel during joining also settles the server via REST self-leave", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    // Park at acquireWakeLock (session already exists) so the cancel lands after the
    // REST start — exercising rollbackStart's session branch (emitLeave + REST).
    let releaseWake: () => void = () => {}
    ;(deps.requestWakeLock as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseWake = () => resolve(null)
        })
    )
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await new Promise((r) => setTimeout(r, 0))

    const leaving = manager.leaveCall()
    releaseWake()
    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    await leaving

    expect(manager.isActive()).toBe(false)
    expect(deps.leaveCallRest).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_1" })
  })

  it("should self-leave exactly once when leaveCall cancels before a successful REST response", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    let resolveStart: (response: ReturnType<typeof startResponse>) => void = () => {}
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await manager.leaveCall()
    resolveStart(startResponse({ callId: "call_late_leave" }))

    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    expect(deps.leaveCallRest).toHaveBeenCalledTimes(1)
    expect(deps.leaveCallRest).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_late_leave" })
    expect(deps.connectSocket).not.toHaveBeenCalled()
    expect(deps.createTransport).not.toHaveBeenCalled()
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
  })

  it("should settle a late admission after an account flush without starting local media", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    let resolveStart: (response: ReturnType<typeof startResponse>) => void = () => {}
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    resetCallStoreCache()
    resolveStart(startResponse({ callId: "call_late_flush" }))

    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    expect(deps.leaveCallRest).toHaveBeenCalledTimes(1)
    expect(deps.leaveCallRest).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_late_flush" })
    expect(deps.connectSocket).not.toHaveBeenCalled()
    expect(deps.createTransport).not.toHaveBeenCalled()
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
  })

  it("should not admit a replacement until cancelled-start cleanup finishes", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    let resolveStart: (response: ReturnType<typeof startResponse>) => void = () => {}
    let rejectLeave: (error: Error) => void = () => {}
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve
        })
    )
    ;(deps.leaveCallRest as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectLeave = reject
        })
    )
    const manager = newManager(deps, null)

    const cancelled = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await manager.leaveCall()
    resolveStart(startResponse({ callId: "call_cancelled" }))
    await vi.waitFor(() => expect(deps.leaveCallRest).toHaveBeenCalledTimes(1))
    expect(deps.leaveCallRest).toHaveBeenCalledWith({ workspaceId: "ws_1", callId: "call_cancelled" })

    expect(() => manager.startCall({ workspaceId: "ws_1", streamId: "stream_2", mode: "audio_only" })).toThrow(
      "A call is already active"
    )
    expect(deps.startCallRest).toHaveBeenCalledTimes(1)

    rejectLeave(new Error("cleanup failed"))
    await expect(cancelled).rejects.toBeInstanceOf(CallStartCancelledError)
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      startResponse({ callId: "call_replacement", streamId: "stream_2" })
    )
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_2", mode: "audio_only" })
    expect(manager.isActive()).toBe(true)
    expect(getCallState()).toMatchObject({ callId: "call_replacement", streamId: "stream_2", phase: "connected" })
    expect(deps.startCallRest).toHaveBeenCalledTimes(2)
    expect(deps.leaveCallRest).toHaveBeenCalledTimes(1)
  })

  it("F1: a failure BEFORE the REST response does NOT self-leave (no callId, nothing admitted)", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network down"))
    const manager = newManager(deps, null)

    await expect(manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })).rejects.toThrow(
      /network down/
    )

    expect(manager.isActive()).toBe(false)
    expect(deps.leaveCallRest).not.toHaveBeenCalled()
  })

  // ── F2: account switch cancels an in-flight start (no hot mic under new account) ──

  it("F2: an account flush mid-start cancels the in-flight start (mic never acquired)", async () => {
    const socket = makeSocket()
    socket.deferJoin = true
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    // Park at the socket join — `starting` is true with no session yet.
    await new Promise((r) => setTimeout(r, 0))
    expect(socket.pendingJoinAck).not.toBeNull()
    expect(manager.isActive()).toBe(false)

    // Account switch / logout flush → hangupSync during the joining window.
    resetCallStoreCache()

    // The parked join resolves late; the gen bump makes its continuation roll back
    // rather than create a session under the just-switched-to account.
    socket.pendingJoinAck?.({ ok: true, data: socket.joinAck })
    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)

    expect(manager.isActive()).toBe(false)
    // Capture is downstream of the cancelled join — the mic is never acquired.
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
  })

  // ── F3: a reconnect that returns a different endpoint id must not stay connected ──

  it("F3: a reconnect returning a NEW endpoint id tears down and says the connection was lost", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    expect(getCallState().phase).toBe("connected")

    // The old endpoint was reaped during the drop; the reconnect mints a fresh id.
    socket.joinAck = { ...socket.joinAck, endpointId: "ep_2" }
    socket.fire("disconnect")
    expect(getCallState().phase).toBe("reconnecting")
    socket.fire("connect")
    await new Promise((r) => setTimeout(r, 0))

    // The transport is bound to the old endpoint — a changed id is unrecoverable.
    expect(manager.isActive()).toBe(false)
    expect(getCallState().phase).toBe("idle")
    // Never a silent vanish — and never a takeover claim: the page never froze, so
    // the lease most likely lapsed across a network gap. Only the endpoint-closed
    // push can name another device.
    expect(getCallState().displacedCall).toEqual({
      callId: "call_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "audio_only",
      reason: "connection_lost",
    })
  })

  it("F3: the same reconnect after a freeze says the call ended while the page was away", async () => {
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    document.dispatchEvent(new Event("freeze"))
    socket.joinAck = { ...socket.joinAck, endpointId: "ep_2" }
    socket.fire("disconnect")
    socket.fire("connect")
    await new Promise((r) => setTimeout(r, 0))

    expect(getCallState().displacedCall).toMatchObject({ callId: "call_1", reason: "ended_while_away" })
  })

  it("F3: a pagehide is the same evidence as a freeze", async () => {
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    window.dispatchEvent(new Event("pagehide"))
    socket.joinAck = { ...socket.joinAck, endpointId: "ep_2" }
    socket.fire("disconnect")
    socket.fire("connect")
    await new Promise((r) => setTimeout(r, 0))

    expect(getCallState().displacedCall).toMatchObject({ reason: "ended_while_away" })
  })

  it("F3: a rejoin that fails outright says so instead of vanishing", async () => {
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    document.dispatchEvent(new Event("freeze"))
    socket.failJoin = true
    socket.fire("disconnect")
    socket.fire("connect")
    await new Promise((r) => setTimeout(r, 0))

    expect(getCallState().phase).toBe("idle")
    expect(getCallState().displacedCall).toMatchObject({ callId: "call_1", reason: "ended_while_away" })
  })

  it("F3: leaving during an in-flight rejoin ends the call without a notice", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    // Reconnecting, rejoin ack outstanding, and the user gives up and hangs up.
    // The link is dead both ways, so the leave ack never comes back either and
    // `emitLeave` holds the session for its full 2s timeout.
    socket.deferJoin = true
    socket.joinAck = { ...socket.joinAck, endpointId: "ep_2" }
    socket.fire("disconnect")
    socket.fire("connect")
    const emit = socket.emit
    socket.emit = ((event: string, payload: unknown, ack?: (r: unknown) => void) => {
      if (event === "call:leave") return
      emit.call(socket, event, payload, ack)
    }) as CallSocket["emit"]

    const leaving = manager.leaveCall()
    // Mid-leave, the rejoin lands with a new endpoint id. A deliberate hangup
    // must not be explained away as the call having gone somewhere.
    socket.pendingJoinAck?.({ ok: true, data: socket.joinAck })
    await vi.advanceTimersByTimeAsync(2_000)
    await leaving

    expect(getCallState().displacedCall).toBeNull()
  })

  it("F3: a successful lease renew clears the suspended evidence, so a later loss is not blamed on the lock", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    document.dispatchEvent(new Event("freeze"))
    vi.advanceTimersByTime(15_000)
    socket.leaseRenewAck = { ok: false, code: "CALL_LEASE_SUPERSEDED" }
    vi.advanceTimersByTime(15_000)
    await vi.waitFor(() => expect(getCallState().phase).toBe("idle"))

    // The renew proved the lease survived the freeze, so whatever killed it after
    // that is not the lock — and is still not evidence of another device.
    expect(getCallState().displacedCall).toMatchObject({ reason: "connection_lost" })
  })

  it("F3: a lease superseded while still suspended reads as ended-while-away", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })

    document.dispatchEvent(new Event("freeze"))
    socket.leaseRenewAck = { ok: false, code: "CALL_LEASE_SUPERSEDED" }
    vi.advanceTimersByTime(15_000)
    await vi.waitFor(() => expect(getCallState().phase).toBe("idle"))

    expect(getCallState().displacedCall).toMatchObject({ reason: "ended_while_away" })
  })

  it("F3: the endpoint-closed push stays a takeover even after a freeze", async () => {
    const socket = makeSocket()
    const manager = newManager(makeDeps(socket, makeTransport()), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    // The server addressed this endpoint under the call-row lock: unambiguous,
    // whatever the page was doing.
    document.dispatchEvent(new Event("freeze"))
    socket.fire("call:endpoint:closed", { callId: "call_1", endpointId: "ep_1", reason: "taken_over" })
    await vi.waitFor(() => expect(getCallState().phase).toBe("idle"))

    expect(getCallState().displacedCall).toMatchObject({ reason: "taken_over" })
  })

  it("should preserve the shared SFU bandwidth ladder", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    vi.mocked(transport.getStats).mockResolvedValue({
      rttMs: 10,
      packetLoss: 0,
      qualityLimitation: "bandwidth",
      encodeTimeMs: 1,
    })
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })
    vi.mocked(transport.setPublishEncoding).mockClear()

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS)

    expect(transport.setPublishEncoding).toHaveBeenCalledWith("camera", { maxBitrate: 700_000 })
  })

  it("should recover a shared CPU downgrade while one P2P peer remains bandwidth limited", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    socket.joinAck.mediaTransport = "p2p"
    const transport = makeTransport()
    transport.setPeerPublishEncoding = vi.fn(async () => {})
    const peerStats = (qualityLimitation: "none" | "bandwidth" | "cpu") => ({
      endpointId: "ep_slow",
      candidateType: "host" as const,
      rttMs: 10,
      packetLoss: 0,
      qualityLimitation,
      encodeTimeMs: 1,
      intervalBytesSent: 1,
      intervalBytesReceived: 1,
    })
    vi.mocked(transport.getStats)
      .mockResolvedValueOnce({
        rttMs: 10,
        packetLoss: 0,
        qualityLimitation: "cpu",
        encodeTimeMs: 1,
        peers: [peerStats("cpu")],
      })
      .mockResolvedValue({
        rttMs: 10,
        packetLoss: 0,
        qualityLimitation: "bandwidth",
        encodeTimeMs: 1,
        peers: [peerStats("bandwidth")],
      })
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })
    vi.mocked(transport.setPublishEncoding).mockClear()

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS)
    expect(transport.setPublishEncoding).toHaveBeenLastCalledWith("camera", { maxBitrate: 700_000 })

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS * WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE)
    expect(transport.setPublishEncoding).toHaveBeenLastCalledWith("camera", { maxBitrate: 1_500_000 })
  })

  it("should serialize P2P watchdog samples while an encoder update is pending", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    socket.joinAck.mediaTransport = "p2p"
    const transport = makeTransport()
    let resolveEncoding!: () => void
    transport.setPeerPublishEncoding = vi.fn(() => new Promise<void>((resolve) => (resolveEncoding = resolve)))
    vi.mocked(transport.getStats).mockResolvedValue({
      rttMs: 10,
      packetLoss: 0,
      qualityLimitation: "bandwidth",
      encodeTimeMs: 1,
      peers: [
        {
          endpointId: "ep_slow",
          candidateType: "host",
          rttMs: 10,
          packetLoss: 0,
          qualityLimitation: "bandwidth",
          encodeTimeMs: 1,
          intervalBytesSent: 1,
          intervalBytesReceived: 1,
        },
      ],
    })
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS)
    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS)
    expect(transport.getStats).toHaveBeenCalledTimes(1)

    resolveEncoding()
    await vi.runOnlyPendingTimersAsync()
    expect(transport.getStats).toHaveBeenCalledTimes(2)
  })

  it("should adapt only the bandwidth-limited P2P sender and recover it after clean samples", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    socket.joinAck.mediaTransport = "p2p"
    const transport = makeTransport()
    transport.setPeerPublishEncoding = vi.fn(async () => {})
    const peerStats = (endpointId: string, qualityLimitation: "none" | "bandwidth") => ({
      endpointId,
      candidateType: "host" as const,
      rttMs: 10,
      packetLoss: 0,
      qualityLimitation,
      encodeTimeMs: 1,
      intervalBytesSent: 1,
      intervalBytesReceived: 1,
    })
    vi.mocked(transport.getStats)
      .mockResolvedValueOnce({
        rttMs: 10,
        packetLoss: 0,
        qualityLimitation: "bandwidth",
        encodeTimeMs: 1,
        peers: [peerStats("ep_slow", "bandwidth"), peerStats("ep_healthy", "none")],
      })
      .mockResolvedValue({
        rttMs: 10,
        packetLoss: 0,
        qualityLimitation: "none",
        encodeTimeMs: 1,
        peers: [peerStats("ep_slow", "none"), peerStats("ep_healthy", "none")],
      })
    const manager = newManager(makeDeps(socket, transport), null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })
    vi.mocked(transport.setPublishEncoding).mockClear()

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS)
    expect(transport.setPeerPublishEncoding).toHaveBeenCalledTimes(1)
    expect(transport.setPeerPublishEncoding).toHaveBeenLastCalledWith("ep_slow", "camera", { maxBitrate: 700_000 })
    expect(transport.setPublishEncoding).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(WATCHDOG_SAMPLE_MS * WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE)
    expect(transport.setPeerPublishEncoding).toHaveBeenLastCalledWith("ep_slow", "camera", { maxBitrate: 1_500_000 })
    expect(transport.setPeerPublishEncoding).toHaveBeenCalledTimes(2)
    expect(transport.setPublishEncoding).not.toHaveBeenCalled()
  })

  // ── F4: a failed camera publish must not leave a live undisclosed camera track ──

  it("F4: a failed camera publish stops the camera track, keeps camera off, and leaves the mic live", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    // Holder object (not `let`): property reads aren't CFA-narrowed to null across
    // the closure assignment, so the assertions below stay typed as the track.
    const captured: { mic: MediaStreamTrack | null; camera: MediaStreamTrack | null } = { mic: null, camera: null }
    ;(deps.acquireUserMedia as ReturnType<typeof vi.fn>).mockImplementation(async (c: MediaStreamConstraints) => {
      const kinds: Array<"audio" | "video"> = ["audio"]
      if (c.video) kinds.push("video")
      const stream = makeStream(kinds)
      captured.mic = stream.getAudioTracks()[0]
      if (c.video) captured.camera = stream.getVideoTracks()[0]
      return stream
    })
    ;(transport.publish as ReturnType<typeof vi.fn>).mockImplementation(async (kind: string) => {
      if (kind === "camera") throw new Error("camera publish rejected")
      transport._events.push(`publish:${kind}`)
    })
    const manager = newManager(deps, null)
    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })

    const err = await manager.setCameraOn(true).catch((e) => e)
    expect(err).toBeInstanceOf(CallCaptureError)
    expect(err.code).toBe("capture_failed")

    // The live camera track is stopped, so the UI's camera-off truth matches the LED.
    expect(captured.camera?.stop).toHaveBeenCalled()
    expect(getCallState().local.cameraOn).toBe(false)
    expect(getCallState().captureError).toMatchObject({ code: "capture_failed" })
    // The mic published in the same recapture survives — only the camera was rolled back.
    expect(captured.mic?.stop).not.toHaveBeenCalled()
    expect(manager.isActive()).toBe(true)
  })

  // ── F5: ring acceptance binds to the invitation's call (expectedCallId) ──

  it("F5: threads expectedCallId to the REST start", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const manager = newManager(deps, null)

    await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", expectedCallId: "call_ring" })

    expect(deps.startCallRest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "video",
        expectedCallId: "call_ring",
      })
    )
  })

  it("F5: a 409 CALL_ENDED from the bound start leaves no session and does not self-leave", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    ;(deps.startCallRest as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(409, "CALL_ENDED", "Call ended"))
    const manager = newManager(deps, null)

    const err = await manager
      .startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", expectedCallId: "call_gone" })
      .catch((e) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe("CALL_ENDED")
    expect(manager.isActive()).toBe(false)
    expect(getCallState().phase).toBe("idle")
    // The bound start 409'd before admitting us — there is nothing to self-leave.
    expect(deps.leaveCallRest).not.toHaveBeenCalled()
  })

  // ── lock-screen media session ──────────────────────────────────────────────

  describe("media session", () => {
    async function startedWithMediaSession(overrides: { mode?: "audio_only" | "video" } = {}) {
      const socket = makeSocket()
      const transport = makeTransport()
      const mediaSession = makeMediaSession(transport._events)
      const deps = makeDeps(socket, transport, mediaSession)
      const manager = newManager(deps, null)
      await manager.startCall({
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: overrides.mode ?? "audio_only",
      })
      return { manager, socket, transport, mediaSession }
    }

    it("activates the session before the transport connects, so a ringing-out call already owns one", async () => {
      const { transport, mediaSession } = await startedWithMediaSession()

      expect(mediaSession.activate).toHaveBeenCalledWith({ title: "Call", subtitle: "Threa" })
      // Activation precedes both the transport connect and the first capture.
      expect(transport._events.indexOf("mediaSession:activate")).toBe(0)
      expect(transport._events.slice(0, 3)).toEqual(["mediaSession:activate", "connect", "publish:mic"])
    })

    it("the registered hangup handler leaves the call for real", async () => {
      const { manager, socket, mediaSession } = await startedWithMediaSession()
      socket.emitted.length = 0

      mediaSession.handlers?.hangup?.()
      await new Promise((r) => setTimeout(r, 0))

      expect(socket.emitted.map((e) => e.event)).toContain("call:leave")
      expect(manager.isActive()).toBe(false)
    })

    it("shows only hang-up while ringing out, then the toggles the call can actually honour", async () => {
      const { mediaSession } = await startedWithMediaSession()

      // In the gesture the session does not exist yet, so setMuted/setCameraOn
      // would no-op; an audio-only call never gets a camera button at all.
      expect(mediaSession.registered).toEqual([
        { hangup: true, toggleMicrophone: false, toggleCamera: false },
        { hangup: true, toggleMicrophone: true, toggleCamera: false },
      ])
    })

    it("registers the camera toggle on a video call", async () => {
      const { mediaSession } = await startedWithMediaSession({ mode: "video" })

      expect(mediaSession.registered.at(-1)).toEqual({
        hangup: true,
        toggleMicrophone: true,
        toggleCamera: true,
      })
    })

    it("seeds the toggles from the live call, so the notification never opens showing it muted", async () => {
      const { mediaSession } = await startedWithMediaSession()

      // The API's toggles default to inactive; unseeded, the first lock-screen tap
      // reads as "unmute" and mutes.
      expect(mediaSession.setMicrophoneActive).toHaveBeenCalledWith(true)
      expect(mediaSession.setCameraActive).toHaveBeenCalledWith(false)
    })

    it("seeds the camera toggle from a camera-on join, not from the pre-call default", async () => {
      const socket = makeSocket()
      const transport = makeTransport()
      const mediaSession = makeMediaSession(transport._events)
      const manager = newManager(makeDeps(socket, transport, mediaSession), null)

      await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video", cameraOn: true })

      // `runStart` sets `local.cameraOn` directly for a "Start with camera" join —
      // it never goes through `setCameraOn`, the only other mirror — so seeding
      // before that lands would claim camera-off on a call publishing video.
      expect(mediaSession.setCameraActive).toHaveBeenCalledWith(true)
      expect(mediaSession.setCameraActive).not.toHaveBeenCalledWith(false)
    })

    it("mirrors mute and camera state onto the notification toggles", async () => {
      const { manager, mediaSession } = await startedWithMediaSession({ mode: "video" })

      manager.setMuted(true)
      await manager.setCameraOn(true)

      expect(mediaSession.setMicrophoneActive).toHaveBeenCalledWith(false)
      expect(mediaSession.setCameraActive).toHaveBeenCalledWith(true)
    })

    it("setCallTitle pushes the resolved stream label at the live session", async () => {
      const { manager, mediaSession } = await startedWithMediaSession()

      manager.setCallTitle("#design")

      expect(mediaSession.setTitle).toHaveBeenCalledWith("#design")
    })

    it("leaveCall releases the session exactly once", async () => {
      const { manager, mediaSession } = await startedWithMediaSession()

      await manager.leaveCall()

      expect(mediaSession.releases).toBe(1)
    })

    it("the store-flush hangupSync path releases the session exactly once", async () => {
      const { manager, mediaSession } = await startedWithMediaSession()

      // Account switch / logout flush → hangupSync.
      resetCallStoreCache()

      expect(manager.isActive()).toBe(false)
      expect(mediaSession.releases).toBe(1)
    })

    it("a later call on the same manager never opens under the previous call's label", async () => {
      const { manager, mediaSession } = await startedWithMediaSession()
      manager.setCallTitle("Grace")
      await manager.leaveCall()

      await manager.startCall({ workspaceId: "ws_1", streamId: "stream_2", mode: "audio_only" })

      // The dock pushes the real label once the name resolves; until then the
      // notification must not claim this call is with whoever the last one was.
      expect(mediaSession.setTitle).toHaveBeenCalledWith("Grace")
      expect(mediaSession.activations).toEqual([
        { title: "Call", subtitle: "Threa" },
        { title: "Call", subtitle: "Threa" },
      ])
    })

    it("an unsupported platform (null media session) leaves the whole start path working", async () => {
      const socket = makeSocket()
      const transport = makeTransport()
      const deps = makeDeps(socket, transport, null)
      const manager = newManager(deps, null)

      await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "video" })
      manager.setMuted(true)
      manager.setCallTitle("#design")
      await manager.setCameraOn(true)

      expect(getCallState().phase).toBe("connected")
      expect(manager.isActive()).toBe(true)
    })
  })

  // ── lifecycle log (diagnostic only — no behavior reads it) ─────────────────

  describe("lifecycle log", () => {
    function kinds(): string[] {
      return getCallLifecycleEvents().map((e) => e.kind)
    }

    async function startedManager(socket: FakeSocket, transport: MediaTransport) {
      const manager = newManager(makeDeps(socket, transport), null)
      await manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
      clearCallLifecycleLog()
      return manager
    }

    function setVisibility(value: DocumentVisibilityState): void {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value })
    }

    beforeEach(() => {
      clearCallLifecycleLog()
    })
    afterEach(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" })
      clearCallLifecycleLog()
    })

    it("records page-lifecycle events from document and window", async () => {
      await startedManager(makeSocket(), makeTransport())

      setVisibility("hidden")
      document.dispatchEvent(new Event("visibilitychange"))
      setVisibility("visible")
      document.dispatchEvent(new Event("visibilitychange"))
      document.dispatchEvent(new Event("freeze"))
      document.dispatchEvent(new Event("resume"))
      window.dispatchEvent(new Event("pagehide"))
      window.dispatchEvent(new Event("pageshow"))

      expect(kinds()).toEqual(["hidden", "visible", "freeze", "resume", "pagehide", "pageshow"])
    })

    it("records a socket drop and a rejoin onto the same endpoint", async () => {
      const socket = makeSocket()
      await startedManager(socket, makeTransport())

      socket.fire("disconnect")
      socket.fire("connect")
      await new Promise((r) => setTimeout(r, 0))

      expect(kinds()).toEqual(["socket_disconnect", "socket_connect", "rejoin_same_endpoint"])
    })

    it("records a rejoin that returns a different endpoint id", async () => {
      const socket = makeSocket()
      await startedManager(socket, makeTransport())

      socket.joinAck = { ...socket.joinAck, endpointId: "ep_2" }
      socket.fire("disconnect")
      socket.fire("connect")
      await new Promise((r) => setTimeout(r, 0))

      expect(getCallLifecycleEvents().map((e) => ({ kind: e.kind, detail: e.detail }))).toEqual([
        { kind: "socket_disconnect", detail: undefined },
        { kind: "socket_connect", detail: undefined },
        { kind: "rejoin_new_endpoint", detail: "ep_2" },
        { kind: "teardown", detail: undefined },
      ])
    })

    it("records a failed rejoin", async () => {
      const socket = makeSocket()
      await startedManager(socket, makeTransport())

      socket.failJoin = true
      socket.fire("disconnect")
      socket.fire("connect")
      await new Promise((r) => setTimeout(r, 0))

      expect(kinds()).toEqual(["socket_disconnect", "socket_connect", "rejoin_failed", "teardown"])
    })

    it("records lease renews, with the ack code as the failure detail", async () => {
      vi.useFakeTimers()
      const socket = makeSocket()
      await startedManager(socket, makeTransport())

      vi.advanceTimersByTime(15_000)
      expect(kinds()).toEqual(["lease_renew_ok"])

      socket.leaseRenewAck = { ok: false, code: "CALL_LEASE_SUPERSEDED" }
      vi.advanceTimersByTime(15_000)
      expect(getCallLifecycleEvents().at(1)).toMatchObject({
        kind: "lease_renew_failed",
        detail: "CALL_LEASE_SUPERSEDED",
      })
    })

    it("leak guard: every lifecycle listener is detached on leaveCall", async () => {
      const docAdd = vi.spyOn(document, "addEventListener")
      const docRemove = vi.spyOn(document, "removeEventListener")
      const winAdd = vi.spyOn(window, "addEventListener")
      const winRemove = vi.spyOn(window, "removeEventListener")
      const manager = await startedManager(makeSocket(), makeTransport())

      const lifecycleEvents = new Set(["visibilitychange", "freeze", "resume", "pagehide", "pageshow"])
      const attached = [...docAdd.mock.calls, ...winAdd.mock.calls].filter(([event]) =>
        lifecycleEvents.has(event as string)
      )
      expect(attached.map(([event]) => event)).toEqual(["visibilitychange", "freeze", "resume", "pagehide", "pageshow"])

      await manager.leaveCall()

      // Same handler identity, not just the same event name — a listener left on
      // `document` retains the session closure and stacks per call.
      const detached = [...docRemove.mock.calls, ...winRemove.mock.calls]
      for (const binding of attached) expect(detached).toContainEqual(binding)

      clearCallLifecycleLog()
      document.dispatchEvent(new Event("freeze"))
      window.dispatchEvent(new Event("pagehide"))
      expect(getCallLifecycleEvents()).toEqual([])

      for (const spy of [docAdd, docRemove, winAdd, winRemove]) spy.mockRestore()
    })
  })

  it("should retry admission before capture and pin the observed call id", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    vi.mocked(deps.startCallRest)
      .mockRejectedValueOnce(
        new ApiError(409, "CALL_TRANSPORT_PREPARING", "Preparing", {
          callId: "call_original",
          target: "sfu",
          retryAfterMs: 1,
        })
      )
      .mockResolvedValueOnce({
        ...(await makeDeps(makeSocket(), makeTransport()).startCallRest({
          workspaceId: "ws_1",
          streamId: "stream_1",
          mode: "audio_only",
          mediaIncarnation: "inc-fixture",
        })),
        call: {
          id: "call_original",
          workspaceId: "ws_1",
          streamId: "stream_1",
          mode: "audio_only",
          mediaTransport: "sfu",
          transportGeneration: 1,
        },
      })
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
    await start

    expect(vi.mocked(deps.startCallRest).mock.calls.map(([request]) => request.expectedCallId ?? null)).toEqual([
      null,
      "call_original",
    ])
    expect(deps.acquireUserMedia).toHaveBeenCalledTimes(1)
  })

  it("should stop admission retries at 35 seconds without starting one past the deadline", async () => {
    vi.useFakeTimers()
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const preparing = new ApiError(409, "CALL_TRANSPORT_PREPARING", "Preparing", {
      callId: "call_original",
      target: "sfu",
      retryAfterMs: 1000,
    })
    vi.mocked(deps.startCallRest).mockRejectedValue(preparing)
    const manager = newManager(deps, null)

    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const rejection = expect(start).rejects.toBe(preparing)
    await vi.advanceTimersByTimeAsync(35_000)
    await rejection

    expect(vi.mocked(deps.startCallRest)).toHaveBeenCalledTimes(35)
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
    expect(deps.createTransport).not.toHaveBeenCalled()
  })

  it("should reject when a retry reports a different call id", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    const mismatch = new ApiError(409, "CALL_TRANSPORT_PREPARING", "Preparing", {
      callId: "call_replacement",
      target: "sfu",
      retryAfterMs: 1,
    })
    vi.mocked(deps.startCallRest).mockRejectedValue(mismatch)
    const manager = newManager(deps, null)

    await expect(
      manager.startCall({
        workspaceId: "ws_1",
        streamId: "stream_1",
        mode: "audio_only",
        expectedCallId: "call_original",
      })
    ).rejects.toBe(mismatch)

    expect(deps.startCallRest).toHaveBeenCalledTimes(1)
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
  })

  it("should roll back a successful admission retry that returns after cancellation", async () => {
    const deps = makeDeps(makeSocket(), makeTransport())
    const admitted = await makeDeps(makeSocket(), makeTransport()).startCallRest({
      workspaceId: "ws_1",
      streamId: "stream_1",
      mode: "audio_only",
      mediaIncarnation: "inc-fixture",
    })
    let completeAdmission!: (value: typeof admitted) => void
    vi.mocked(deps.startCallRest)
      .mockRejectedValueOnce(
        new ApiError(409, "CALL_TRANSPORT_PREPARING", "Preparing", {
          callId: "call_original",
          target: "sfu",
          retryAfterMs: 50,
        })
      )
      .mockImplementationOnce(() => new Promise<typeof admitted>((resolve) => (completeAdmission = resolve)))
    const manager = newManager(deps, null)
    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    const rejection = expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    await vi.waitFor(() => expect(deps.startCallRest).toHaveBeenCalledTimes(2))

    await manager.leaveCall()
    completeAdmission({ ...admitted, call: { ...admitted.call, id: "call_original" } })
    await rejection

    expect({
      expectedCallIds: vi.mocked(deps.startCallRest).mock.calls.map(([request]) => request.expectedCallId ?? null),
      leave: vi.mocked(deps.leaveCallRest).mock.calls,
      capture: vi.mocked(deps.acquireUserMedia).mock.calls,
      transport: vi.mocked(deps.createTransport).mock.calls,
      socket: vi.mocked(deps.connectSocket).mock.calls,
    }).toEqual({
      expectedCallIds: [null, "call_original"],
      leave: [[{ workspaceId: "ws_1", callId: "call_original" }]],
      capture: [],
      transport: [],
      socket: [],
    })
  })

  it("should cancel an admission retry without capture", async () => {
    const socket = makeSocket()
    const transport = makeTransport()
    const deps = makeDeps(socket, transport)
    vi.mocked(deps.startCallRest).mockRejectedValue(
      new ApiError(409, "CALL_TRANSPORT_PREPARING", "Preparing", {
        callId: "call_original",
        target: "sfu",
        retryAfterMs: 1000,
      })
    )
    const manager = newManager(deps, null)
    const start = manager.startCall({ workspaceId: "ws_1", streamId: "stream_1", mode: "audio_only" })
    await vi.waitFor(() => expect(deps.startCallRest).toHaveBeenCalledTimes(1))
    await manager.leaveCall()

    await expect(start).rejects.toBeInstanceOf(CallStartCancelledError)
    expect(deps.acquireUserMedia).not.toHaveBeenCalled()
    expect(deps.createTransport).not.toHaveBeenCalled()
  })
})

/** The mic track the manager published — reach it through the publish spy. */
function getMicTrack(transport: MediaTransport): MediaStreamTrack {
  const publish = transport.publish as unknown as ReturnType<typeof vi.fn>
  const micCall = publish.mock.calls.find((c: unknown[]) => c[0] === "mic")
  return micCall?.[1] as MediaStreamTrack
}

/** The constraints of the most recent getUserMedia acquisition. */
function lastAcquireConstraints(deps: CallManagerDeps): MediaStreamConstraints {
  const acquire = deps.acquireUserMedia as unknown as ReturnType<typeof vi.fn>
  return acquire.mock.calls.at(-1)?.[0] as MediaStreamConstraints
}
