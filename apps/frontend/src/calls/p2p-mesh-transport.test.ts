import { afterEach, describe, expect, it, vi } from "vitest"
import { P2pMeshTransport } from "./p2p-mesh-transport"

function makeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    emitted: [] as Array<{ event: string; payload: unknown }>,
    emit(event: string, payload: unknown, ack?: (result: unknown) => void) {
      this.emitted.push({ event, payload })
      ack?.({ ok: true })
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, handler)
    },
    off(event: string) {
      handlers.delete(event)
    },
    fire(event: string, payload: unknown) {
      handlers.get(event)?.(payload)
    },
    hasHandler(event: string) {
      return handlers.has(event)
    },
  }
}

function makePeerConnection() {
  const transceivers: Array<{
    direction: RTCRtpTransceiverDirection
    receiver: { track: { kind: string } }
    sender: {
      replaceTrack: ReturnType<typeof vi.fn>
      getParameters: ReturnType<typeof vi.fn>
      setParameters: ReturnType<typeof vi.fn>
    }
  }> = []
  const makeTransceiver = (trackOrKind: MediaStreamTrack | string) => {
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind.kind
    const transceiver = {
      direction: "sendrecv" as RTCRtpTransceiverDirection,
      receiver: { track: { kind } },
      sender: {
        replaceTrack: vi.fn(async () => {}),
        getParameters: vi.fn(() => ({ encodings: [] })),
        setParameters: vi.fn(async () => {}),
      },
    }
    transceivers.push(transceiver)
    return transceiver
  }
  const pc = {
    connectionState: "new",
    signalingState: "stable",
    remoteDescription: null as RTCSessionDescriptionInit | null,
    localDescription: null as RTCSessionDescriptionInit | null,
    ontrack: null as RTCPeerConnection["ontrack"],
    onicecandidate: null as RTCPeerConnection["onicecandidate"],
    onnegotiationneeded: null as RTCPeerConnection["onnegotiationneeded"],
    onconnectionstatechange: null as RTCPeerConnection["onconnectionstatechange"],
    addTransceiver: vi.fn(makeTransceiver),
    getTransceivers: vi.fn(() => transceivers),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "offer" })),
    createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "answer" })),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      pc.localDescription = description
      pc.signalingState = description.type === "offer" ? "have-local-offer" : "stable"
    }),
    setRemoteDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      pc.remoteDescription = description
      pc.signalingState = description.type === "offer" ? "have-remote-offer" : "stable"
      if (description.type === "offer" && transceivers.length === 0) {
        makeTransceiver("audio")
        makeTransceiver("video")
      }
    }),
    addIceCandidate: vi.fn(async () => {}),
    restartIce: vi.fn(),
    getConfiguration: vi.fn(() => ({ iceServers: [] })),
    setConfiguration: vi.fn(),
    getStats: vi.fn(async () => new Map()),
    close: vi.fn(),
  }
  return pc
}

const credentials = {
  iceServers: [{ urls: "turn:example.test:3478", username: "u", credential: "c" }],
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
}

async function setup(ids: { local: string; peer: string } = { local: "ep_a", peer: "ep_b" }) {
  const socket = makeSocket()
  const pc = makePeerConnection()
  const transport = new P2pMeshTransport({
    workspaceId: "ws_1",
    callId: "call_1",
    socket,
    generation: 4,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    fetchCredentials: vi.fn(async () => credentials),
  })
  await transport.connect({ endpointId: ids.local, mediaIncarnation: "inc_a" })
  await transport.syncPeers(
    [
      {
        endpointId: ids.peer,
        epoch: 2,
        mediaIncarnation: "inc_b",
        publications: [
          { ref: { endpointId: ids.peer, kind: "mic", publicationId: "pub_mic" } },
          { ref: { endpointId: ids.peer, kind: "camera", publicationId: "pub_camera" } },
        ],
      },
    ],
    4
  )
  return { socket, pc, transport }
}

describe("P2pMeshTransport", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("should buffer candidates by negotiation identity and discard delayed generations", async () => {
    const { socket, pc, transport } = await setup()
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "old",
      kind: "candidate",
      candidate: { candidate: "old-candidate" },
    })
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "current",
      kind: "candidate",
      candidate: { candidate: "current-candidate" },
    })
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "current",
      kind: "description",
      description: { type: "offer", sdp: "offer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pc.addIceCandidate).toHaveBeenCalledTimes(1)
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: "current-candidate" })
    await transport.close()
  })

  it("should keep a healthy transport connected after a disconnected peer leaves", async () => {
    const { pc, transport } = await setup()
    pc.connectionState = "disconnected"
    const onConnectionStateChange = pc.onconnectionstatechange as () => void
    onConnectionStateChange()
    expect(transport.connectionState).toBe("reconnecting")

    await transport.syncPeers([], 4)

    expect(transport.connectionState).toBe("connected")
    await transport.close()
  })

  it("should contain rejected ICE candidates without failing the transport", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { socket, pc, transport } = await setup()
    pc.addIceCandidate.mockRejectedValue(new DOMException("stale candidate", "OperationError"))
    const signal = {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "current",
    }
    socket.fire("call:p2p:signal", {
      ...signal,
      kind: "candidate",
      candidate: { candidate: "buffered-candidate" },
    })
    socket.fire("call:p2p:signal", {
      ...signal,
      kind: "description",
      description: { type: "offer", sdp: "offer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    socket.fire("call:p2p:signal", {
      ...signal,
      kind: "candidate",
      candidate: { candidate: "direct-candidate" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect({ state: transport.connectionState, warnings: warning.mock.calls }).toEqual({
      state: "connected",
      warnings: [
        [
          "P2P ICE candidate rejected",
          expect.objectContaining({
            endpointId: "ep_b",
            negotiationId: "current",
            error: expect.objectContaining({ name: "OperationError", message: "stale candidate" }),
          }),
        ],
        [
          "P2P ICE candidate rejected",
          expect.objectContaining({
            endpointId: "ep_b",
            negotiationId: "current",
            error: expect.objectContaining({ name: "OperationError", message: "stale candidate" }),
          }),
        ],
      ],
    })
    await transport.close()
  })

  it("should replay an offer that arrives before a simultaneous peer roster update", async () => {
    const socket = makeSocket()
    const pc = makePeerConnection()
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_a", mediaIncarnation: "inc_a" })
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "early",
      kind: "description",
      description: { type: "offer", sdp: "offer" },
    })
    await transport.syncPeers([{ endpointId: "ep_b", epoch: 2, mediaIncarnation: "inc_b", publications: [] }], 4)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "offer" })
    await transport.close()
  })

  it("should not replace a roster-authorized peer with a delayed incarnation signal", async () => {
    const { socket, pc, transport } = await setup()
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_old",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "delayed",
      kind: "description",
      description: { type: "offer", sdp: "old-offer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect({ closes: pc.close.mock.calls, remoteDescriptions: pc.setRemoteDescription.mock.calls }).toEqual({
      closes: [],
      remoteDescriptions: [],
    })
    await transport.close()
  })

  it("should advertise publication identity and ignore an ended callback from a replaced remote track", async () => {
    const { socket, pc, transport } = await setup()
    const localTrack = { kind: "audio", id: "local", addEventListener: vi.fn() } as unknown as MediaStreamTrack
    await transport.publish("mic", localTrack)
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:publications",
      payload: { generation: 4, revision: 1, publications: [{ kind: "mic", publicationId: expect.any(String) }] },
    })

    const ended = vi.fn()
    transport.onRemoteTrackEnded = ended
    const listeners: Array<() => void> = []
    const first = {
      kind: "video",
      id: "first",
      addEventListener: vi.fn((_event, handler) => listeners.push(handler as () => void)),
    }
    const second = { kind: "video", id: "second", addEventListener: vi.fn() }
    const ontrack = pc.ontrack as unknown as (event: RTCTrackEvent) => void
    ontrack({ track: first } as unknown as RTCTrackEvent)
    ontrack({ track: second } as unknown as RTCTrackEvent)
    listeners[0]()
    expect(ended).not.toHaveBeenCalled()
    await transport.close()
  })

  it("should keep the selected remote track stable across an unrelated roster snapshot", async () => {
    const { pc, transport } = await setup()
    const seen = vi.fn()
    transport.onRemoteTrack = seen
    const track = { kind: "audio", id: "remote", addEventListener: vi.fn() }
    ;(pc.ontrack as unknown as (event: RTCTrackEvent) => void)({ track } as unknown as RTCTrackEvent)
    await transport.syncPeers(
      [
        {
          endpointId: "ep_b",
          epoch: 2,
          mediaIncarnation: "inc_b",
          publications: [{ ref: { endpointId: "ep_b", kind: "mic", publicationId: "pub_mic" } }],
        },
      ],
      4
    )
    expect(seen).toHaveBeenCalledTimes(1)
    const replacement = { kind: "audio", id: "replacement", addEventListener: vi.fn() }
    ;(pc.ontrack as unknown as (event: RTCTrackEvent) => void)({ track: replacement } as unknown as RTCTrackEvent)
    expect(seen).toHaveBeenLastCalledWith({
      ref: { endpointId: "ep_b", kind: "mic", publicationId: "pub_mic" },
      track: replacement,
    })
    await transport.close()
  })

  it("should let the impolite peer own the initial offer and reuse its camera sender", async () => {
    vi.useFakeTimers()
    const { socket, pc, transport } = await setup()
    const first = { kind: "video", id: "first" } as MediaStreamTrack
    const second = { kind: "video", id: "second" } as MediaStreamTrack

    expect(pc.addTransceiver.mock.calls).toEqual([
      ["audio", { direction: "sendrecv", sendEncodings: [{}] }],
      ["video", { direction: "sendrecv", sendEncodings: [{}] }],
    ])
    await vi.advanceTimersByTimeAsync(50)
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({ kind: "description", description: { type: "offer", sdp: "offer" } }),
    })

    await transport.publish("camera", first)
    await transport.unpublish("camera")
    await transport.publish("camera", second)

    expect(pc.addTransceiver).toHaveBeenCalledTimes(2)
    const sender = pc.addTransceiver.mock.results[1].value.sender
    expect(sender.replaceTrack.mock.calls.map((call: [MediaStreamTrack | null]) => call[0])).toEqual([
      first,
      null,
      second,
    ])
    await transport.close()
  })

  it("should let a polite peer wait for offer-created slots and bind delayed capture", async () => {
    vi.useFakeTimers()
    const { socket, pc, transport } = await setup({ local: "ep_z", peer: "ep_a" })
    const track = { kind: "audio", id: "delayed" } as MediaStreamTrack

    await transport.publish("mic", track)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(pc.addTransceiver).not.toHaveBeenCalled()
    expect(socket.emitted.filter(({ event }) => event === "call:p2p:signal")).toEqual([])

    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_z",
      recipientEpoch: 1,
      senderEndpointId: "ep_a",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "initial-offer",
      kind: "description",
      description: { type: "offer", sdp: "offer" },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(pc.getTransceivers()).toHaveLength(2)
    expect(pc.getTransceivers()[0].sender.replaceTrack).toHaveBeenCalledWith(track)
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({
        negotiationId: "initial-offer",
        description: { type: "answer", sdp: "answer" },
      }),
    })
    ;(pc.onicecandidate as unknown as (event: RTCPeerConnectionIceEvent) => void)({
      candidate: null,
    } as RTCPeerConnectionIceEvent)
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({ kind: "end-of-candidates", negotiationId: "initial-offer" }),
    })
    await transport.close()
  })

  it("should roll back a polite colliding offer and answer it", async () => {
    const { socket, pc, transport } = await setup({ local: "ep_z", peer: "ep_a" })
    pc.signalingState = "have-local-offer"
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_z",
      recipientEpoch: 1,
      senderEndpointId: "ep_a",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "remote-offer",
      kind: "description",
      description: { type: "offer", sdp: "offer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(pc.setLocalDescription.mock.calls.map(([description]) => description.type)).toContain("rollback")
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({
        kind: "description",
        negotiationId: "remote-offer",
        description: { type: "answer", sdp: "answer" },
      }),
    })
    await transport.close()
  })

  it("should ignore an answer to an older local negotiation", async () => {
    const { socket, pc, transport } = await setup()
    await transport.reconnect()
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "old-offer",
      kind: "description",
      description: { type: "answer", sdp: "stale-answer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pc.setRemoteDescription).not.toHaveBeenCalled()
    await transport.close()
  })

  it("should label answer candidates without a username fragment with the answered negotiation", async () => {
    const { socket, pc, transport } = await setup()
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "remote-offer",
      kind: "description",
      description: { type: "offer", sdp: "remote-offer" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    ;(pc.onicecandidate as unknown as (event: unknown) => void)({
      candidate: { toJSON: () => ({ candidate: "answer-candidate" }) },
    })
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({
        kind: "candidate",
        negotiationId: "remote-offer",
        candidate: { candidate: "answer-candidate" },
      }),
    })
    await transport.close()
  })

  it("should retry the pending offer without rolling back on negotiation-needed events", async () => {
    vi.useFakeTimers()
    const { socket, pc, transport } = await setup()
    await vi.advanceTimersByTimeAsync(50)
    ;(pc.onnegotiationneeded as unknown as () => void)()
    await vi.advanceTimersByTimeAsync(50)
    await vi.advanceTimersByTimeAsync(1500)
    const descriptions = socket.emitted.filter(
      ({ event, payload }) => event === "call:p2p:signal" && (payload as { kind: string }).kind === "description"
    )
    try {
      expect(pc.setLocalDescription.mock.calls).toEqual([[{ type: "offer", sdp: "offer" }]])
      expect(descriptions.at(-1)).toEqual(descriptions[0])
    } finally {
      await transport.close()
    }
  })

  it("should wait for the initial remote offer when passive signaling reconnects", async () => {
    const { pc, transport } = await setup({ local: "ep_z", peer: "ep_a" })
    await transport.reconnect()
    expect(pc.createOffer).not.toHaveBeenCalled()
    await transport.close()
  })

  it("should ignore a repeated answer after its negotiation has settled", async () => {
    vi.useFakeTimers()
    const { socket, pc, transport } = await setup()
    await transport.reconnect()
    const offer = socket.emitted.find(({ event }) => event === "call:p2p:signal")!.payload as { negotiationId: string }
    const answer = {
      callId: "call_1",
      recipientEndpointId: "ep_a",
      recipientEpoch: 1,
      senderEndpointId: "ep_b",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: offer.negotiationId,
      kind: "description",
      description: { type: "answer", sdp: "answer" },
    }
    socket.fire("call:p2p:signal", answer)
    await vi.advanceTimersByTimeAsync(0)
    socket.fire("call:p2p:signal", answer)
    await vi.advanceTimersByTimeAsync(0)
    expect(pc.setRemoteDescription.mock.calls).toEqual([[{ type: "answer", sdp: "answer" }]])
    await transport.close()
  })

  it("should restart ICE and send a fresh offer after signaling reconnects", async () => {
    const { socket, pc, transport } = await setup()
    await transport.reconnect()

    expect(pc.restartIce).toHaveBeenCalledTimes(1)
    expect(socket.emitted).toContainEqual({
      event: "call:p2p:signal",
      payload: expect.objectContaining({ kind: "description", description: { type: "offer", sdp: "offer" } }),
    })
    await transport.close()
  })

  it("should reject initial connection when TURN credentials are unavailable", async () => {
    const socket = makeSocket()
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      fetchCredentials: vi.fn(async () => {
        throw new Error("unavailable")
      }),
    })

    await expect(transport.connect({ endpointId: "ep_a", mediaIncarnation: "inc_a" })).rejects.toThrow("unavailable")
    expect({ state: transport.connectionState, signalHandler: socket.hasHandler("call:p2p:signal") }).toEqual({
      state: "failed",
      signalHandler: false,
    })
    await transport.close()
  })

  it("should wait for credentials before constructing peers from an early roster", async () => {
    const socket = makeSocket()
    const pc = makePeerConnection()
    const createPeerConnection = vi.fn(() => pc as unknown as RTCPeerConnection)
    let resolveCredentials!: (value: typeof credentials) => void
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection,
      fetchCredentials: () =>
        new Promise((resolve) => {
          resolveCredentials = resolve
        }),
    })
    const connecting = transport.connect({ endpointId: "ep_a", mediaIncarnation: "inc_a" })
    await transport.syncPeers([{ endpointId: "ep_b", epoch: 2, mediaIncarnation: "inc_b", publications: [] }], 4)
    const constructedBeforeCredentials = createPeerConnection.mock.calls.length
    resolveCredentials(credentials)
    await connecting
    try {
      expect({ constructedBeforeCredentials, configurations: createPeerConnection.mock.calls }).toEqual({
        constructedBeforeCredentials: 0,
        configurations: [[{ iceServers: credentials.iceServers }]],
      })
    } finally {
      await transport.close()
    }
  })

  it("should preserve signaling received while TURN credentials are pending", async () => {
    const socket = makeSocket()
    const pc = makePeerConnection()
    let resolveCredentials!: (value: typeof credentials) => void
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => pc as unknown as RTCPeerConnection,
      fetchCredentials: () =>
        new Promise((resolve) => {
          resolveCredentials = resolve
        }),
    })
    const connecting = transport.connect({ endpointId: "ep_z", mediaIncarnation: "inc_a" })
    socket.fire("call:p2p:signal", {
      callId: "call_1",
      recipientEndpointId: "ep_z",
      recipientEpoch: 1,
      senderEndpointId: "ep_a",
      senderEpoch: 2,
      senderMediaIncarnation: "inc_b",
      recipientMediaIncarnation: "inc_a",
      generation: 4,
      negotiationId: "early",
      kind: "description",
      description: { type: "offer", sdp: "early-offer" },
    })
    resolveCredentials(credentials)
    await connecting
    await transport.syncPeers([{ endpointId: "ep_a", epoch: 2, mediaIncarnation: "inc_b", publications: [] }], 4)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "early-offer" })
    await transport.close()
  })

  it("should remove signaling and not rearm timers when closed while credentials are pending", async () => {
    const socket = makeSocket()
    let resolveCredentials!: (value: typeof credentials) => void
    const pending = new Promise<typeof credentials>((resolve) => {
      resolveCredentials = resolve
    })
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      fetchCredentials: () => pending,
    })
    const connecting = transport.connect({ endpointId: "ep_a", mediaIncarnation: "inc_a" })
    await transport.close()
    resolveCredentials(credentials)
    await connecting
    expect({ state: transport.connectionState, signalHandler: socket.hasHandler("call:p2p:signal") }).toEqual({
      state: "closed",
      signalHandler: false,
    })
  })

  it("should report relayed media when only the remote candidate uses TURN", async () => {
    const { pc, transport } = await setup()
    pc.getStats.mockResolvedValue(
      new Map([
        ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
        [
          "pair",
          {
            id: "pair",
            type: "candidate-pair",
            state: "succeeded",
            localCandidateId: "local",
            remoteCandidateId: "remote",
          },
        ],
        ["local", { id: "local", type: "local-candidate", candidateType: "host" }],
        ["remote", { id: "remote", type: "remote-candidate", candidateType: "relay" }],
      ])
    )
    expect(await transport.getStats()).toMatchObject({ candidateType: "relay" })
    await transport.close()
  })

  it("should keep healthy mesh edges while peers join, leave, and replace an incarnation", async () => {
    const socket = makeSocket()
    const pcs: ReturnType<typeof makePeerConnection>[] = []
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => {
        const pc = makePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_0", mediaIncarnation: "inc_local" })
    const peer = (endpointId: string, mediaIncarnation = `inc_${endpointId}`) => ({
      endpointId,
      epoch: 1,
      mediaIncarnation,
      publications: [],
    })
    const firstRoster = ["a", "b", "c", "d", "e"].map((id) => peer(`ep_${id}`))
    await transport.syncPeers(firstRoster, 4)
    const camera = { kind: "video", id: "camera" } as MediaStreamTrack
    await transport.publish("camera", camera)
    await transport.setPublishEncoding("camera", { maxBitrate: 1_500_000 })

    expect(pcs).toHaveLength(5)
    for (const pc of pcs) {
      const sender = pc.addTransceiver.mock.results[1].value.sender
      expect(sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 300_000 }] })
    }

    const healthyA = pcs[0]
    const replacedB = pcs[1]
    await transport.syncPeers([peer("ep_a"), peer("ep_b", "inc_ep_b_2"), peer("ep_c"), peer("ep_d")], 4)
    expect(healthyA.close).not.toHaveBeenCalled()
    expect(replacedB.close).toHaveBeenCalledTimes(1)
    expect(pcs).toHaveLength(6)
    expect(pcs[5].addTransceiver).toHaveBeenCalledTimes(2)
    for (const pc of [healthyA, pcs[2], pcs[3], pcs[5]]) {
      const sender = pc.addTransceiver.mock.results[1].value.sender
      expect(sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 375_000 }] })
    }
    await transport.close()
  })

  it("should cap only the selected peer while preserving the aggregate camera budget", async () => {
    const socket = makeSocket()
    const pcs: ReturnType<typeof makePeerConnection>[] = []
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => {
        const pc = makePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_0", mediaIncarnation: "inc_local" })
    const peers = ["ep_slow", "ep_healthy"].map((endpointId) => ({
      endpointId,
      epoch: 1,
      mediaIncarnation: `inc_${endpointId}`,
      publications: [],
    }))
    await transport.syncPeers(peers, 4)
    await transport.publish("camera", { kind: "video" } as MediaStreamTrack)
    await transport.setPublishEncoding("camera", { maxBitrate: 1_500_000 })
    await transport.setPeerPublishEncoding("ep_slow", "camera", { maxBitrate: 350_000 })

    const slowSender = pcs[0].addTransceiver.mock.results[1].value.sender
    const healthySender = pcs[1].addTransceiver.mock.results[1].value.sender
    expect(slowSender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 350_000 }] })
    expect(healthySender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 750_000 }] })

    await transport.setPeerPublishEncoding("ep_slow", "camera", { maxBitrate: 1_500_000 })
    expect(slowSender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 750_000 }] })

    await transport.syncPeers(
      [...peers, { endpointId: "ep_new", epoch: 1, mediaIncarnation: "inc_new", publications: [] }],
      4
    )
    const newSender = pcs[2].addTransceiver.mock.results[1].value.sender
    for (const sender of [slowSender, healthySender, newSender]) {
      expect(sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 500_000 }] })
    }
    await transport.close()
  })

  it("should preserve a peer camera cap when its media incarnation is replaced", async () => {
    const socket = makeSocket()
    const pcs: ReturnType<typeof makePeerConnection>[] = []
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => {
        const pc = makePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_local", mediaIncarnation: "inc_local" })
    const peer = (mediaIncarnation: string) => ({
      endpointId: "ep_slow",
      epoch: 1,
      mediaIncarnation,
      publications: [],
    })
    await transport.syncPeers([peer("inc_1")], 4)
    await transport.publish("camera", { kind: "video" } as MediaStreamTrack)
    await transport.setPublishEncoding("camera", { maxBitrate: 1_500_000 })
    await transport.setPeerPublishEncoding("ep_slow", "camera", { maxBitrate: 350_000 })

    await transport.syncPeers([peer("inc_2")], 4)

    const replacementSender = pcs[1].addTransceiver.mock.results[1].value.sender
    expect(replacementSender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 350_000 }] })
    await transport.close()
  })

  it("should apply a peer cap below six-person equal shares without lowering healthy peers", async () => {
    const socket = makeSocket()
    const pcs: ReturnType<typeof makePeerConnection>[] = []
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => {
        const pc = makePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_0", mediaIncarnation: "inc_local" })
    await transport.syncPeers(
      ["slow", "a", "b", "c", "d"].map((id) => ({
        endpointId: `ep_${id}`,
        epoch: 1,
        mediaIncarnation: `inc_${id}`,
        publications: [],
      })),
      4
    )
    await transport.publish("camera", { kind: "video" } as MediaStreamTrack)
    await transport.setPublishEncoding("camera", { maxBitrate: 1_500_000 })
    await transport.setPeerPublishEncoding("ep_slow", "camera", { maxBitrate: 150_000 })

    const senders = pcs.slice(0, 5).map((pc) => pc.addTransceiver.mock.results[1].value.sender)
    expect(senders[0].setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 150_000 }] })
    for (const sender of senders.slice(1)) {
      expect(sender.setParameters).toHaveBeenLastCalledWith({ encodings: [{ maxBitrate: 300_000 }] })
    }
    await transport.close()
  })

  it("should reject a peer encoder-setting failure", async () => {
    const { pc, transport } = await setup()
    const sender = pc.addTransceiver.mock.results[1].value.sender
    sender.setParameters.mockRejectedValueOnce(new Error("encoder rejected"))

    await expect(transport.setPeerPublishEncoding("ep_b", "camera", { maxBitrate: 350_000 })).rejects.toThrow(
      "encoder rejected"
    )
    await transport.close()
  })

  it("should report per-peer interval traffic and preserve direct and relay totals across replacement", async () => {
    const socket = makeSocket()
    const pcs: ReturnType<typeof makePeerConnection>[] = []
    const transport = new P2pMeshTransport({
      workspaceId: "ws_1",
      callId: "call_1",
      socket,
      generation: 4,
      createPeerConnection: () => {
        const pc = makePeerConnection()
        pcs.push(pc)
        return pc as unknown as RTCPeerConnection
      },
      fetchCredentials: vi.fn(async () => credentials),
    })
    await transport.connect({ endpointId: "ep_local", mediaIncarnation: "inc_local" })
    const descriptor = (endpointId: string, mediaIncarnation: string) => ({
      endpointId,
      epoch: 1,
      mediaIncarnation,
      publications: [],
    })
    await transport.syncPeers([descriptor("ep_direct", "inc_d"), descriptor("ep_relay", "inc_r")], 4)
    const stats = (sent: number, received: number, remoteType: "host" | "relay") =>
      new Map([
        ["transport", { id: "transport", type: "transport", selectedCandidatePairId: "pair" }],
        [
          "pair",
          {
            id: "pair",
            type: "candidate-pair",
            state: "succeeded",
            localCandidateId: "local",
            remoteCandidateId: "remote",
            currentRoundTripTime: 0.02,
          },
        ],
        ["local", { id: "local", type: "local-candidate", candidateType: "host" }],
        ["remote", { id: "remote", type: "remote-candidate", candidateType: remoteType }],
        [
          "out",
          {
            id: "out",
            type: "outbound-rtp",
            kind: "video",
            bytesSent: sent,
            packetsSent: 10,
            qualityLimitationReason: "none",
            totalEncodeTime: 0.1,
            framesEncoded: 10,
          },
        ],
        [
          "in",
          { id: "in", type: "inbound-rtp", kind: "video", bytesReceived: received, packetsReceived: 9, packetsLost: 1 },
        ],
      ])
    pcs[0].getStats.mockResolvedValue(stats(100, 80, "host"))
    pcs[1].getStats.mockResolvedValue(stats(200, 160, "relay"))
    const first = await transport.getStats()
    expect(first).toMatchObject({
      bytesSent: 300,
      bytesReceived: 240,
      directBytesSent: 0,
      directBytesReceived: 0,
      relayBytesSent: 0,
      relayBytesReceived: 0,
      unknownBytesSent: 300,
      unknownBytesReceived: 240,
      packetLoss: null,
      qualityLimitation: "none",
      peers: [
        { endpointId: "ep_direct", candidateType: "host", intervalBytesSent: 100, intervalBytesReceived: 80 },
        { endpointId: "ep_relay", candidateType: "relay", intervalBytesSent: 200, intervalBytesReceived: 160 },
      ],
    })
    pcs[0].getStats.mockResolvedValue(stats(140, 100, "host"))
    pcs[1].getStats.mockResolvedValue(stats(230, 200, "relay"))
    expect(await transport.getStats()).toMatchObject({
      bytesSent: 70,
      bytesReceived: 60,
      directBytesSent: 40,
      relayBytesSent: 30,
    })

    pcs[0].getStats.mockResolvedValue(stats(5, 4, "host"))
    expect(await transport.getStats()).toMatchObject({
      bytesSent: 5,
      bytesReceived: 4,
      directBytesSent: 45,
      directBytesReceived: 24,
    })

    await transport.syncPeers([descriptor("ep_direct", "inc_d_2"), descriptor("ep_relay", "inc_r")], 4)
    pcs[2].getStats.mockResolvedValue(stats(15, 10, "host"))
    expect(await transport.getStats()).toMatchObject({
      bytesSent: 15,
      directBytesSent: 45,
      relayBytesSent: 30,
      unknownBytesSent: 315,
      unknownBytesReceived: 250,
    })
    pcs[2].getStats.mockResolvedValue(stats(25, 20, "host"))
    await transport.close()
    expect(await transport.getStats()).toMatchObject({
      directBytesSent: 55,
      directBytesReceived: 34,
      relayBytesSent: 30,
      unknownBytesSent: 315,
    })
  })

  it("should apply refreshed ICE configuration to an existing peer", async () => {
    vi.useFakeTimers()
    const { pc, transport } = await setup()
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(pc.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: credentials.iceServers }))
    await transport.close()
  })
})
