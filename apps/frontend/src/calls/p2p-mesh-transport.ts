import { api } from "@/api/client"
import type { P2pSignalEnvelope, TurnCredentialsResponse } from "@threahq/types"
import type {
  MediaTransport,
  PeerDescriptor,
  PeerTrackRef,
  RemoteTrackEvent,
  SessionDescriptor,
  TransportConnectionState,
  TransportStats,
} from "./media-transport"
import type { PublishedTrackKind } from "./config"

interface Signaling {
  emit(event: string, payload: unknown, ack?: (result: unknown) => void): void
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
}

interface PeerState {
  identity: PeerDescriptor & { mediaIncarnation: string }
  pc: RTCPeerConnection
  token: symbol
  polite: boolean
  makingOffer: boolean
  ignoreOfferId: string | null
  pendingCandidates: Map<string, RTCIceCandidateInit[]>
  localNegotiationId: string
  negotiationByUfrag: Map<string, string>
  remoteNegotiationId: string | null
  remoteTracks: Map<PublishedTrackKind, MediaStreamTrack>
  emittedRefs: Map<PublishedTrackKind, PeerTrackRef>
  senders: Map<PublishedTrackKind, RTCRtpSender>
  restartAttempts: number
  negotiationAttempts: number
  negotiationTimer: ReturnType<typeof setTimeout> | null
  offerRetryTimer: ReturnType<typeof setTimeout> | null
  queue: Promise<void>
}

const MAX_PENDING_NEGOTIATIONS = 8
const MAX_CANDIDATES_PER_NEGOTIATION = 256
const MAX_RESTART_ATTEMPTS = 2
const MAX_NEGOTIATION_ATTEMPTS = 6

export class P2pMeshTransport implements MediaTransport {
  private descriptor: SessionDescriptor | null = null
  private readonly generation: number
  private readonly peers = new Map<string, PeerState>()
  private readonly tracks = new Map<PublishedTrackKind, MediaStreamTrack>()
  private readonly publicationIds = new Map<PublishedTrackKind, string>()
  private readonly encodingSettings = new Map<PublishedTrackKind, { maxBitrate?: number }>()
  private iceServers: RTCIceServer[] = []
  private closed = false
  private lifecycle = 0
  private _state: TransportConnectionState = "new"
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshFailures = 0
  private credentialsExpireAt = 0
  private publicationRevision = 0
  private publicationAckedRevision = 0
  private publicationTimer: ReturnType<typeof setTimeout> | null = null

  onRemoteTrack: ((event: RemoteTrackEvent) => void) | null = null
  onRemoteTrackEnded: ((ref: PeerTrackRef) => void) | null = null
  onConnectionStateChange: ((state: TransportConnectionState) => void) | null = null

  constructor(
    private readonly deps: {
      workspaceId: string
      callId: string
      socket: Signaling
      generation: number
      createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection
      fetchCredentials?: (endpointId: string, mediaIncarnation: string) => Promise<TurnCredentialsResponse>
    }
  ) {
    this.generation = deps.generation
  }

  get connectionState(): TransportConnectionState {
    return this._state
  }

  async connect(descriptor: SessionDescriptor): Promise<void> {
    if (this.descriptor) throw new Error("Transport already connected")
    this.descriptor = descriptor
    const lifecycle = ++this.lifecycle
    this.setState("connecting")
    await this.refreshCredentials(lifecycle, true)
    if (!this.isLive(lifecycle)) return
    this.deps.socket.on("call:p2p:signal", this.onSignal)
    this.setState("connected")
    this.reconcilePublications()
  }

  async syncPeers(peers: PeerDescriptor[], generation: number): Promise<void> {
    if (generation !== this.generation || this.closed) return
    const desired = new Map(
      peers
        .filter(
          (peer): peer is PeerDescriptor & { mediaIncarnation: string } =>
            peer.endpointId !== this.descriptor?.endpointId && !!peer.mediaIncarnation
        )
        .map((peer) => [peer.endpointId, peer])
    )
    for (const [id, state] of this.peers) {
      const next = desired.get(id)
      if (!next || next.epoch !== state.identity.epoch || next.mediaIncarnation !== state.identity.mediaIncarnation) {
        this.removePeer(state)
      }
    }
    for (const peer of desired.values()) {
      const state = this.peers.get(peer.endpointId) ?? this.createPeer(peer)
      state.identity = peer
      this.reconcileRemoteTracks(state)
    }
    this.reconcilePublications()
  }

  async publish(kind: PublishedTrackKind, track: MediaStreamTrack): Promise<void> {
    this.tracks.set(kind, track)
    this.publicationIds.set(kind, crypto.randomUUID())
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, async () => {
          if (!this.isCurrent(state)) return
          let sender = state.senders.get(kind)
          if (!sender) {
            sender = state.pc.addTransceiver(track, { direction: "sendrecv" }).sender
            state.senders.set(kind, sender)
            this.scheduleNegotiation(state, state.polite ? 300 : 50)
          } else {
            await sender.replaceTrack(track)
          }
          await this.applyEncoding(sender, this.encodingSettings.get(kind))
        })
      )
    )
    this.bumpPublications()
  }

  async unpublish(kind: PublishedTrackKind): Promise<void> {
    this.tracks.delete(kind)
    this.publicationIds.delete(kind)
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, async () => {
          const sender = state.senders.get(kind)
          if (sender && this.isCurrent(state)) await sender.replaceTrack(null)
        })
      )
    )
    this.bumpPublications()
  }

  async setPublishEncoding(kind: PublishedTrackKind, params: { maxBitrate?: number }): Promise<void> {
    this.encodingSettings.set(kind, params)
    await Promise.all([...this.peers.values()].map(({ senders }) => this.applyEncoding(senders.get(kind), params)))
  }

  async pull(): Promise<void> {}
  async stopPull(): Promise<void> {}

  async reconnect(): Promise<void> {
    this.reconcilePublications()
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, async () => {
          if (!this.isCurrent(state)) return
          state.negotiationAttempts = 0
          state.pc.restartIce()
          await this.negotiate(state)
        })
      )
    )
  }

  async getStats(): Promise<TransportStats> {
    let rttMs: number | null = null
    let candidateType: "host" | "srflx" | "relay" | null = null
    let bytesSent = 0
    let bytesReceived = 0
    for (const { pc } of this.peers.values()) {
      const report = await pc.getStats()
      let selectedPairId: string | null = null
      report.forEach((value) => {
        const stat = value as Record<string, unknown> & { type: string }
        if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string")
          selectedPairId = stat.selectedCandidatePairId
        if (stat.type === "outbound-rtp" && typeof stat.bytesSent === "number") bytesSent += stat.bytesSent
        if (stat.type === "inbound-rtp" && typeof stat.bytesReceived === "number") bytesReceived += stat.bytesReceived
      })
      const pairs: Array<Record<string, unknown> & { id: string; type: string }> = []
      report.forEach((value) => {
        const stat = value as Record<string, unknown> & { id: string; type: string }
        if (stat.type === "candidate-pair" && stat.state === "succeeded") pairs.push(stat)
      })
      const selected =
        pairs.find((pair) => pair.id === selectedPairId) ??
        pairs.find((pair) => pair.nominated === true || pair.selected === true) ??
        (pairs.length === 1 ? pairs[0] : null)
      if (selected) {
        if (typeof selected.currentRoundTripTime === "number") rttMs = selected.currentRoundTripTime * 1000
        const local = report.get(String(selected.localCandidateId)) as
          | (RTCStats & { candidateType?: string })
          | undefined
        const remote = report.get(String(selected.remoteCandidateId)) as
          | (RTCStats & { candidateType?: string })
          | undefined
        if (local?.candidateType === "relay" || remote?.candidateType === "relay") candidateType = "relay"
        else if (local?.candidateType === "host" || local?.candidateType === "srflx")
          candidateType = local.candidateType
      }
    }
    return {
      rttMs,
      packetLoss: null,
      qualityLimitation: null,
      encodeTimeMs: null,
      candidateType,
      bytesSent,
      bytesReceived,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle++
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.publicationTimer) clearTimeout(this.publicationTimer)
    this.deps.socket.off("call:p2p:signal", this.onSignal)
    for (const state of [...this.peers.values()]) this.removePeer(state)
    this.setState("closed")
  }

  private createPeer(peer: PeerDescriptor & { mediaIncarnation: string }): PeerState {
    const pc = (this.deps.createPeerConnection ?? ((config) => new RTCPeerConnection(config)))({
      iceServers: this.iceServers,
    })
    const state: PeerState = {
      identity: peer,
      pc,
      token: Symbol(),
      polite: this.descriptor!.endpointId.localeCompare(peer.endpointId) > 0,
      makingOffer: false,
      ignoreOfferId: null,
      pendingCandidates: new Map(),
      localNegotiationId: crypto.randomUUID(),
      negotiationByUfrag: new Map(),
      remoteNegotiationId: null,
      remoteTracks: new Map(),
      emittedRefs: new Map(),
      senders: new Map(),
      restartAttempts: 0,
      negotiationAttempts: 0,
      negotiationTimer: null,
      offerRetryTimer: null,
      queue: Promise.resolve(),
    }
    this.peers.set(peer.endpointId, state)
    for (const [kind, track] of this.tracks) {
      const sender = pc.addTransceiver(track, { direction: "sendrecv" }).sender
      state.senders.set(kind, sender)
      void this.applyEncoding(sender, this.encodingSettings.get(kind))
    }
    pc.ontrack = (event) => {
      if (!this.isCurrent(state)) return
      const kind: PublishedTrackKind = event.track.kind === "audio" ? "mic" : "camera"
      const trackChanged = state.remoteTracks.get(kind) !== event.track
      state.remoteTracks.set(kind, event.track)
      this.reconcileRemoteTrack(state, kind, trackChanged)
      const token = state.token
      event.track.addEventListener(
        "ended",
        () => {
          if (!this.isCurrent(state, token) || state.remoteTracks.get(kind) !== event.track) return
          state.remoteTracks.delete(kind)
          const ref = state.emittedRefs.get(kind)
          state.emittedRefs.delete(kind)
          if (ref) this.onRemoteTrackEnded?.(ref)
        },
        { once: true }
      )
    }
    pc.onicecandidate = (event) => {
      if (!this.isCurrent(state)) return
      const negotiationId = event.candidate?.usernameFragment
        ? (state.negotiationByUfrag.get(event.candidate.usernameFragment) ?? state.localNegotiationId)
        : state.localNegotiationId
      this.send(
        state,
        event.candidate ? "candidate" : "end-of-candidates",
        { candidate: event.candidate?.toJSON() },
        negotiationId
      )
    }
    pc.onnegotiationneeded = () => this.scheduleNegotiation(state, state.polite ? 300 : 50)
    pc.onconnectionstatechange = () => this.handleConnectionState(state)
    this.scheduleNegotiation(state, state.polite ? 300 : 50)
    return state
  }

  private reconcileRemoteTracks(state: PeerState): void {
    for (const kind of state.remoteTracks.keys()) this.reconcileRemoteTrack(state, kind)
    for (const [kind, ref] of state.emittedRefs) {
      if (
        !state.identity.publications.some(
          (publication) => publication.ref.kind === kind && publication.ref.publicationId === ref.publicationId
        )
      ) {
        state.emittedRefs.delete(kind)
        this.onRemoteTrackEnded?.(ref)
      }
    }
  }

  private reconcileRemoteTrack(state: PeerState, kind: PublishedTrackKind, trackChanged = false): void {
    const track = state.remoteTracks.get(kind)
    const publication = state.identity.publications.find((candidate) => candidate.ref.kind === kind)
    if (!track || !publication) return
    const prior = state.emittedRefs.get(kind)
    if (
      !trackChanged &&
      prior?.publicationId === publication.ref.publicationId &&
      prior.endpointId === publication.ref.endpointId
    )
      return
    state.emittedRefs.set(kind, publication.ref)
    this.onRemoteTrack?.({ ref: publication.ref, track })
  }

  private removePeer(state: PeerState): void {
    if (this.peers.get(state.identity.endpointId) !== state) return
    this.peers.delete(state.identity.endpointId)
    if (state.negotiationTimer) clearTimeout(state.negotiationTimer)
    if (state.offerRetryTimer) clearTimeout(state.offerRetryTimer)
    state.pc.ontrack = null
    state.pc.onicecandidate = null
    state.pc.onnegotiationneeded = null
    state.pc.onconnectionstatechange = null
    for (const ref of state.emittedRefs.values()) this.onRemoteTrackEnded?.(ref)
    state.emittedRefs.clear()
    state.remoteTracks.clear()
    state.pc.close()
    if (!this.closed) this.updateAggregateState()
  }

  private handleConnectionState(state: PeerState): void {
    if (!this.isCurrent(state)) return
    const connectionState = state.pc.connectionState
    if (connectionState === "connected") {
      this.clearOfferRetry(state)
      state.restartAttempts = 0
      this.updateAggregateState()
    } else if (connectionState === "disconnected") {
      this.setState("reconnecting")
    } else if (connectionState === "failed") {
      this.setState("reconnecting")
      if (state.restartAttempts >= MAX_RESTART_ATTEMPTS) return this.setState("failed")
      state.restartAttempts++
      void this.enqueue(state, async () => {
        if (!this.isCurrent(state)) return
        state.pc.restartIce()
        await this.negotiate(state)
      })
    }
  }

  private updateAggregateState(): void {
    const states = [...this.peers.values()].map(({ pc }) => pc.connectionState)
    if (states.some((state) => state === "failed")) this.setState("failed")
    else if (states.some((state) => state === "disconnected" || state === "connecting" || state === "new"))
      this.setState("reconnecting")
    else this.setState("connected")
  }

  private scheduleNegotiation(state: PeerState, delayMs: number): void {
    if (!this.isCurrent(state) || state.negotiationTimer) return
    state.negotiationTimer = setTimeout(() => {
      state.negotiationTimer = null
      void this.enqueue(state, () => this.negotiate(state))
    }, delayMs)
  }

  private onSignal = (raw: unknown): void => {
    const signal = raw as P2pSignalEnvelope
    if (
      signal.callId !== this.deps.callId ||
      signal.generation !== this.generation ||
      signal.recipientEndpointId !== this.descriptor?.endpointId ||
      signal.recipientMediaIncarnation !== this.descriptor.mediaIncarnation
    )
      return
    const state = this.peers.get(signal.senderEndpointId)
    if (
      !state ||
      state.identity.epoch !== signal.senderEpoch ||
      state.identity.mediaIncarnation !== signal.senderMediaIncarnation
    )
      return
    void this.enqueue(state, () => this.applySignal(state, signal))
  }

  private async applySignal(state: PeerState, signal: P2pSignalEnvelope): Promise<void> {
    if (!this.isCurrent(state)) return
    if (signal.description) {
      if (signal.description.type === "answer" && signal.negotiationId !== state.localNegotiationId) return
      const collision =
        signal.description.type === "offer" && (state.makingOffer || state.pc.signalingState !== "stable")
      state.ignoreOfferId = !state.polite && collision ? signal.negotiationId : null
      if (state.ignoreOfferId) return
      if (collision) await state.pc.setLocalDescription({ type: "rollback" })
      if (!this.isCurrent(state)) return
      state.remoteNegotiationId = signal.negotiationId
      await state.pc.setRemoteDescription(signal.description)
      if (!this.isCurrent(state)) return
      for (const candidate of state.pendingCandidates.get(signal.negotiationId) ?? [])
        await this.addIceCandidate(state, signal.negotiationId, candidate)
      state.pendingCandidates.delete(signal.negotiationId)
      if (signal.description.type === "answer") this.clearOfferRetry(state)
      if (signal.description.type === "offer") {
        await state.pc.setLocalDescription(await state.pc.createAnswer())
        if (!this.isCurrent(state)) return
        this.rememberLocalUfrag(state, signal.negotiationId)
        this.send(state, "description", { description: this.localDescription(state.pc) }, signal.negotiationId)
      }
    } else if (signal.kind === "candidate" && signal.candidate) {
      if (state.ignoreOfferId === signal.negotiationId) return
      if (state.pc.remoteDescription && state.remoteNegotiationId === signal.negotiationId)
        await this.addIceCandidate(state, signal.negotiationId, signal.candidate)
      else this.bufferCandidate(state, signal.negotiationId, signal.candidate)
    }
  }

  private async addIceCandidate(
    state: PeerState,
    negotiationId: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    try {
      await state.pc.addIceCandidate(candidate)
    } catch (error) {
      console.warn("P2P ICE candidate rejected", {
        endpointId: state.identity.endpointId,
        negotiationId,
        error,
      })
    }
  }

  private bufferCandidate(state: PeerState, negotiationId: string, candidate: RTCIceCandidateInit): void {
    if (!state.pendingCandidates.has(negotiationId) && state.pendingCandidates.size >= MAX_PENDING_NEGOTIATIONS) {
      state.pendingCandidates.delete(state.pendingCandidates.keys().next().value!)
    }
    const pending = state.pendingCandidates.get(negotiationId) ?? []
    if (pending.length < MAX_CANDIDATES_PER_NEGOTIATION) pending.push(candidate)
    state.pendingCandidates.set(negotiationId, pending)
  }

  private async negotiate(state: PeerState): Promise<void> {
    if (!this.isCurrent(state) || state.makingOffer) return
    if (state.pc.signalingState === "have-local-offer" && state.negotiationAttempts > 0)
      await state.pc.setLocalDescription({ type: "rollback" })
    if (!this.isCurrent(state) || state.pc.signalingState !== "stable") return
    try {
      state.makingOffer = true
      state.localNegotiationId = crypto.randomUUID()
      await state.pc.setLocalDescription(await state.pc.createOffer())
      if (!this.isCurrent(state)) return
      this.rememberLocalUfrag(state)
      this.send(state, "description", { description: this.localDescription(state.pc) })
      state.negotiationAttempts++
      if (state.negotiationAttempts < MAX_NEGOTIATION_ATTEMPTS) this.scheduleOfferRetry(state)
      else this.setState("failed")
    } finally {
      state.makingOffer = false
    }
  }

  private scheduleOfferRetry(state: PeerState): void {
    if (!this.isCurrent(state) || state.offerRetryTimer) return
    state.offerRetryTimer = setTimeout(() => {
      state.offerRetryTimer = null
      void this.enqueue(state, () => this.negotiate(state))
    }, 1_500)
  }

  private clearOfferRetry(state: PeerState): void {
    if (state.offerRetryTimer) clearTimeout(state.offerRetryTimer)
    state.offerRetryTimer = null
    state.negotiationAttempts = 0
  }

  private rememberLocalUfrag(state: PeerState, negotiationId = state.localNegotiationId): void {
    const matches = state.pc.localDescription?.sdp?.matchAll(/^a=ice-ufrag:(.+)$/gm)
    if (!matches) return
    for (const match of matches) state.negotiationByUfrag.set(match[1].trim(), negotiationId)
    while (state.negotiationByUfrag.size > MAX_PENDING_NEGOTIATIONS)
      state.negotiationByUfrag.delete(state.negotiationByUfrag.keys().next().value!)
  }

  private localDescription(pc: RTCPeerConnection): RTCSessionDescriptionInit | undefined {
    const description = pc.localDescription
    return description ? { type: description.type, sdp: description.sdp } : undefined
  }

  private send(
    state: PeerState,
    kind: string,
    extra: Record<string, unknown>,
    negotiationId = state.localNegotiationId
  ): void {
    if (!this.isCurrent(state)) return
    this.deps.socket.emit("call:p2p:signal", {
      callId: this.deps.callId,
      recipientEndpointId: state.identity.endpointId,
      recipientEpoch: state.identity.epoch,
      recipientMediaIncarnation: state.identity.mediaIncarnation,
      generation: this.generation,
      negotiationId,
      kind,
      ...extra,
    })
  }

  private enqueue(state: PeerState, operation: () => Promise<void>): Promise<void> {
    const token = state.token
    const result = state.queue.then(async () => {
      if (!this.isCurrent(state, token)) return
      await operation()
    })
    state.queue = result.catch(() => {
      if (this.isCurrent(state, token)) this.setState("failed")
    })
    return result
  }

  private bumpPublications(): void {
    this.publicationRevision++
    this.reconcilePublications()
  }

  private reconcilePublications(): void {
    if (this.closed || this.publicationRevision <= this.publicationAckedRevision || this.publicationTimer) return
    const revision = this.publicationRevision
    this.deps.socket.emit(
      "call:p2p:publications",
      {
        generation: this.generation,
        revision,
        publications: [...this.publicationIds].map(([kind, publicationId]) => ({ kind, publicationId })),
      },
      (raw) => {
        if (this.closed) return
        const ack = raw as { ok?: boolean }
        if (ack?.ok) this.publicationAckedRevision = Math.max(this.publicationAckedRevision, revision)
        this.schedulePublicationRetry()
      }
    )
    this.schedulePublicationRetry()
  }

  private schedulePublicationRetry(): void {
    if (this.closed || this.publicationAckedRevision >= this.publicationRevision || this.publicationTimer) return
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = null
      this.reconcilePublications()
    }, 1_000)
  }

  private async refreshCredentials(lifecycle: number, initial = false): Promise<void> {
    try {
      const descriptor = this.descriptor!
      const credentials = await (this.deps.fetchCredentials
        ? this.deps.fetchCredentials(descriptor.endpointId, descriptor.mediaIncarnation)
        : api.post<TurnCredentialsResponse>(
            `/api/workspaces/${this.deps.workspaceId}/calls/${this.deps.callId}/endpoints/${descriptor.endpointId}/turn-credentials`,
            { mediaIncarnation: descriptor.mediaIncarnation }
          ))
      if (!this.isLive(lifecycle)) return
      this.iceServers = credentials.iceServers
      this.credentialsExpireAt = new Date(credentials.expiresAt).getTime()
      this.refreshFailures = 0
      for (const { pc } of this.peers.values())
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers: this.iceServers })
      const refreshIn = Math.max(1_000, this.credentialsExpireAt - Date.now() - 60_000)
      this.refreshTimer = setTimeout(() => void this.refreshCredentials(lifecycle), refreshIn)
    } catch (error) {
      if (!this.isLive(lifecycle)) return
      if (initial && this.credentialsExpireAt === 0) {
        this.setState("failed")
        throw error
      }
      this.refreshFailures++
      if (Date.now() >= this.credentialsExpireAt && this.credentialsExpireAt > 0) this.setState("failed")
      else this.setState("reconnecting")
      const retryIn = Math.min(30_000, 1_000 * 2 ** Math.min(this.refreshFailures, 5))
      this.refreshTimer = setTimeout(() => void this.refreshCredentials(lifecycle), retryIn)
    }
  }

  private async applyEncoding(
    sender: RTCRtpSender | undefined,
    params: { maxBitrate?: number } | undefined
  ): Promise<void> {
    if (!sender || !params) return
    const current = sender.getParameters()
    if (!current.encodings?.length) current.encodings = [{}]
    for (const encoding of current.encodings) encoding.maxBitrate = params.maxBitrate
    await sender.setParameters(current).catch(() => {})
  }

  private isCurrent(state: PeerState, token = state.token): boolean {
    return !this.closed && state.token === token && this.peers.get(state.identity.endpointId) === state
  }

  private isLive(lifecycle: number): boolean {
    return !this.closed && lifecycle === this.lifecycle
  }

  private setState(state: TransportConnectionState): void {
    if (state === this._state || (this.closed && state !== "closed")) return
    this._state = state
    this.onConnectionStateChange?.(state)
  }
}
