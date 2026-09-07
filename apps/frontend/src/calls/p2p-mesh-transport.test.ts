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
  const pc = {
    connectionState: "new",
    signalingState: "stable",
    remoteDescription: null as RTCSessionDescriptionInit | null,
    localDescription: null as RTCSessionDescriptionInit | null,
    ontrack: null as RTCPeerConnection["ontrack"],
    onicecandidate: null as RTCPeerConnection["onicecandidate"],
    onnegotiationneeded: null as RTCPeerConnection["onnegotiationneeded"],
    onconnectionstatechange: null as RTCPeerConnection["onconnectionstatechange"],
    addTrack: vi.fn(),
    addTransceiver: vi.fn(() => ({
      sender: {
        replaceTrack: vi.fn(async () => {}),
        getParameters: vi.fn(() => ({ encodings: [] })),
        setParameters: vi.fn(async () => {}),
      },
    })),
    getSenders: vi.fn(() => []),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "offer" })),
    createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "answer" })),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      pc.localDescription = description
      pc.signalingState = description.type === "offer" ? "have-local-offer" : "stable"
    }),
    setRemoteDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      pc.remoteDescription = description
      pc.signalingState = description.type === "offer" ? "have-remote-offer" : "stable"
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
  afterEach(() => vi.useRealTimers())

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

  it("should reuse the per-kind sender after camera off and on", async () => {
    const { pc, transport } = await setup()
    const first = { kind: "video", id: "first" } as MediaStreamTrack
    const second = { kind: "video", id: "second" } as MediaStreamTrack
    await transport.publish("camera", first)
    await transport.unpublish("camera")
    await transport.publish("camera", second)
    expect(pc.addTransceiver).toHaveBeenCalledTimes(1)
    const sender = pc.addTransceiver.mock.results[0].value.sender
    expect(sender.replaceTrack.mock.calls.map((call: [MediaStreamTrack | null]) => call[0])).toEqual([null, second])
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

  it("should not install signaling or timers when closed while credentials are pending", async () => {
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

  it("should apply refreshed ICE configuration to an existing peer", async () => {
    vi.useFakeTimers()
    const { pc, transport } = await setup()
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(pc.setConfiguration).toHaveBeenCalledWith(expect.objectContaining({ iceServers: credentials.iceServers }))
    await transport.close()
  })
})
