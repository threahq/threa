import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  CloudflareSfuTransport,
  createCallProxyClient,
  summarizeSdpMSections,
  type PeerTrackRef,
} from "./media-transport"

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

describe("summarizeSdpMSections", () => {
  it("should list mid, kind, and direction per m-section in SDP order", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:0",
      "a=sendonly",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:2",
      "a=recvonly",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:3",
      "a=sendonly",
    ].join("\r\n")
    expect(summarizeSdpMSections(sdp)).toBe("0:audio:sendonly 2:video:recvonly 3:video:sendonly")
    expect(summarizeSdpMSections(undefined)).toBe("none")
    expect(summarizeSdpMSections("v=0")).toBe("none")
  })
})

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

  it("unpublish applies CF's close answer so the PC leaves have-local-offer and re-publish works", async () => {
    const closeAnswer = { type: "answer", sdp: "close-answer-sdp" }
    const pc = makeFakePc()
    const { transport } = makeTransport({
      pc,
      post: async (path: string, body: unknown) => {
        void body
        if (path.endsWith("/session")) return { cfSessionId: "cf", idempotent: false }
        if (path.endsWith("/tracks/publish")) return { requiresImmediateRenegotiation: false, tracks: [] }
        if (path.endsWith("/tracks/close")) return { tracks: [], sessionDescription: closeAnswer }
        return {}
      },
    })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.publish("camera", makeTrack("video"))
    await transport.unpublish("camera")

    // The close carried an offer → CF answers it; without applying the answer the PC
    // stays in have-local-offer and the re-publish below fails (the camera on→off→on bug).
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(closeAnswer)

    await expect(transport.publish("camera", makeTrack("video"))).resolves.toBeUndefined()
    expect(pc.addTransceiver).toHaveBeenCalledTimes(2)
  })

  it("should retry a failed publish with a fresh transceiver, never replaceTrack into an unacknowledged one", async () => {
    let publishCalls = 0
    const { transport, pc } = makeTransport({
      post: async (path: string, body: unknown) => {
        if (path.endsWith("/session")) return { cfSessionId: "cf", idempotent: false }
        if (path.endsWith("/tracks/publish")) {
          publishCalls++
          if (publishCalls === 1) throw new Error("CF publish failed")
          return { requiresImmediateRenegotiation: false, tracks: [] }
        }
        void body
        return {}
      },
    })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await expect(transport.publish("camera", makeTrack("video"))).rejects.toThrow("CF publish failed")
    // The failed transceiver was stopped and evicted — otherwise this retry takes
    // the replaceTrack fast path into a transceiver CF never acknowledged, and
    // the camera button "works" while no media ever reaches the SFU.
    expect(pc.transceivers[0].stop).toHaveBeenCalled()
    await expect(transport.publish("camera", makeTrack("video"))).resolves.toBeUndefined()
    expect(pc.addTransceiver).toHaveBeenCalledTimes(2)
    expect(publishCalls).toBe(2)
  })

  it("should roll back the local offer when CF's publish answer cannot be applied", async () => {
    const pc = makeFakePc()
    const withState = pc as unknown as { signalingState: string }
    withState.signalingState = "stable"
    pc.setLocalDescription = vi.fn(async (desc: { type?: string } | undefined) => {
      withState.signalingState = desc?.type === "rollback" ? "stable" : "have-local-offer"
    }) as typeof pc.setLocalDescription
    pc.setRemoteDescription = vi.fn(async (desc: { type?: string }) => {
      if (desc.type === "answer") throw new DOMException("bad answer", "InvalidAccessError")
    }) as typeof pc.setRemoteDescription
    const { transport } = makeTransport({
      pc,
      post: async (path: string) => {
        if (path.endsWith("/session")) return { cfSessionId: "cf", idempotent: false }
        if (path.endsWith("/tracks/publish"))
          return {
            requiresImmediateRenegotiation: false,
            tracks: [],
            sessionDescription: { type: "answer", sdp: "m=video 9 X\r\na=mid:1\r\na=recvonly" },
          }
        return {}
      },
    })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await expect(transport.publish("camera", makeTrack("video"))).rejects.toThrow(/InvalidAccessError: bad answer/)
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" })
    expect(withState.signalingState).toBe("stable")
  })

  it("should close the registry entry even when no transceiver exists (phantom cleanup)", async () => {
    const { transport, calls } = makeTransport()
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.unpublish("camera")
    const close = calls.find((c) => c.path.endsWith("/tracks/close"))
    expect(close?.body).toMatchObject({ mids: [], unpublishKinds: ["camera"] })
    expect(close?.body.sdp).toBeUndefined()
  })

  it("should send the close SDP-less when the wedged PC cannot offer, instead of skipping it", async () => {
    const pc = makeFakePc()
    const { transport, calls } = makeTransport({ pc })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.publish("camera", makeTrack("video"))
    pc.createOffer = vi.fn(async () => {
      throw new DOMException("wedged", "InvalidStateError")
    })
    await transport.unpublish("camera")
    const close = calls.find((c) => c.path.endsWith("/tracks/close"))
    expect(close?.body).toMatchObject({ mids: ["local-0"], unpublishKinds: ["camera"] })
    expect(close?.body.sdp).toBeUndefined()
  })

  it("should roll back the close offer when the REST close itself fails", async () => {
    const pc = makeFakePc()
    const withState = pc as unknown as { signalingState: string }
    withState.signalingState = "stable"
    pc.setLocalDescription = vi.fn(async (desc: { type?: string } | undefined) => {
      withState.signalingState = desc?.type === "rollback" ? "stable" : "have-local-offer"
    }) as typeof pc.setLocalDescription
    const { transport } = makeTransport({
      pc,
      post: async (path: string) => {
        if (path.endsWith("/session")) return { cfSessionId: "cf", idempotent: false }
        if (path.endsWith("/tracks/publish")) return { requiresImmediateRenegotiation: false, tracks: [] }
        if (path.endsWith("/tracks/close")) throw new Error("network down")
        return {}
      },
    })
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })
    await transport.publish("camera", makeTrack("video"))
    await expect(transport.unpublish("camera")).rejects.toThrow("network down")
    // The PC must not stay in have-local-offer — that wedges every later negotiation.
    expect(withState.signalingState).toBe("stable")
  })

  it("should unwind a failed pull so a retry re-registers its mids cleanly", async () => {
    const pc = makeFakePc()
    const withState = pc as unknown as { signalingState: string }
    withState.signalingState = "stable"
    let srdCalls = 0
    pc.setRemoteDescription = vi.fn(async (desc: { type?: string }) => {
      if (desc.type === "rollback") {
        withState.signalingState = "stable"
        return
      }
      srdCalls++
      if (srdCalls === 1) {
        withState.signalingState = "have-remote-offer"
        throw new DOMException("bad offer", "OperationError")
      }
    }) as typeof pc.setRemoteDescription
    const { transport } = makeTransport({ pc })
    const seen: PeerTrackRef[] = []
    transport.onRemoteTrack = (e) => seen.push(e.ref)
    await transport.connect({ endpointId: "ep_1", mediaIncarnation: INC })

    const ref: PeerTrackRef = { sessionId: "cf-peer", trackName: "peer:camera" }
    await expect(transport.pull(ref)).rejects.toThrow(/OperationError: bad offer/)
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "rollback" })
    // The dead pull's mid attribution is gone: a track landing on it is ignored.
    pc.ontrack?.({ transceiver: { mid: "remote-0" }, track: makeTrack("video") })
    expect(seen).toEqual([])

    await expect(transport.pull(ref)).resolves.toBeUndefined()
    pc.ontrack?.({ transceiver: { mid: "remote-0" }, track: makeTrack("video") })
    expect(seen).toEqual([ref])
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
