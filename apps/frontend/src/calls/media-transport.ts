import { api } from "@/api/client"
import type { PublishedTrackKind } from "./config"

// The media-transport seam: an actor/track-oriented, provider-agnostic boundary
// (the plan's provider boundary — a future >50-participant SFU or the Later P2P
// direct mode slots in here without touching CallManager). One implementation
// today: CloudflareSfuTransport. All CF negotiation rides the 0.2 backend proxy
// endpoints; no CF URL ever appears client-side, and the app secret never
// leaves the backend.

/** The per-media-session handle a transport connects with (endpoint + incarnation). */
export interface SessionDescriptor {
  endpointId: string
  /** Fenced on every proxy call; a stale incarnation is rejected 409 by the backend. */
  mediaIncarnation: string
}

/** A peer track to pull: the publisher's CF session + the advertised track name. */
export interface PeerTrackRef {
  /** The publisher's CF session id (from the roster's published-track registry). */
  sessionId: string
  trackName: string
}

/** A remote track surfaced by a `pull`, tagged with the ref it satisfied. */
export interface RemoteTrackEvent {
  ref: PeerTrackRef
  track: MediaStreamTrack
}

export type TransportConnectionState = "new" | "connecting" | "connected" | "reconnecting" | "closed" | "failed"

export interface TransportStats {
  /** Round-trip time in ms from the selected candidate pair, or null when unknown. */
  rttMs: number | null
  /** Fractional inbound packet loss [0,1], or null when unknown. */
  packetLoss: number | null
  /** The worst `qualityLimitationReason` across outbound video, or null. */
  qualityLimitation: "none" | "cpu" | "bandwidth" | "other" | null
  /** Sum of outbound encode time / frames, a rough encoder-pressure signal (ms), or null. */
  encodeTimeMs: number | null
}

/**
 * Provider-agnostic media transport. Track-oriented: the CallManager speaks in
 * kinds and peer-track refs, never SDP. Renegotiation is an internal concern of
 * the implementation.
 */
export interface MediaTransport {
  connect(descriptor: SessionDescriptor): Promise<void>
  publish(kind: PublishedTrackKind, track: MediaStreamTrack): Promise<void>
  unpublish(kind: PublishedTrackKind): Promise<void>
  /** Cap a published track's encoder (watchdog ladder `maxBitrate`); no-op if unpublished. */
  setPublishEncoding(kind: PublishedTrackKind, params: { maxBitrate?: number }): Promise<void>
  pull(ref: PeerTrackRef): Promise<void>
  stopPull(ref: PeerTrackRef): Promise<void>
  getStats(): Promise<TransportStats>
  close(): Promise<void>
  readonly connectionState: TransportConnectionState
  /** Set by the owner before `connect`; fires once per pulled remote track. */
  onRemoteTrack: ((event: RemoteTrackEvent) => void) | null
  onRemoteTrackEnded: ((ref: PeerTrackRef) => void) | null
  onConnectionStateChange: ((state: TransportConnectionState) => void) | null
}

// ── CF proxy wire shapes (mirror apps/backend/src/features/calls) ──────────────

interface CfSessionDescription {
  type: "offer" | "answer"
  sdp: string
}

interface CfTrackResult {
  mid?: string
  trackName?: string
  errorCode?: string
  errorDescription?: string
}

interface CfCreateSessionResult {
  cfSessionId: string
  sessionDescription?: CfSessionDescription
  idempotent: boolean
}

interface CfTracksResult {
  requiresImmediateRenegotiation: boolean
  tracks: CfTrackResult[]
  sessionDescription?: CfSessionDescription
  rosterVersion?: number
}

interface CfRenegotiateResult {
  sessionDescription?: CfSessionDescription
}

type PostJson = <T>(path: string, body: unknown) => Promise<T>

/**
 * Bound proxy client for one media session. Every method carries the media
 * incarnation in its body (the backend fences on it), so incarnation lives in
 * exactly one place and no call can forget it.
 */
export interface CallProxyClient {
  createSession(): Promise<CfCreateSessionResult>
  publishTracks(args: {
    sdp: CfSessionDescription
    tracks: Array<{ kind: PublishedTrackKind; mid: string; trackName: string }>
  }): Promise<CfTracksResult>
  pullTracks(tracks: PeerTrackRef[]): Promise<CfTracksResult>
  renegotiate(sdp: CfSessionDescription): Promise<CfRenegotiateResult>
  closeTracks(args: {
    mids: string[]
    unpublishKinds?: PublishedTrackKind[]
    sdp?: CfSessionDescription
  }): Promise<unknown>
}

export function createCallProxyClient(args: {
  workspaceId: string
  callId: string
  endpointId: string
  mediaIncarnation: string
  post?: PostJson
}): CallProxyClient {
  const { workspaceId, callId, endpointId, mediaIncarnation } = args
  const post: PostJson = args.post ?? ((path, body) => api.post(path, body))
  const base = `/api/workspaces/${workspaceId}/calls/${callId}/endpoints/${endpointId}/cf`
  return {
    createSession: () => post(`${base}/session`, { mediaIncarnation }),
    publishTracks: ({ sdp, tracks }) => post(`${base}/tracks/publish`, { mediaIncarnation, sdp, tracks }),
    pullTracks: (tracks) => post(`${base}/tracks/pull`, { mediaIncarnation, tracks }),
    renegotiate: (sdp) => post(`${base}/renegotiate`, { mediaIncarnation, sdp }),
    closeTracks: ({ mids, unpublishKinds, sdp }) =>
      post(`${base}/tracks/close`, { mediaIncarnation, mids, unpublishKinds, sdp }),
  }
}

interface CloudflareSfuTransportDeps {
  workspaceId: string
  callId: string
  /** Injectable for tests; production builds a bound proxy from `api.post`. */
  post?: PostJson
  /** Injectable for tests; production uses the browser `RTCPeerConnection`. */
  createPeerConnection?: () => RTCPeerConnection
}

function pickWorst(reasons: Array<string | undefined>): TransportStats["qualityLimitation"] {
  if (reasons.includes("bandwidth")) return "bandwidth"
  if (reasons.includes("cpu")) return "cpu"
  if (reasons.some((r) => r && r !== "none")) return "other"
  if (reasons.some((r) => r === "none")) return "none"
  return null
}

/**
 * Cloudflare Realtime SFU transport: owns the single `RTCPeerConnection`, the
 * per-session renegotiation queue, transceiver bookkeeping for publish/pull, and
 * `getStats` sampling.
 *
 * The renegotiation queue is load-bearing: CF serializes renegotiations per
 * session, so two overlapping offer/answer exchanges corrupt each other's SDP
 * state. Every operation that mutates the local/remote description runs as a job
 * on a strictly serial promise chain — jobs never interleave. A CF-requested
 * immediate renegotiation is resolved *inside* the same job (not re-enqueued),
 * or it would deadlock behind its own enqueue.
 */
export class CloudflareSfuTransport implements MediaTransport {
  private readonly workspaceId: string
  private readonly callId: string
  private readonly post?: PostJson
  private readonly pcFactory: () => RTCPeerConnection

  private pc: RTCPeerConnection | null = null
  private proxy: CallProxyClient | null = null
  private descriptor: SessionDescriptor | null = null

  private readonly publishTransceivers = new Map<PublishedTrackKind, RTCRtpTransceiver>()
  /** mid → ref, so an `ontrack` can be attributed to the pull that requested it. */
  private readonly pullByMid = new Map<string, PeerTrackRef>()
  private readonly pulledRefs = new Map<string, PeerTrackRef>()

  private queue: Promise<unknown> = Promise.resolve()
  private _state: TransportConnectionState = "new"
  private closed = false

  onRemoteTrack: ((event: RemoteTrackEvent) => void) | null = null
  onRemoteTrackEnded: ((ref: PeerTrackRef) => void) | null = null
  onConnectionStateChange: ((state: TransportConnectionState) => void) | null = null

  constructor(deps: CloudflareSfuTransportDeps) {
    this.workspaceId = deps.workspaceId
    this.callId = deps.callId
    this.post = deps.post
    this.pcFactory = deps.createPeerConnection ?? (() => new RTCPeerConnection())
  }

  get connectionState(): TransportConnectionState {
    return this._state
  }

  private setState(state: TransportConnectionState): void {
    if (this._state === state) return
    this._state = state
    this.onConnectionStateChange?.(state)
  }

  /** Serialize a PC-mutating job behind the renegotiation queue. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => job())
    // Keep the chain alive even if a job rejects, so later jobs still run.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async connect(descriptor: SessionDescriptor): Promise<void> {
    if (this.pc) throw new Error("Transport already connected")
    this.descriptor = descriptor
    this.proxy = createCallProxyClient({
      workspaceId: this.workspaceId,
      callId: this.callId,
      endpointId: descriptor.endpointId,
      mediaIncarnation: descriptor.mediaIncarnation,
      post: this.post,
    })
    const pc = this.pcFactory()
    this.pc = pc
    this.setState("connecting")

    pc.ontrack = (event: RTCTrackEvent) => {
      const mid = event.transceiver?.mid ?? null
      const ref = mid ? this.pullByMid.get(mid) : undefined
      if (!ref) return
      this.onRemoteTrack?.({ ref, track: event.track })
      event.track.addEventListener("ended", () => this.onRemoteTrackEnded?.(ref))
    }
    pc.onconnectionstatechange = () => {
      if (this.closed) return
      switch (pc.connectionState) {
        case "connected":
          this.setState("connected")
          break
        case "disconnected":
          this.setState("reconnecting")
          break
        case "failed":
          this.setState("failed")
          break
        case "closed":
          this.setState("closed")
          break
      }
    }

    await this.enqueue(async () => {
      const created = await this.proxy!.createSession()
      // CF *may* return an initial offer on session create (spike-unconfirmed —
      // CLOUDFLARE_API.md Q2). Apply it defensively when present; otherwise the
      // first publish's offer bootstraps the connection.
      if (created.sessionDescription?.type === "offer") {
        await pc.setRemoteDescription(created.sessionDescription)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await this.proxy!.renegotiate({ type: "answer", sdp: answer.sdp ?? "" })
      }
    })
  }

  async publish(kind: PublishedTrackKind, track: MediaStreamTrack): Promise<void> {
    await this.enqueue(async () => {
      const pc = this.requirePc()
      const trackName = this.trackName(kind)
      let transceiver = this.publishTransceivers.get(kind)
      if (transceiver) {
        await transceiver.sender.replaceTrack(track)
        // A replaceTrack into an existing sendonly transceiver needs no SDP churn.
        return
      }
      transceiver = pc.addTransceiver(track, { direction: "sendonly" })
      this.publishTransceivers.set(kind, transceiver)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const result = await this.proxy!.publishTracks({
        sdp: { type: "offer", sdp: offer.sdp ?? "" },
        tracks: [{ kind, mid: transceiver.mid ?? "", trackName }],
      })
      await this.applyAnswerAndMaybeRenegotiate(result)
    })
  }

  async setPublishEncoding(kind: PublishedTrackKind, params: { maxBitrate?: number }): Promise<void> {
    const transceiver = this.publishTransceivers.get(kind)
    if (!transceiver) return
    const sender = transceiver.sender
    const current = sender.getParameters()
    if (!current.encodings || current.encodings.length === 0) current.encodings = [{}]
    for (const enc of current.encodings) {
      if (params.maxBitrate != null) enc.maxBitrate = params.maxBitrate
    }
    try {
      await sender.setParameters(current)
    } catch {
      // Some engines reject mid-stream parameter changes; the SFU still adapts.
    }
  }

  async unpublish(kind: PublishedTrackKind): Promise<void> {
    await this.enqueue(async () => {
      const transceiver = this.publishTransceivers.get(kind)
      if (!transceiver) return
      this.publishTransceivers.delete(kind)
      const mid = transceiver.mid
      await transceiver.sender.replaceTrack(null)
      try {
        transceiver.stop()
      } catch {
        // Some engines throw if the transceiver is already stopping; ignore.
      }
      if (!mid) return
      const pc = this.requirePc()
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await this.proxy!.closeTracks({
        mids: [mid],
        unpublishKinds: [kind],
        sdp: { type: "offer", sdp: offer.sdp ?? "" },
      })
    })
  }

  async pull(ref: PeerTrackRef): Promise<void> {
    await this.enqueue(async () => {
      const pc = this.requirePc()
      const result = await this.proxy!.pullTracks([ref])
      for (const t of result.tracks) {
        if (t.mid) this.pullByMid.set(t.mid, ref)
      }
      this.pulledRefs.set(this.refKey(ref), ref)
      // A pull answers with an OFFER (CF adds the remote m-line); we answer it.
      if (result.sessionDescription?.type === "offer") {
        await pc.setRemoteDescription(result.sessionDescription)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await this.proxy!.renegotiate({ type: "answer", sdp: answer.sdp ?? "" })
      } else if (result.requiresImmediateRenegotiation) {
        await this.renegotiateFromRemote()
      }
    })
  }

  async stopPull(ref: PeerTrackRef): Promise<void> {
    await this.enqueue(async () => {
      const key = this.refKey(ref)
      if (!this.pulledRefs.has(key)) return
      this.pulledRefs.delete(key)
      const mids: string[] = []
      for (const [mid, r] of this.pullByMid) {
        if (this.refKey(r) === key) mids.push(mid)
      }
      for (const mid of mids) this.pullByMid.delete(mid)
      if (mids.length === 0) return
      await this.proxy!.closeTracks({ mids })
    })
  }

  async getStats(): Promise<TransportStats> {
    const pc = this.pc
    if (!pc) return { rttMs: null, packetLoss: null, qualityLimitation: null, encodeTimeMs: null }
    const report = await pc.getStats()
    let rttMs: number | null = null
    let packetLoss: number | null = null
    let encodeTimeMs: number | null = null
    const qualityReasons: Array<string | undefined> = []
    let received = 0
    let lost = 0
    report.forEach((s) => {
      const stat = s as Record<string, unknown> & { type: string }
      if (stat.type === "candidate-pair" && stat.nominated && typeof stat.currentRoundTripTime === "number") {
        rttMs = stat.currentRoundTripTime * 1000
      }
      if (stat.type === "outbound-rtp" && (stat.kind === "video" || stat.mediaType === "video")) {
        qualityReasons.push(stat.qualityLimitationReason as string | undefined)
        if (
          typeof stat.totalEncodeTime === "number" &&
          typeof stat.framesEncoded === "number" &&
          stat.framesEncoded > 0
        ) {
          encodeTimeMs = (stat.totalEncodeTime / stat.framesEncoded) * 1000
        }
      }
      if (stat.type === "inbound-rtp") {
        if (typeof stat.packetsReceived === "number") received += stat.packetsReceived
        if (typeof stat.packetsLost === "number") lost += stat.packetsLost
      }
    })
    if (received + lost > 0) packetLoss = lost / (received + lost)
    return { rttMs, packetLoss, qualityLimitation: pickWorst(qualityReasons), encodeTimeMs }
  }

  async close(): Promise<void> {
    this.closed = true
    this.setState("closed")
    // Best-effort CF track teardown before dropping the PC so media stops
    // promptly rather than lingering to CF's inactivity timeout.
    const pc = this.pc
    this.pc = null
    if (pc) {
      pc.ontrack = null
      pc.onconnectionstatechange = null
      try {
        pc.close()
      } catch {
        // ignore
      }
    }
    this.publishTransceivers.clear()
    this.pullByMid.clear()
    this.pulledRefs.clear()
  }

  private async applyAnswerAndMaybeRenegotiate(result: CfTracksResult): Promise<void> {
    const pc = this.requirePc()
    if (result.sessionDescription?.type === "answer") {
      await pc.setRemoteDescription(result.sessionDescription)
    }
    if (result.requiresImmediateRenegotiation) {
      await this.renegotiateFromRemote()
    }
  }

  /**
   * Resolve a CF-initiated renegotiation inline within the current job. CF hands
   * us an offer via the renegotiate endpoint's answer path only on explicit
   * pull; the immediate-renegotiation flag here re-drives an offer/answer we own.
   */
  private async renegotiateFromRemote(): Promise<void> {
    const pc = this.requirePc()
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const result = await this.proxy!.renegotiate({ type: "offer", sdp: offer.sdp ?? "" })
    if (result.sessionDescription?.type === "answer") {
      await pc.setRemoteDescription(result.sessionDescription)
    }
  }

  private requirePc(): RTCPeerConnection {
    if (!this.pc) throw new Error("Transport is not connected")
    return this.pc
  }

  private trackName(kind: PublishedTrackKind): string {
    return `${this.descriptor!.endpointId}:${kind}`
  }

  private refKey(ref: PeerTrackRef): string {
    return `${ref.sessionId}:${ref.trackName}`
  }
}
