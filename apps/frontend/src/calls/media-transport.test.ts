import { describe, it, expect, vi, beforeEach } from "vitest"
import { CloudflareSfuTransport, createCallProxyClient, type PeerTrackRef } from "./media-transport"

interface PostCall {
  path: string
  body: Record<string, unknown>
}

function makeTransceiver(mid: string) {
  return {
    mid,
    sender: { replaceTrack: vi.fn(async () => {}) },
    stop: vi.fn(),
  }
}

/** A hand-rolled RTCPeerConnection double — behavior only, no real SDP. */
function makeFakePc() {
  let midCounter = 0
  const transceivers: ReturnType<typeof makeTransceiver>[] = []
  const pc = {
    ontrack: null as ((e: unknown) => void) | null,
    onconnectionstatechange: null as (() => void) | null,
    connectionState: "new",
    transceivers,
    addTransceiver: vi.fn((_track: unknown, _init: unknown) => {
      const t = makeTransceiver(`local-${midCounter++}`)
      transceivers.push(t)
      return t
    }),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" })),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    getStats: vi.fn(async () => new Map()),
    close: vi.fn(),
  }
  return pc
}

function makeTrack(kind: "audio" | "video" = "audio"): MediaStreamTrack {
  return { kind, stop: vi.fn(), addEventListener: vi.fn() } as unknown as MediaStreamTrack
}

const INC = "inc-1"

function makeTransport(overrides?: {
  post?: (path: string, body: unknown) => Promise<unknown>
  pc?: ReturnType<typeof makeFakePc>
}) {
  const calls: PostCall[] = []
  const pc = overrides?.pc ?? makeFakePc()
  const post =
    overrides?.post ??
    (async (path: string, body: unknown) => {
      calls.push({ path, body: body as Record<string, unknown> })
      if (path.endsWith("/session")) return { cfSessionId: "cf-sess", idempotent: false }
      if (path.endsWith("/tracks/publish")) return { requiresImmediateRenegotiation: false, tracks: [] }
      if (path.endsWith("/tracks/pull"))
        return {
          requiresImmediateRenegotiation: false,
          tracks: [{ mid: "remote-0" }],
          sessionDescription: { type: "offer", sdp: "cf-offer" },
        }
      if (path.endsWith("/renegotiate")) return {}
      if (path.endsWith("/tracks/close")) return { tracks: [] }
      return {}
    })
  const transport = new CloudflareSfuTransport({
    workspaceId: "ws_1",
    callId: "call_1",
    post: post as <T>(p: string, b: unknown) => Promise<T>,
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
  })
  return { transport, calls, pc, post }
}

describe("createCallProxyClient", () => {
  it("carries mediaIncarnation in every proxy body", async () => {
    const calls: PostCall[] = []
    const post = async (path: string, body: unknown) => {
      calls.push({ path, body: body as Record<string, unknown> })
      return {}
    }
    const proxy = createCallProxyClient({
      workspaceId: "ws_1",
      callId: "call_1",
      endpointId: "ep_1",
      mediaIncarnation: INC,
      post: post as <T>(p: string, b: unknown) => Promise<T>,
    })
    await proxy.createSession()
    await proxy.publishTracks({ sdp: { type: "offer", sdp: "s" }, tracks: [{ kind: "mic", mid: "0", trackName: "t" }] })
    await proxy.pullTracks([{ sessionId: "cf", trackName: "t" }])
    await proxy.renegotiate({ type: "answer", sdp: "a" })
    await proxy.closeTracks({ mids: ["0"] })

    expect(calls).toHaveLength(5)
    for (const c of calls) expect(c.body.mediaIncarnation).toBe(INC)
    expect(calls[0].path).toContain("/api/workspaces/ws_1/calls/call_1/endpoints/ep_1/cf/session")
  })
})

describe("CloudflareSfuTransport", () => {
  beforeEach(() => vi.clearAllMocks())

  it("carries the incarnation on every proxy fetch through the transport", async () => {
    const { transport, calls } = makeTransport()
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.publish("mic", makeTrack("audio"))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c.body.mediaIncarnation).toBe(INC)
  })

  it("serializes overlapping renegotiations behind the queue (never interleaves)", async () => {
    const pc = makeFakePc()
    let inFlight = 0
    let maxInFlight = 0
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    pc.createOffer = vi.fn(async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await barrier
      inFlight--
      return { type: "offer", sdp: "offer-sdp" }
    })
    const { transport } = makeTransport({ pc })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })

    // Fire two publishes (different kinds → both add a transceiver + offer).
    const p1 = transport.publish("mic", makeTrack("audio"))
    const p2 = transport.publish("camera", makeTrack("video"))
    await Promise.resolve()
    await Promise.resolve()

    // Serialized: only the first job has entered createOffer.
    expect(maxInFlight).toBe(1)
    release()
    await Promise.all([p1, p2])
    expect(maxInFlight).toBe(1)
  })

  it("adds a transceiver once per kind and replaceTracks on re-publish", async () => {
    const { transport, pc } = makeTransport()
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.publish("mic", makeTrack("audio"))
    await transport.publish("mic", makeTrack("audio"))

    expect(pc.addTransceiver).toHaveBeenCalledTimes(1)
    expect(pc.transceivers[0].sender.replaceTrack).toHaveBeenCalledTimes(1)
  })

  it("pull surfaces the remote track and stopPull closes its mid", async () => {
    const { transport, calls, pc } = makeTransport()
    const seen: PeerTrackRef[] = []
    transport.onRemoteTrack = (e) => seen.push(e.ref)
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })

    const ref: PeerTrackRef = { sessionId: "cf-peer", trackName: "peer:mic" }
    await transport.pull(ref)
    // Simulate the engine delivering the pulled track on its transceiver.
    pc.ontrack?.({ transceiver: { mid: "remote-0" }, track: makeTrack("audio") })
    expect(seen).toEqual([ref])

    await transport.stopPull(ref)
    const closeCall = calls.find((c) => c.path.endsWith("/tracks/close"))
    expect(closeCall?.body.mids).toEqual(["remote-0"])
  })

  it("keeps the queue alive after a failed job", async () => {
    let call = 0
    const { transport } = makeTransport({
      post: async (path: string, body: unknown) => {
        void body
        if (path.endsWith("/session")) return { cfSessionId: "cf", idempotent: false }
        if (path.endsWith("/tracks/publish")) {
          call++
          if (call === 1) throw new Error("CF publish failed")
          return { requiresImmediateRenegotiation: false, tracks: [] }
        }
        return {}
      },
    })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await expect(transport.publish("mic", makeTrack("audio"))).rejects.toThrow("CF publish failed")
    // A later job still runs (the chain didn't wedge on the rejection).
    await expect(transport.publish("camera", makeTrack("video"))).resolves.toBeUndefined()
  })
})
