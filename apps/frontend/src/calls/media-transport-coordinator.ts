import type { CallExpectedPublication, CallMediaTransport, CallTransportTransfer } from "@threahq/types"
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

type TransportFactory = (transport: CallMediaTransport, generation: number, sessionId: string | null) => MediaTransport
interface Slot {
  transport: MediaTransport
  generation: number
  kind: CallMediaTransport
  retired: boolean
}
interface StagedTrack {
  ref: PeerTrackRef
  track: MediaStreamTrack
  generation: number
  rendered: boolean
}

export class MediaTransportCoordinator implements MediaTransport {
  private source: Slot
  private target: Slot | null = null
  private transfer: CallTransportTransfer | null = null
  private descriptor: SessionDescriptor | null = null
  private readonly published = new Map<PublishedTrackKind, MediaStreamTrack>()
  private readonly selected = new Map<string, number>()
  private readonly sourceTracks = new Map<string, RemoteTrackEvent>()
  private readonly sourceRendered = new Map<string, string>()
  private readonly staged = new Map<string, StagedTrack>()
  private readonly stagingVideos = new Map<string, { video: HTMLVideoElement; generation: number }>()
  private readonly peerCounts = new Map<number, number>()
  private readonly targetPulls = new Map<string, PeerTrackRef>()
  private readonly encodingSettings = new Map<PublishedTrackKind, { maxBitrate?: number }>()
  private readonly peerEncodingSettings = new Map<string, Map<PublishedTrackKind, { maxBitrate?: number }>>()
  private operationChain: Promise<void> = Promise.resolve()
  private readinessTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private lifecycle = 0
  private retained: Required<
    Pick<
      TransportStats,
      | "directBytesSent"
      | "directBytesReceived"
      | "relayBytesSent"
      | "relayBytesReceived"
      | "unknownBytesSent"
      | "unknownBytesReceived"
    >
  > = {
    directBytesSent: 0,
    directBytesReceived: 0,
    relayBytesSent: 0,
    relayBytesReceived: 0,
    unknownBytesSent: 0,
    unknownBytesReceived: 0,
  }

  onRemoteTrack: ((event: RemoteTrackEvent) => void) | null = null
  onRemoteTrackEnded: ((ref: PeerTrackRef) => void) | null = null
  onConnectionStateChange: ((state: TransportConnectionState) => void) | null = null
  onTargetReadinessChange: (() => void) | null = null

  constructor(
    source: { transport: MediaTransport; generation: number; kind: CallMediaTransport },
    private readonly createTransport: TransportFactory
  ) {
    this.source = { ...source, retired: false }
    this.wire(this.source)
  }

  get connectionState(): TransportConnectionState {
    return this.target?.transport.connectionState ?? this.source.transport.connectionState
  }

  async connect(descriptor: SessionDescriptor): Promise<void> {
    this.descriptor = descriptor
    await this.source.transport.connect(descriptor)
  }

  beginTransfer(snapshot: CallTransportTransfer): Promise<void> {
    return this.serialize(async (lifecycle) => {
      if (!this.descriptor || this.closed || lifecycle !== this.lifecycle) return
      if (snapshot.target.generation <= this.source.generation) return
      if (
        this.transfer &&
        this.transfer.id !== snapshot.id &&
        snapshot.target.generation <= this.transfer.target.generation
      )
        return
      this.transfer = snapshot
      if (snapshot.phase === "failed") {
        await this.abortTargetNow(snapshot.target.generation)
        return
      }
      if (snapshot.phase === "aborting") return
      if (!this.target || this.target.generation !== snapshot.target.generation) {
        if (this.target) {
          this.clearStaging(this.target.generation)
          await this.retire(this.target)
        }
        if (this.closed || lifecycle !== this.lifecycle) return
        const ownSession = snapshot.sessions.find(
          (item) => item.endpointId === this.descriptor!.endpointId && item.generation === snapshot.target.generation
        )
        if (!ownSession) return
        const target: Slot = {
          transport: this.createTransport(
            snapshot.target.transport,
            snapshot.target.generation,
            ownSession.providerSessionId
          ),
          generation: snapshot.target.generation,
          kind: snapshot.target.transport,
          retired: false,
        }
        this.target = target
        this.wire(target)
        const targetPeers = this.transferPeers(snapshot)
        this.peerCounts.set(target.generation, targetPeers.length)
        try {
          await this.reapplyEncodingSettings()
          await target.transport.connect({
            ...this.descriptor,
            generation: target.generation,
            sessionId: ownSession.providerSessionId,
          })
          if (this.closed || lifecycle !== this.lifecycle || this.target !== target) {
            await this.retire(target)
            return
          }
          for (const [kind, track] of this.published) {
            if (this.closed || lifecycle !== this.lifecycle || this.target !== target) return
            await target.transport.publish(kind, track)
          }
        } catch (error) {
          if (this.target === target) this.target = null
          await this.retire(target)
          throw error
        }
      }
      const target = this.target
      if (!target || target.generation !== snapshot.target.generation) return
      const targetPeers = this.transferPeers(snapshot)
      this.peerCounts.set(target.generation, targetPeers.length)
      await target.transport.syncPeers(targetPeers, target.generation)
      await this.syncTargetPulls(target, targetPeers)
      await this.reapplyEncodingSettings()
      this.scheduleReadinessPoll()
    })
  }

  async targetReadiness(
    expected: CallExpectedPublication[]
  ): Promise<{ ready: boolean; publications: CallExpectedPublication[] }> {
    const ready: CallExpectedPublication[] = []
    for (const item of expected) {
      const staged = this.staged.get(this.key(item.endpointId, item.kind))
      if (!staged || staged.generation !== this.target?.generation || staged.ref.publicationId !== item.publicationId)
        continue
      if (staged.track.readyState !== "live") continue
      if (item.kind === "camera") {
        if (staged.rendered) ready.push(item)
        continue
      }
      if (item.muted || (await this.target?.transport.hasInboundByteProgress?.(staged.ref))) ready.push(item)
    }
    const ownReady =
      this.target?.transport.hasEstablishedOwnPublications?.() ?? this.target?.transport.connectionState === "connected"
    return { ready: ownReady && ready.length === expected.length, publications: ready }
  }

  async markVideoRendered(ref: PeerTrackRef, generation: number): Promise<void> {
    const staged = this.staged.get(this.key(ref.endpointId, ref.kind))
    if (staged && staged.generation === generation && staged.ref.publicationId === ref.publicationId) {
      staged.rendered = true
      if ((this.selected.get(this.key(ref.endpointId, ref.kind)) ?? this.source.generation) === generation)
        this.onRemoteTrack?.({ ref: staged.ref, track: staged.track })
      this.onTargetReadinessChange?.()
    }
  }

  commitSelection(generation: number, expected?: CallExpectedPublication[]): boolean {
    if (!this.target || this.target.generation !== generation) return false
    const selected = expected
      ? expected.map((item) => this.staged.get(this.key(item.endpointId, item.kind)))
      : [...this.staged.values()].filter((staged) => staged.generation === generation)
    if (
      selected.some(
        (staged, index) =>
          !staged ||
          staged.generation !== generation ||
          staged.track.readyState !== "live" ||
          (expected && staged.ref.publicationId !== expected[index]!.publicationId) ||
          (staged.ref.kind === "camera" && !staged.rendered)
      )
    )
      return false
    for (const staged of selected) {
      if (!staged) continue
      this.selected.set(this.key(staged.ref.endpointId, staged.ref.kind), generation)
      this.onRemoteTrack?.({ ref: staged.ref, track: staged.track })
    }
    return true
  }

  async restoreSourcePlayback(expected: CallExpectedPublication[], targetGeneration: number): Promise<boolean> {
    if (!this.target || this.target.generation !== targetGeneration) return false
    const restored: RemoteTrackEvent[] = []
    for (const item of expected) {
      const source = this.sourceTracks.get(this.key(item.endpointId, item.kind))
      if (!source || source.track.readyState !== "live") return false
      if (
        item.kind === "camera" &&
        this.sourceRendered.get(this.key(item.endpointId, item.kind)) !== source.ref.publicationId
      )
        return false
      if (item.kind === "mic" && !item.muted && !(await this.source.transport.hasInboundByteProgress?.(source.ref)))
        return false
      restored.push(source)
    }
    for (const event of restored) {
      this.selected.set(this.key(event.ref.endpointId, event.ref.kind), this.source.generation)
      this.onRemoteTrack?.(event)
    }
    return true
  }

  drainSource(generation: number): Promise<void> {
    return this.serialize(async () => {
      if (!this.target || this.target.generation !== generation) return
      const old = this.source
      const promoted = this.target
      this.source = promoted
      this.target = null
      this.sourceTracks.clear()
      this.sourceRendered.clear()
      for (const [key, staged] of this.staged) {
        if (staged.generation !== generation) continue
        this.sourceTracks.set(key, { ref: staged.ref, track: staged.track })
        if (staged.rendered) this.sourceRendered.set(key, staged.ref.publicationId)
        this.selected.set(key, generation)
      }
      this.clearStaging()
      this.targetPulls.clear()
      this.transfer = null
      await this.retire(old)
      await this.reapplyEncodingSettings()
    })
  }

  abortTarget(generation: number): Promise<void> {
    return this.serialize(() => this.abortTargetNow(generation))
  }

  private async abortTargetNow(generation: number): Promise<void> {
    if (!this.target || this.target.generation !== generation) return
    const target = this.target
    this.target = null
    for (const [key, staged] of this.staged) {
      if (staged.generation !== generation) continue
      this.selected.set(key, this.source.generation)
      const source = this.sourceTracks.get(key)
      if (source) this.onRemoteTrack?.(source)
    }
    this.clearStaging(generation)
    this.targetPulls.clear()
    await this.retire(target)
    await this.reapplyEncodingSettings()
  }

  publish(kind: PublishedTrackKind, track: MediaStreamTrack): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return
      await this.source.transport.publish(kind, track)
      this.published.set(kind, track)
      if (this.target) {
        try {
          await this.target.transport.publish(kind, track)
        } catch {
          this.onTargetReadinessChange?.()
        }
      }
    })
  }

  unpublish(kind: PublishedTrackKind, opts?: { reason?: string }): Promise<void> {
    return this.serialize(async () => {
      if (this.closed) return
      await this.source.transport.unpublish(kind, opts)
      this.published.delete(kind)
      if (this.target) {
        try {
          await this.target.transport.unpublish(kind, opts)
        } catch {
          this.onTargetReadinessChange?.()
        }
      }
    })
  }

  async setPublishEncoding(kind: PublishedTrackKind, params: { maxBitrate?: number }): Promise<void> {
    this.encodingSettings.set(kind, params)
    await this.applyAggregateEncoding(kind, params)
  }
  async setPeerPublishEncoding(
    endpointId: string,
    kind: PublishedTrackKind,
    params: { maxBitrate?: number }
  ): Promise<void> {
    const settings = this.peerEncodingSettings.get(endpointId) ?? new Map()
    settings.set(kind, params)
    this.peerEncodingSettings.set(endpointId, settings)
    await this.applyPeerEncoding(endpointId, kind, params)
  }
  async pull(ref: PeerTrackRef): Promise<void> {
    await this.source.transport.pull(ref)
  }
  async stopPull(ref: PeerTrackRef): Promise<void> {
    await Promise.all(
      [this.source, this.target]
        .filter((slot): slot is Slot => Boolean(slot))
        .map((slot) => slot.transport.stopPull(ref))
    )
  }
  syncPeers(peers: PeerDescriptor[], _generation: number): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.peerCounts.set(this.source.generation, peers.length)
    const source = this.source
    const sourceUpdate = source.transport.syncPeers(peers, source.generation)
    return this.serialize(async () => {
      await sourceUpdate
      if (this.closed || this.source !== source) return
      if (this.target) {
        const targetPeers = this.transfer ? this.transferPeers(this.transfer) : []
        this.peerCounts.set(this.target.generation, targetPeers.length)
        await this.target.transport.syncPeers(targetPeers, this.target.generation)
      }
      await this.reapplyEncodingSettings()
    })
  }
  async reconnect(): Promise<void> {
    await Promise.all(
      [this.source, this.target]
        .filter((slot): slot is Slot => Boolean(slot))
        .map((slot) => slot.transport.reconnect?.())
    )
  }

  async getStats(): Promise<TransportStats> {
    const samples = await Promise.all(
      [this.source, this.target].filter((slot): slot is Slot => Boolean(slot)).map((slot) => slot.transport.getStats())
    )
    const sum = (key: keyof typeof this.retained) =>
      this.retained[key] + samples.reduce((total, sample) => total + (sample[key] ?? 0), 0)
    return {
      candidateType: samples.find((sample) => sample.candidateType)?.candidateType,
      rttMs: samples.reduce<number | null>(
        (max, item) => (item.rttMs === null ? max : Math.max(max ?? 0, item.rttMs)),
        null
      ),
      packetLoss: samples.reduce<number | null>(
        (max, item) => (item.packetLoss === null ? max : Math.max(max ?? 0, item.packetLoss)),
        null
      ),
      qualityLimitation:
        samples.find((item) => item.qualityLimitation && item.qualityLimitation !== "none")?.qualityLimitation ??
        "none",
      encodeTimeMs: samples.reduce<number | null>(
        (max, item) => (item.encodeTimeMs === null ? max : Math.max(max ?? 0, item.encodeTimeMs)),
        null
      ),
      directBytesSent: sum("directBytesSent"),
      directBytesReceived: sum("directBytesReceived"),
      relayBytesSent: sum("relayBytesSent"),
      relayBytesReceived: sum("relayBytesReceived"),
      unknownBytesSent: sum("unknownBytesSent"),
      unknownBytesReceived: sum("unknownBytesReceived"),
      bytesSent: samples.reduce((n, s) => n + (s.bytesSent ?? 0), 0),
      bytesReceived: samples.reduce((n, s) => n + (s.bytesReceived ?? 0), 0),
      peers: samples.flatMap((sample) => sample.peers ?? []),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle++
    if (this.readinessTimer) clearTimeout(this.readinessTimer)
    this.readinessTimer = null
    const slots = [this.source, this.target].filter((slot): slot is Slot => Boolean(slot))
    this.target = null
    const closing = Promise.allSettled(slots.map((slot) => slot.transport.close()))
    await closing
    this.published.clear()
    this.sourceTracks.clear()
    this.sourceRendered.clear()
    this.targetPulls.clear()
    this.clearStaging()
  }

  private wire(slot: Slot): void {
    slot.transport.onRemoteTrack = (event) => {
      if (slot.retired) return
      const key = this.key(event.ref.endpointId, event.ref.kind)
      if (slot === this.target) {
        this.staged.set(key, { ...event, generation: slot.generation, rendered: event.ref.kind !== "camera" })
        if (event.ref.kind === "camera") this.probeVideo(event, slot.generation, true)
        if ((this.selected.get(key) ?? this.source.generation) === slot.generation && event.ref.kind !== "camera")
          this.onRemoteTrack?.(event)
        this.onTargetReadinessChange?.()
        return
      }
      this.sourceTracks.set(key, event)
      if (event.ref.kind === "camera") this.probeVideo(event, slot.generation, false)
      if ((this.selected.get(key) ?? slot.generation) === slot.generation) this.onRemoteTrack?.(event)
    }
    slot.transport.onRemoteTrackEnded = (ref) => {
      if (slot.retired) return
      const key = this.key(ref.endpointId, ref.kind)
      if (slot === this.target) {
        const staged = this.staged.get(key)
        if (!staged || staged.generation !== slot.generation || staged.ref.publicationId !== ref.publicationId) return
        this.staged.delete(key)
        this.onTargetReadinessChange?.()
      } else {
        const source = this.sourceTracks.get(key)
        if (!source || source.ref.publicationId !== ref.publicationId) return
        this.sourceTracks.delete(key)
      }
      if ((this.selected.get(key) ?? slot.generation) === slot.generation) this.onRemoteTrackEnded?.(ref)
    }
    slot.transport.onConnectionStateChange = (state) => {
      if (!slot.retired && (slot === this.target || !this.target)) this.onConnectionStateChange?.(state)
    }
  }

  private async retire(slot: Slot): Promise<void> {
    if (slot.retired) return
    const stats = await slot.transport.getStats().catch(() => null)
    if (stats)
      for (const key of Object.keys(this.retained) as Array<keyof typeof this.retained>)
        this.retained[key] += stats[key] ?? 0
    slot.retired = true
    this.peerCounts.delete(slot.generation)
    await slot.transport.close()
  }
  private serialize(operation: (lifecycle: number) => Promise<void>): Promise<void> {
    const lifecycle = this.lifecycle
    const run = this.operationChain.then(() => operation(lifecycle))
    this.operationChain = run.catch(() => {})
    return run
  }

  private async syncTargetPulls(target: Slot, peers: PeerDescriptor[]): Promise<void> {
    const desired = new Map<string, PeerTrackRef>()
    for (const peer of peers)
      for (const { ref } of peer.publications) desired.set(this.key(ref.endpointId, ref.kind), ref)
    for (const [key, ref] of this.targetPulls) {
      const next = desired.get(key)
      if (next?.publicationId === ref.publicationId) continue
      this.targetPulls.delete(key)
      await target.transport.stopPull(ref)
    }
    for (const [key, ref] of desired) {
      if (this.targetPulls.get(key)?.publicationId === ref.publicationId) continue
      await target.transport.pull(ref)
      this.targetPulls.set(key, ref)
    }
  }

  private probeVideo(event: RemoteTrackEvent, generation: number, target: boolean): void {
    if (typeof document === "undefined") return
    const key = this.key(event.ref.endpointId, event.ref.kind)
    const probeKey = `${generation}:${key}`
    const video = document.createElement("video")
    video.muted = true
    video.playsInline = true
    video.setAttribute("aria-hidden", "true")
    Object.assign(video.style, {
      position: "fixed",
      width: "1px",
      height: "1px",
      left: "-2px",
      top: "-2px",
      opacity: "0",
      pointerEvents: "none",
    })
    video.srcObject = new MediaStream([event.track])
    const previous = this.stagingVideos.get(probeKey)?.video
    if (previous) {
      previous.pause()
      previous.srcObject = null
      previous.remove()
    }
    document.body.append(video)
    this.stagingVideos.set(probeKey, { video, generation })
    const rendered = () => {
      if (target) void this.markVideoRendered(event.ref, generation)
      else if (
        this.source.generation === generation &&
        this.sourceTracks.get(key)?.ref.publicationId === event.ref.publicationId
      )
        this.sourceRendered.set(key, event.ref.publicationId)
    }
    if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(rendered)
    else video.addEventListener("loadeddata", rendered, { once: true })
    void video.play().catch(() => {})
  }

  private scheduleReadinessPoll(): void {
    if (this.closed || !this.target || this.readinessTimer) return
    this.readinessTimer = setTimeout(() => {
      this.readinessTimer = null
      if (this.closed || !this.target) return
      this.onTargetReadinessChange?.()
      this.scheduleReadinessPoll()
    }, 250)
  }

  private clearStaging(generation?: number): void {
    for (const [key, staged] of this.staged) {
      if (generation !== undefined && staged.generation !== generation) continue
      this.staged.delete(key)
    }
    for (const [key, probe] of this.stagingVideos) {
      if (generation !== undefined && probe.generation !== generation) continue
      probe.video.pause()
      probe.video.srcObject = null
      probe.video.remove()
      this.stagingVideos.delete(key)
    }
  }

  private async reapplyEncodingSettings(): Promise<void> {
    for (const [kind, params] of this.encodingSettings) await this.applyAggregateEncoding(kind, params)
    for (const [endpointId, settings] of this.peerEncodingSettings)
      for (const [kind, params] of settings) await this.applyPeerEncoding(endpointId, kind, params)
  }

  private async applyAggregateEncoding(kind: PublishedTrackKind, params: { maxBitrate?: number }): Promise<void> {
    const slots = [this.source, this.target].filter((slot): slot is Slot => Boolean(slot))
    const total = kind === "camera" ? this.cameraSenderCount(slots) : 1
    await Promise.all(
      slots.map((slot) => {
        const senders =
          kind === "camera" && slot.kind === "p2p" ? Math.max(1, this.peerCounts.get(slot.generation) ?? 0) : 1
        const maxBitrate = params.maxBitrate == null ? undefined : Math.floor((params.maxBitrate * senders) / total)
        return slot.transport.setPublishEncoding(kind, { maxBitrate })
      })
    )
  }

  private async applyPeerEncoding(
    endpointId: string,
    kind: PublishedTrackKind,
    params: { maxBitrate?: number }
  ): Promise<void> {
    const slots = [this.source, this.target].filter((slot): slot is Slot => Boolean(slot))
    const total = kind === "camera" ? this.cameraSenderCount(slots) : 1
    const maxBitrate = params.maxBitrate == null ? undefined : Math.floor(params.maxBitrate / total)
    await Promise.all(slots.map((slot) => slot.transport.setPeerPublishEncoding?.(endpointId, kind, { maxBitrate })))
  }

  private transferPeers(snapshot: CallTransportTransfer): PeerDescriptor[] {
    if (!this.descriptor) return []
    return snapshot.sessions.flatMap((session) => {
      if (
        session.endpointId === this.descriptor!.endpointId ||
        session.generation !== snapshot.target.generation ||
        session.status === "closed" ||
        session.status === "failed"
      )
        return []
      return [
        {
          endpointId: session.endpointId,
          epoch: session.endpointEpoch,
          mediaIncarnation: session.mediaIncarnation,
          publications: session.publishedTracks.flatMap((track) => {
            if (track.kind !== "mic" && track.kind !== "camera") return []
            const publicationId =
              track.publicationId ??
              (session.providerSessionId ? `${session.providerSessionId}:${track.trackName}` : null)
            if (!publicationId) return []
            return [
              {
                ref: { endpointId: session.endpointId, kind: track.kind, publicationId },
                providerLocator: session.providerSessionId
                  ? { sessionId: session.providerSessionId, trackName: track.trackName }
                  : undefined,
              },
            ]
          }),
        },
      ]
    })
  }
  private cameraSenderCount(slots: Slot[]): number {
    return Math.max(
      1,
      slots.reduce((count, slot) => count + (slot.kind === "p2p" ? (this.peerCounts.get(slot.generation) ?? 0) : 1), 0)
    )
  }
  private key(endpointId: string, kind: string): string {
    return `${endpointId}\u0000${kind}`
  }
}
