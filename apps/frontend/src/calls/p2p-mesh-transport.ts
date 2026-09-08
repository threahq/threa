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
import { P2pTrafficCounter } from "./p2p-traffic-counter"

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
const INITIAL_OFFER_DELAY_MS = 50
const MAX_PENDING_PEERS = 8
const MAX_SIGNALS_PER_PENDING_PEER = 64
const P2P_TRACK_KINDS: ReadonlyArray<[PublishedTrackKind, "audio" | "video"]> = [
  ["mic", "audio"],
  ["camera", "video"],
]

export class P2pMeshTransport implements MediaTransport {
  private descriptor: SessionDescriptor | null = null
  private readonly generation: number
  private readonly peers = new Map<string, PeerState>()
  private readonly pendingPeerSignals = new Map<string, P2pSignalEnvelope[]>()
  private readonly tracks = new Map<PublishedTrackKind, MediaStreamTrack>()
  private readonly publicationIds = new Map<PublishedTrackKind, string>()
  private readonly encodingSettings = new Map<PublishedTrackKind, { maxBitrate?: number }>()
  private readonly peerEncodingSettings = new Map<string, Map<PublishedTrackKind, { maxBitrate?: number }>>()
  private iceServers: RTCIceServer[] = []
  private ready = false
  private pendingPeers: PeerDescriptor[] | null = null
  private closed = false
  private lifecycle = 0
  private _state: TransportConnectionState = "new"
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private refreshFailures = 0
  private credentialsExpireAt = 0
  private publicationRevision = 0
  private publicationAckedRevision = 0
  private publicationTimer: ReturnType<typeof setTimeout> | null = null
  private readonly traffic = new P2pTrafficCounter()
  private readonly finalTrafficSamples = new Set<Promise<void>>()
  private readonly peerRecoveryAttempts = new Map<string, number>()
  private readonly inboundByteSamples = new Map<string, number>()

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
    this.deps.socket.on("call:p2p:signal", this.onSignal)
    try {
      await this.refreshCredentials(lifecycle, true)
    } catch (error) {
      this.deps.socket.off("call:p2p:signal", this.onSignal)
      this.pendingPeerSignals.clear()
      this.pendingPeers = null
      throw error
    }
    if (!this.isLive(lifecycle)) return
    this.ready = true
    const pendingPeers = this.pendingPeers
    this.pendingPeers = null
    if (pendingPeers) await this.syncPeers(pendingPeers, this.generation)
    if (!this.isLive(lifecycle)) return
    this.setState("connected")
    this.reconcilePublications()
  }

  async syncPeers(peers: PeerDescriptor[], generation: number): Promise<void> {
    if (generation !== this.generation || this.closed) return
    if (!this.ready) {
      this.pendingPeers = peers
      return
    }
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
        this.removePeer(state, next !== undefined)
        if (!next) this.peerRecoveryAttempts.delete(id)
      }
    }
    for (const peer of desired.values()) {
      const state = this.peers.get(peer.endpointId) ?? this.createPeer(peer)
      state.identity = peer
      this.reconcileRemoteTracks(state)
      this.replayPendingSignals(state)
    }
    await this.applyEncodingToAllPeers("camera")
    this.reconcilePublications()
  }

  async publish(kind: PublishedTrackKind, track: MediaStreamTrack): Promise<void> {
    this.tracks.set(kind, track)
    this.publicationIds.set(kind, crypto.randomUUID())
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, async () => {
          if (!this.isCurrent(state)) return
          const sender = state.senders.get(kind)
          if (!sender) return
          await sender.replaceTrack(track)
          await this.applyEncoding(sender, this.peerEncoding(state, kind))
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
    await this.applyEncodingToAllPeers(kind)
  }

  async setPeerPublishEncoding(
    endpointId: string,
    kind: PublishedTrackKind,
    params: { maxBitrate?: number }
  ): Promise<void> {
    const settings = this.peerEncodingSettings.get(endpointId) ?? new Map()
    settings.set(kind, params)
    this.peerEncodingSettings.set(endpointId, settings)
    const state = this.peers.get(endpointId)
    if (!state) return
    await this.enqueue(state, () => this.applyEncoding(state.senders.get(kind), this.peerEncoding(state, kind)))
  }

  async pull(): Promise<void> {}
  async stopPull(): Promise<void> {}

  async reconnect(): Promise<void> {
    this.reconcilePublications()
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, async () => {
          if (!this.isCurrent(state)) return
          await this.restartPeerIce(state)
        })
      )
    )
  }

  async hasInboundByteProgress(ref: PeerTrackRef): Promise<boolean> {
    const state = this.peers.get(ref.endpointId)
    const track = state?.remoteTracks.get(ref.kind)
    if (!state || !track || state.emittedRefs.get(ref.kind)?.publicationId !== ref.publicationId) return false
    const report = await state.pc.getStats()
    let bytes: number | null = null
    report.forEach((value) => {
      const stat = value as Record<string, unknown> & { type: string }
      if (stat.type === "inbound-rtp" && stat.trackIdentifier === track.id && typeof stat.bytesReceived === "number")
        bytes = Math.max(bytes ?? 0, stat.bytesReceived)
    })
    if (bytes === null) return false
    const key = JSON.stringify([ref.endpointId, ref.kind, ref.publicationId])
    const previous = this.inboundByteSamples.get(key)
    this.inboundByteSamples.set(key, bytes)
    return previous !== undefined && bytes > previous
  }

  hasEstablishedOwnPublications(): boolean {
    return this._state === "connected" && this.publicationAckedRevision >= this.publicationRevision
  }

  async getStats(): Promise<TransportStats> {
    await Promise.all(this.finalTrafficSamples)
    const peers = (
      await Promise.all(
        [...this.peers.values()].map(async (state) => {
          const report = await state.pc.getStats()
          if (!this.isCurrent(state)) return null
          let encodeTimeMs: number | null = null
          const qualityReasons: string[] = []
          report.forEach((value) => {
            const stat = value as Record<string, unknown> & { type: string }
            if (stat.type === "outbound-rtp") {
              if (stat.kind === "video" || stat.mediaType === "video") {
                if (typeof stat.qualityLimitationReason === "string") qualityReasons.push(stat.qualityLimitationReason)
                if (
                  typeof stat.totalEncodeTime === "number" &&
                  typeof stat.framesEncoded === "number" &&
                  stat.framesEncoded > 0
                )
                  encodeTimeMs = Math.max(encodeTimeMs ?? 0, (stat.totalEncodeTime / stat.framesEncoded) * 1000)
              }
            }
          })
          const { candidateType, rttMs, ...path } = selectedTrafficPath(report)
          const {
            bytesSent: intervalBytesSent,
            bytesReceived: intervalBytesReceived,
            packetsReceived,
            packetsLost,
          } = this.traffic.observe(state.token, report, path)
          return {
            endpointId: state.identity.endpointId,
            candidateType,
            rttMs,
            packetLoss: packetsReceived + packetsLost > 0 ? packetsLost / (packetsReceived + packetsLost) : null,
            qualityLimitation: this.pickWorstQuality(qualityReasons),
            encodeTimeMs,
            intervalBytesSent,
            intervalBytesReceived,
            packetsReceived,
            packetsLost,
          }
        })
      )
    ).filter((peer) => peer !== null)
    const knownRtts = peers.flatMap((peer) => (peer.rttMs == null ? [] : [peer.rttMs]))
    const receivedPackets = peers.reduce((sum, peer) => sum + peer.packetsReceived, 0)
    const lostPackets = peers.reduce((sum, peer) => sum + peer.packetsLost, 0)
    const qualities = peers.flatMap((peer) => (peer.qualityLimitation ? [peer.qualityLimitation] : []))
    const encodeTimes = peers.flatMap((peer) => (peer.encodeTimeMs == null ? [] : [peer.encodeTimeMs]))
    const candidateTypes = peers.flatMap((peer) => (peer.candidateType ? [peer.candidateType] : []))
    return {
      rttMs: knownRtts.length ? Math.max(...knownRtts) : null,
      packetLoss: receivedPackets + lostPackets > 0 ? lostPackets / (receivedPackets + lostPackets) : null,
      qualityLimitation: this.pickWorstQuality(qualities),
      encodeTimeMs: encodeTimes.length ? Math.max(...encodeTimes) : null,
      candidateType: candidateTypes.includes("relay") ? "relay" : (candidateTypes[0] ?? null),
      bytesSent: peers.reduce((sum, peer) => sum + peer.intervalBytesSent, 0),
      bytesReceived: peers.reduce((sum, peer) => sum + peer.intervalBytesReceived, 0),
      peers: peers.map(({ packetsReceived: _received, packetsLost: _lost, ...peer }) => peer),
      ...this.traffic.totals,
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.ready = false
    this.pendingPeers = null
    this.lifecycle++
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    if (this.publicationTimer) clearTimeout(this.publicationTimer)
    this.deps.socket.off("call:p2p:signal", this.onSignal)
    this.pendingPeerSignals.clear()
    this.inboundByteSamples.clear()
    for (const state of [...this.peers.values()]) this.removePeer(state)
    await Promise.all(this.finalTrafficSamples)
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
    // Preallocating on the answerer creates duplicate m-lines when its first remote offer arrives.
    if (!state.polite) this.initializeSenderSlots(state)
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
      const fallbackNegotiationId =
        state.pc.localDescription?.type === "answer"
          ? (state.remoteNegotiationId ?? state.localNegotiationId)
          : state.localNegotiationId
      const negotiationId = event.candidate?.usernameFragment
        ? (state.negotiationByUfrag.get(event.candidate.usernameFragment) ?? fallbackNegotiationId)
        : fallbackNegotiationId
      this.send(
        state,
        event.candidate ? "candidate" : "end-of-candidates",
        { candidate: event.candidate?.toJSON() },
        negotiationId
      )
    }
    pc.onnegotiationneeded = () => {
      if (state.pc.localDescription === null && state.senders.size > 0)
        this.scheduleNegotiation(state, INITIAL_OFFER_DELAY_MS)
    }
    pc.onconnectionstatechange = () => this.handleConnectionState(state)
    if (!state.polite) this.scheduleNegotiation(state, INITIAL_OFFER_DELAY_MS)
    return state
  }

  private initializeSenderSlots(state: PeerState): void {
    for (const [kind, mediaKind] of P2P_TRACK_KINDS) {
      const track = this.tracks.get(kind)
      const sender = state.pc.addTransceiver(track ?? mediaKind, {
        direction: "sendrecv",
        sendEncodings: [{ ...this.peerEncoding(state, kind) }],
      }).sender
      state.senders.set(kind, sender)
    }
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

  private removePeer(state: PeerState, preservePeerEncoding = false): void {
    if (this.peers.get(state.identity.endpointId) !== state) return
    this.peers.delete(state.identity.endpointId)
    if (!preservePeerEncoding) this.peerEncodingSettings.delete(state.identity.endpointId)
    const finalSample = Promise.resolve()
      .then(() => state.pc.getStats())
      .then((report) => {
        this.traffic.observe(state.token, report, selectedTrafficPath(report))
      })
      .catch((error) =>
        console.warn("P2P final traffic sample failed", { endpointId: state.identity.endpointId, error })
      )
      .finally(() => {
        state.pc.close()
        this.traffic.forget(state.token)
        this.finalTrafficSamples.delete(finalSample)
      })
    this.finalTrafficSamples.add(finalSample)
    void this.applyEncodingToAllPeers("camera").catch((error) => console.warn("P2P camera budget update failed", error))
    if (state.negotiationTimer) clearTimeout(state.negotiationTimer)
    if (state.offerRetryTimer) clearTimeout(state.offerRetryTimer)
    state.pc.ontrack = null
    state.pc.onicecandidate = null
    state.pc.onnegotiationneeded = null
    state.pc.onconnectionstatechange = null
    for (const ref of state.emittedRefs.values()) this.onRemoteTrackEnded?.(ref)
    state.emittedRefs.clear()
    state.remoteTracks.clear()
    if (!this.closed) this.updateAggregateState()
  }

  private handleConnectionState(state: PeerState): void {
    if (!this.isCurrent(state)) return
    const connectionState = state.pc.connectionState
    if (connectionState === "connected") {
      this.clearOfferRetry(state)
      state.restartAttempts = 0
      this.peerRecoveryAttempts.delete(state.identity.endpointId)
      this.updateAggregateState()
    } else if (connectionState === "disconnected") {
      this.setState("reconnecting")
    } else if (connectionState === "failed") {
      this.setState("reconnecting")
      if (state.restartAttempts >= MAX_RESTART_ATTEMPTS) return this.setState("failed")
      state.restartAttempts++
      void this.enqueue(state, async () => {
        if (!this.isCurrent(state)) return
        await this.restartPeerIce(state)
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
    if (!state) {
      this.bufferPendingPeerSignal(signal)
      return
    }
    if (
      state.identity.epoch !== signal.senderEpoch ||
      state.identity.mediaIncarnation !== signal.senderMediaIncarnation
    ) {
      if (signal.senderEpoch >= state.identity.epoch) this.bufferPendingPeerSignal(signal)
      return
    }
    void this.enqueue(state, () => this.applySignal(state, signal))
  }

  private bufferPendingPeerSignal(signal: P2pSignalEnvelope): void {
    if (!this.pendingPeerSignals.has(signal.senderEndpointId) && this.pendingPeerSignals.size >= MAX_PENDING_PEERS)
      this.pendingPeerSignals.delete(this.pendingPeerSignals.keys().next().value!)
    const pending = this.pendingPeerSignals.get(signal.senderEndpointId) ?? []
    if (pending.length < MAX_SIGNALS_PER_PENDING_PEER) pending.push(signal)
    this.pendingPeerSignals.set(signal.senderEndpointId, pending)
  }

  private replayPendingSignals(state: PeerState): void {
    const pending = this.pendingPeerSignals.get(state.identity.endpointId)
    this.pendingPeerSignals.delete(state.identity.endpointId)
    for (const signal of pending ?? []) {
      if (
        signal.senderEpoch === state.identity.epoch &&
        signal.senderMediaIncarnation === state.identity.mediaIncarnation
      )
        void this.enqueue(state, () => this.applySignal(state, signal))
    }
  }

  private async applySignal(state: PeerState, signal: P2pSignalEnvelope): Promise<void> {
    if (!this.isCurrent(state)) return
    if (signal.description) {
      if (
        signal.description.type === "answer" &&
        (state.pc.signalingState !== "have-local-offer" || signal.negotiationId !== state.localNegotiationId)
      )
        return
      const collision =
        signal.description.type === "offer" && (state.makingOffer || state.pc.signalingState !== "stable")
      state.ignoreOfferId = !state.polite && collision ? signal.negotiationId : null
      if (state.ignoreOfferId) return
      if (collision) await state.pc.setLocalDescription({ type: "rollback" })
      if (!this.isCurrent(state)) return
      state.remoteNegotiationId = signal.negotiationId
      await state.pc.setRemoteDescription(signal.description)
      if (!this.isCurrent(state)) return
      const boundRemoteOfferSlots = signal.description.type === "offer" ? await this.bindRemoteOfferSlots(state) : false
      for (const candidate of state.pendingCandidates.get(signal.negotiationId) ?? [])
        await this.addIceCandidate(state, signal.negotiationId, candidate)
      state.pendingCandidates.delete(signal.negotiationId)
      if (signal.description.type === "answer") this.clearOfferRetry(state)
      if (signal.description.type === "offer") {
        this.clearOfferRetry(state)
        state.localNegotiationId = signal.negotiationId
        await state.pc.setLocalDescription(await state.pc.createAnswer())
        if (!this.isCurrent(state)) return
        if (boundRemoteOfferSlots) {
          for (const [kind, sender] of state.senders) await this.applyEncoding(sender, this.peerEncoding(state, kind))
        }
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

  private async bindRemoteOfferSlots(state: PeerState): Promise<boolean> {
    const transceivers = state.pc.getTransceivers()
    const abandonedSenders = new Set(state.senders.values())
    const hasAbandonedSlot = transceivers.some(
      (transceiver) => transceiver.mid === null && abandonedSenders.has(transceiver.sender)
    )
    if (state.senders.size > 0 && !hasAbandonedSlot) return false
    for (const transceiver of transceivers) {
      if (transceiver.mid !== null || !abandonedSenders.has(transceiver.sender)) continue
      await transceiver.sender.replaceTrack(null)
      transceiver.stop()
    }
    state.senders.clear()
    for (const transceiver of transceivers) {
      if (transceiver.mid === null) continue
      const kind = P2P_TRACK_KINDS.find(([, mediaKind]) => mediaKind === transceiver.receiver.track.kind)?.[0]
      if (!kind || state.senders.has(kind)) continue
      transceiver.direction = "sendrecv"
      state.senders.set(kind, transceiver.sender)
      await transceiver.sender.replaceTrack(this.tracks.get(kind) ?? null)
    }
    return true
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

  private async restartPeerIce(state: PeerState): Promise<void> {
    this.clearOfferRetry(state)
    if (state.pc.signalingState === "have-local-offer") await state.pc.setLocalDescription({ type: "rollback" })
    if (!this.isCurrent(state)) return
    state.pc.restartIce()
    await this.negotiate(state)
  }

  private async negotiate(state: PeerState): Promise<void> {
    if (!this.isCurrent(state) || state.makingOffer || state.senders.size === 0 || state.pc.signalingState !== "stable")
      return
    try {
      state.makingOffer = true
      state.localNegotiationId = crypto.randomUUID()
      await state.pc.setLocalDescription(await state.pc.createOffer())
      if (!this.isCurrent(state)) return
      this.rememberLocalUfrag(state)
      this.send(state, "description", { description: this.localDescription(state.pc) })
      state.negotiationAttempts = 1
      this.scheduleOfferRetry(state)
    } finally {
      state.makingOffer = false
    }
  }

  private scheduleOfferRetry(state: PeerState): void {
    if (!this.isCurrent(state) || state.offerRetryTimer) return
    const negotiationId = state.localNegotiationId
    state.offerRetryTimer = setTimeout(() => {
      state.offerRetryTimer = null
      void this.enqueue(state, async () => {
        if (state.localNegotiationId !== negotiationId || state.pc.signalingState !== "have-local-offer") return
        if (state.negotiationAttempts >= MAX_NEGOTIATION_ATTEMPTS) {
          this.setState("failed")
          return
        }
        state.negotiationAttempts++
        // Rollback re-fires negotiationneeded; retry the gathered SDP without restarting negotiation.
        this.send(state, "description", { description: this.localDescription(state.pc) }, negotiationId)
        this.scheduleOfferRetry(state)
      })
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
    state.queue = result.catch((error) => {
      if (!this.isCurrent(state, token)) return
      console.warn("P2P peer operation failed", { endpointId: state.identity.endpointId, error })
      const attempts = this.peerRecoveryAttempts.get(state.identity.endpointId) ?? 0
      if (attempts >= MAX_RESTART_ATTEMPTS) {
        this.setState("failed")
        return
      }
      this.peerRecoveryAttempts.set(state.identity.endpointId, attempts + 1)
      const identity = state.identity
      this.removePeer(state, true)
      if (!this.closed) {
        const replacement = this.createPeer(identity)
        if (replacement.polite) {
          this.initializeSenderSlots(replacement)
          this.scheduleNegotiation(replacement, INITIAL_OFFER_DELAY_MS)
        }
      }
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
            { mediaIncarnation: descriptor.mediaIncarnation, generation: this.generation }
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

  private peerEncoding(state: PeerState, kind: PublishedTrackKind): { maxBitrate?: number } | undefined {
    const aggregate = this.encodingSettings.get(kind)
    const peer = this.peerEncodingSettings.get(state.identity.endpointId)?.get(kind)
    if (kind !== "camera" || aggregate?.maxBitrate == null) return peer ?? aggregate
    const aggregateShare = Math.floor(aggregate.maxBitrate / Math.max(1, this.peers.size))
    return { maxBitrate: Math.min(aggregateShare, peer?.maxBitrate ?? aggregateShare) }
  }

  private async applyEncodingToAllPeers(kind: PublishedTrackKind): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map((state) =>
        this.enqueue(state, () => this.applyEncoding(state.senders.get(kind), this.peerEncoding(state, kind)))
      )
    )
  }

  private pickWorstQuality(reasons: string[]): TransportStats["qualityLimitation"] {
    if (reasons.includes("bandwidth")) return "bandwidth"
    if (reasons.includes("cpu")) return "cpu"
    if (reasons.some((reason) => reason !== "none")) return reasons.length ? "other" : null
    return reasons.includes("none") ? "none" : null
  }

  private async applyEncoding(
    sender: RTCRtpSender | undefined,
    params: { maxBitrate?: number } | undefined
  ): Promise<void> {
    if (!sender || !params) return
    const current = sender.getParameters()
    if (!current.encodings?.length) current.encodings = [{}]
    for (const encoding of current.encodings) encoding.maxBitrate = params.maxBitrate
    await sender.setParameters(current)
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

function selectedTrafficPath(report: RTCStatsReport): {
  pairId: string | null
  kind: "direct" | "relay" | null
  candidateType: RTCIceCandidateType | null
  rttMs: number | null
} {
  let selectedPairId: string | null = null
  const pairs: Array<RTCIceCandidatePairStats & { selected?: boolean }> = []
  report.forEach((stat) => {
    if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string")
      selectedPairId = stat.selectedCandidatePairId
    if (stat.type === "candidate-pair" && stat.state === "succeeded") pairs.push(stat)
  })
  const selected =
    pairs.find((pair) => pair.id === selectedPairId) ??
    pairs.find((pair) => pair.nominated || pair.selected) ??
    (pairs.length === 1 ? pairs[0] : null)
  const local = selected
    ? (report.get(selected.localCandidateId) as { candidateType?: RTCIceCandidateType } | undefined)
    : undefined
  const remote = selected
    ? (report.get(selected.remoteCandidateId) as { candidateType?: RTCIceCandidateType } | undefined)
    : undefined
  let candidateType: RTCIceCandidateType | null = null
  if (local?.candidateType === "relay" || remote?.candidateType === "relay") candidateType = "relay"
  else if (local?.candidateType && remote?.candidateType) candidateType = local.candidateType
  const nonRelayKind = candidateType ? "direct" : null
  return {
    pairId: selected?.id ?? null,
    candidateType,
    kind: candidateType === "relay" ? "relay" : nonRelayKind,
    rttMs: typeof selected?.currentRoundTripTime === "number" ? selected.currentRoundTripTime * 1000 : null,
  }
}
