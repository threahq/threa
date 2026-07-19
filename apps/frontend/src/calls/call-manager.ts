import { ulid } from "ulid"
import { io } from "socket.io-client"
import { api } from "@/api/client"
import { getCachedWsConfig } from "@/lib/cached-ws-config"
import { setDictationExternalHold } from "@/contexts/dictation-coordinator-context"
import {
  setCallSession,
  setCallPhase,
  setCallRoster,
  patchCallLocal,
  setCallSpeakingLevel,
  setCallDevices,
  setCallDiagnostics,
  setCallActiveElsewhere,
  setCallConfirmPending,
  clearCallState,
  registerCallHangup,
  getCallState,
  type CallRosterParticipant,
  type CallDeviceState,
} from "@/stores/call-store"
import {
  CloudflareSfuTransport,
  type MediaTransport,
  type PeerTrackRef,
  type RemoteTrackEvent,
} from "./media-transport"
import {
  ENDPOINT_LEASE_TTL_MS,
  leaseRenewIntervalMs,
  WATCHDOG_SAMPLE_MS,
  WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE,
  CAMERA_PUBLISH_LADDER,
  AUDIO_CAPTURE_CONSTRAINTS,
  VIDEO_CAPTURE_CONSTRAINTS,
  type CallMode,
} from "./config"

// ── Wire shapes ────────────────────────────────────────────────────────────────

interface StartCallResponse {
  call: { id: string; workspaceId: string; streamId: string; mode: CallMode }
  created: boolean
  participant: { id: string }
  endpoint: { id: string }
  rosterVersion: number
  roster: CallRosterParticipant[]
}

interface JoinAckData {
  endpointId: string
  epoch: number
  rosterVersion: number
  roster: CallRosterParticipant[]
  leaseTtlMs: number
}

type Ack<T> = { ok: boolean; error?: string; code?: string; data?: T }

interface RosterEvent {
  callId: string
  rosterVersion: number
  roster: CallRosterParticipant[]
}

/** Minimal socket surface the manager needs — satisfied by socket.io's `Socket`. */
export interface CallSocket {
  connected: boolean
  emit(event: string, payload: unknown, ack?: (result: unknown) => void): void
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string): void
  disconnect(): void
}

interface WakeLockLike {
  release(): Promise<void>
  released: boolean
}

/**
 * Injected browser/network collaborators. Production wires real APIs via
 * {@link defaultCallManagerDeps}; tests pass fakes so no test touches the network,
 * a real `RTCPeerConnection`, `getUserMedia`, Web Locks, or the wake lock.
 */
export interface CallManagerDeps {
  startCallRest(args: {
    workspaceId: string
    streamId: string
    mode: CallMode
    mediaIncarnation: string
  }): Promise<StartCallResponse>
  connectSocket(workspaceId: string): CallSocket | null
  createTransport(args: { workspaceId: string; callId: string }): MediaTransport
  acquireUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(): AudioContext | null
  enumerateDevices(): Promise<MediaDeviceInfo[]>
  locks: LockManager | null
  requestWakeLock(): Promise<WakeLockLike | null>
  mintIncarnation(): string
}

interface CallSession {
  callId: string
  workspaceId: string
  streamId: string
  mode: CallMode
  mediaIncarnation: string
  endpointId: string
  leaseTtlMs: number
  rosterVersion: number
  transport: MediaTransport
  socket: CallSocket
  micTrack: MediaStreamTrack | null
  cameraTrack: MediaStreamTrack | null
  micStream: MediaStream | null
  audioContext: AudioContext | null
  analyser: AnalyserNode | null
  pulled: Map<string, { ref: PeerTrackRef; kind: string }>
  remoteAudioEls: Map<string, HTMLAudioElement>
  cameraLayer: number
  healthySamples: number
  leaseTimer: ReturnType<typeof setInterval> | null
  watchdogTimer: ReturnType<typeof setInterval> | null
  meterRaf: number | null
  wakeLock: WakeLockLike | null
  releaseLock: (() => void) | null
  onVisibility: (() => void) | null
  onDeviceChange: (() => void) | null
}

function refKey(ref: PeerTrackRef): string {
  return `${ref.sessionId}:${ref.trackName}`
}

/**
 * The account-scoped, workspace-agnostic call singleton (calls carry their own
 * `workspaceId`, so — unlike the per-workspace SyncEngine — it survives a
 * workspace switch and only dies on account switch / logout via the call-store
 * flush registration). Owns the `/calls` socket, the CF transport + media, the
 * media incarnation, leases, and local capture. It never activates on its own —
 * only an explicit `startCall`/`rejoin` from a user gesture brings it up.
 */
export class CallManager {
  private readonly deps: CallManagerDeps
  private session: CallSession | null = null
  private unregisterHangup: (() => void) | null = null
  private readonly audioContainer: HTMLElement | null

  constructor(deps: CallManagerDeps, audioContainer?: HTMLElement | null) {
    this.deps = deps
    this.audioContainer = audioContainer ?? null
    // The store's flush (account switch / logout) drives the ordered hangup.
    this.unregisterHangup = registerCallHangup(() => this.hangupSync())
  }

  isActive(): boolean {
    return this.session !== null
  }

  /**
   * Start (or join) the call on a stream and connect media. Must be invoked from
   * a user gesture — the AudioContext is created synchronously at the top so iOS
   * Safari honors it (an AudioContext created after an await stays suspended).
   */
  async startCall(params: { workspaceId: string; streamId: string; mode: CallMode }): Promise<void> {
    if (this.session) throw new Error("A call is already active")
    const mediaIncarnation = this.deps.mintIncarnation()
    // Synchronous, in-gesture (see method doc). Held on a temp until the session exists.
    const audioContext = this.deps.createAudioContext()
    void audioContext?.resume().catch(() => {})

    // Held on locals so the catch can release them even when a throw precedes
    // `this.session = session` (teardown early-returns on a null session).
    let releaseLock: (() => void) | null = null
    let socket: CallSocket | null = null
    try {
      const started = await this.deps.startCallRest({ ...params, mediaIncarnation })
      const callId = started.call.id
      setCallSession({ callId, workspaceId: params.workspaceId, streamId: params.streamId, mode: params.mode })
      // One tab owns the call (Web Locks). A second tab sees the lock held →
      // activeElsewhere; on this tab's crash the lock releases and the other tab
      // may offer rejoin (surfaced via the store; UI is M1.2).
      releaseLock = await this.acquireLock(callId)

      socket = this.deps.connectSocket(params.workspaceId)
      if (!socket) throw new Error("Calls socket is not available")

      const join = await this.joinOverSocket(socket, {
        workspaceId: params.workspaceId,
        callId,
        mediaIncarnation,
      })

      const transport = this.deps.createTransport({ workspaceId: params.workspaceId, callId })
      const session: CallSession = {
        callId,
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        mode: params.mode,
        mediaIncarnation,
        endpointId: join.endpointId,
        leaseTtlMs: join.leaseTtlMs || ENDPOINT_LEASE_TTL_MS,
        // -1 so the join's own snapshot (version ≥ 0) is applied by applyRoster.
        rosterVersion: -1,
        transport,
        socket,
        micTrack: null,
        cameraTrack: null,
        micStream: null,
        audioContext,
        analyser: null,
        pulled: new Map(),
        remoteAudioEls: new Map(),
        cameraLayer: 0,
        healthySamples: 0,
        leaseTimer: null,
        watchdogTimer: null,
        meterRaf: null,
        wakeLock: null,
        releaseLock,
        onVisibility: null,
        onDeviceChange: null,
      }
      this.session = session

      // Composer dictation off for the call's life — one active capture only.
      setDictationExternalHold(true)

      this.wireTransport(session)
      this.wireSocket(session)

      await transport.connect({ endpointId: join.endpointId, mediaIncarnation })
      // Video joins acquire mic+camera in ONE getUserMedia (iOS single-active-
      // capture: a second gUM while the first is live mutes it), then split.
      await this.captureAndPublish(session, { camera: params.mode === "video" })
      if (params.mode === "video") {
        patchCallLocal({ cameraOn: true })
        this.emitState(session, { cameraOn: true })
      }

      this.applyRoster(session, join.rosterVersion, join.roster)
      this.startLeaseTimer(session)
      this.startWatchdog(session)
      await this.acquireWakeLock(session)
      await this.refreshDevices()

      setCallPhase("connected")
    } catch (err) {
      if (this.session) {
        await this.teardown()
      } else {
        // Threw before the session existed — teardown can't see these, so
        // release the lock, socket, and AudioContext here or they orphan (a
        // held-forever call lock wedges every later startCall on this tab).
        releaseLock?.()
        try {
          socket?.disconnect()
        } catch {
          // ignore
        }
        void audioContext?.close?.().catch(() => {})
        clearCallState()
      }
      throw err
    }
  }

  /**
   * Rejoin a call after a fresh page load: a NEW media incarnation (new CF
   * session), unlike a transient socket reconnect which reuses the incarnation.
   * The rejoin flow is otherwise identical to a start on the same stream.
   */
  async rejoin(params: { workspaceId: string; streamId: string; callId: string; mode: CallMode }): Promise<void> {
    // startCall's REST endpoint is start-or-join, so a rejoin is a start on the
    // same stream with a fresh incarnation — the shared path keeps one lifecycle.
    await this.startCall({ workspaceId: params.workspaceId, streamId: params.streamId, mode: params.mode })
  }

  /** Ordered teardown: emit leave → close transport → stop tracks. */
  async leaveCall(): Promise<void> {
    const session = this.session
    if (!session) return
    await this.emitLeave(session)
    await this.teardown()
  }

  setMuted(muted: boolean): void {
    const session = this.session
    if (!session) return
    if (session.micTrack) session.micTrack.enabled = !muted
    patchCallLocal({ muted })
    this.emitState(session, { muted })
  }

  async setCameraOn(on: boolean): Promise<void> {
    const session = this.session
    if (!session) return
    if (session.mode === "audio_only") return
    if (on) {
      // Turning the camera on re-acquires mic+camera as ONE stream (iOS single-
      // active-capture): a camera-only gUM while the mic is live would mute it.
      await this.captureAndPublish(session, {
        camera: true,
        inputDeviceId: getCallState().local.devices.selectedInputId,
      })
    } else if (session.cameraTrack) {
      // Camera off fully stops the track (kills the LED) and unpublishes; the
      // mic is untouched, so no recapture is needed.
      session.cameraTrack.stop()
      session.cameraTrack = null
      await session.transport.unpublish("camera")
    }
    patchCallLocal({ cameraOn: on })
    this.emitState(session, { cameraOn: on })
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    const session = this.session
    if (!session) return
    // Recapture the whole stream (mic + camera if live) so iOS single-active-
    // capture never mutes the surviving track.
    await this.captureAndPublish(session, { camera: session.cameraTrack != null, inputDeviceId: deviceId })
    patchCallLocal({ devices: { ...getCallState().local.devices, selectedInputId: deviceId } })
    await this.refreshDevices()
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    const session = this.session
    if (!session) return
    for (const el of session.remoteAudioEls.values()) {
      const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
      if (typeof sinkable.setSinkId === "function") await sinkable.setSinkId(deviceId).catch(() => {})
    }
    patchCallLocal({
      devices: { ...getCallState().local.devices, selectedOutputId: deviceId },
    })
  }

  dispose(): void {
    this.unregisterHangup?.()
    this.unregisterHangup = null
    void this.teardown()
  }

  // ── socket + roster ───────────────────────────────────────────────────────

  private joinOverSocket(
    socket: CallSocket,
    args: { workspaceId: string; callId: string; mediaIncarnation: string }
  ): Promise<JoinAckData> {
    return new Promise<JoinAckData>((resolve, reject) => {
      socket.emit("call:join", args, (result: unknown) => {
        const ack = result as Ack<JoinAckData>
        if (ack?.ok && ack.data) resolve(ack.data)
        else reject(new Error(ack?.code ?? ack?.error ?? "call:join failed"))
      })
    })
  }

  private wireSocket(session: CallSession): void {
    session.socket.on("call:roster", (payload: unknown) => {
      const evt = payload as RosterEvent
      if (evt.callId !== session.callId) return
      this.applyRoster(session, evt.rosterVersion, evt.roster)
    })
    session.socket.on("disconnect", () => {
      // A socket drop is NOT a call end (the lease holds the slot). Demote to
      // reconnecting; the CF media session survives brief socket loss.
      if (this.session !== session) return
      setCallPhase("reconnecting")
    })
    session.socket.on("connect", () => {
      if (this.session !== session) return
      // Transient reconnect: rejoin with the SAME incarnation (rebinds the same
      // endpoint + epoch). A new incarnation is only minted by a fresh page load.
      this.joinOverSocket(session.socket, {
        workspaceId: session.workspaceId,
        callId: session.callId,
        mediaIncarnation: session.mediaIncarnation,
      })
        .then((join) => {
          session.endpointId = join.endpointId
          this.applyRoster(session, join.rosterVersion, join.roster)
          setCallPhase("connected")
        })
        .catch(() => {
          void this.teardown()
        })
    })
  }

  private applyRoster(session: CallSession, version: number, roster: CallRosterParticipant[]): void {
    // Versioned: a reordered/stale delivery is dropped by version check, not
    // trusted (INV-66 client side). A version we already hold (or older) is a
    // duplicate/reorder — the bump is monotonic, so equal means no new state.
    if (version <= session.rosterVersion) return
    session.rosterVersion = version
    setCallRoster(roster, version)
    this.diffPulls(session, roster)
  }

  /** Diff the roster's track registry against what we pull; pull new, stop gone. */
  private diffPulls(session: CallSession, roster: CallRosterParticipant[]): void {
    const desired = new Map<string, { ref: PeerTrackRef; kind: string }>()
    for (const p of roster) {
      if (p.endpointId === session.endpointId) continue
      if (p.connectionStatus !== "connected" && p.connectionStatus !== "reconnecting") continue
      // The publisher's CF session id is required to pull. The 0.2 roster does
      // not carry it (contract gap) — skip peers we can't address rather than
      // constructing an unpullable ref.
      if (!p.cfSessionId) continue
      for (const track of p.publishedTracks) {
        const ref: PeerTrackRef = { sessionId: p.cfSessionId, trackName: track.trackName }
        desired.set(refKey(ref), { ref, kind: track.kind })
      }
    }
    for (const [key, entry] of desired) {
      if (!session.pulled.has(key)) {
        session.pulled.set(key, entry)
        void session.transport.pull(entry.ref).catch(() => session.pulled.delete(key))
      }
    }
    for (const [key, entry] of session.pulled) {
      if (!desired.has(key)) {
        session.pulled.delete(key)
        void session.transport.stopPull(entry.ref).catch(() => {})
        this.detachRemoteAudio(session, key)
      }
    }
  }

  // ── media ──────────────────────────────────────────────────────────────────

  /**
   * Acquire mic (and camera when requested) in a SINGLE getUserMedia and publish
   * the split tracks. Combined capture is the iOS rule: a second concurrent gUM
   * mutes the first (single-active-capture), so every camera-on or input-switch
   * routes through here — stop the live capture, then acquire one combined stream.
   */
  private async captureAndPublish(
    session: CallSession,
    opts: { camera: boolean; inputDeviceId?: string | null }
  ): Promise<void> {
    session.micTrack?.stop()
    session.cameraTrack?.stop()
    session.micStream?.getTracks().forEach((t) => t.stop())

    const audio: MediaTrackConstraints = opts.inputDeviceId
      ? { ...AUDIO_CAPTURE_CONSTRAINTS, deviceId: { exact: opts.inputDeviceId } }
      : AUDIO_CAPTURE_CONSTRAINTS
    const constraints: MediaStreamConstraints = opts.camera ? { audio, video: VIDEO_CAPTURE_CONSTRAINTS } : { audio }
    const stream = await this.deps.acquireUserMedia(constraints)
    session.micStream = stream

    const micTrack = stream.getAudioTracks()[0] ?? null
    session.micTrack = micTrack
    if (micTrack) {
      micTrack.enabled = !getCallState().local.muted
      await session.transport.publish("mic", micTrack)
    }

    const cameraTrack = opts.camera ? (stream.getVideoTracks()[0] ?? null) : null
    session.cameraTrack = cameraTrack
    if (cameraTrack) {
      await session.transport.publish("camera", cameraTrack)
      await this.applyCameraLayer(session)
    }

    this.wireSpeakingAnalyser(session, stream)
  }

  private wireSpeakingAnalyser(session: CallSession, stream: MediaStream): void {
    const ctx = session.audioContext
    if (!ctx) return
    // A recapture rewires the analyser; cancel the prior meter loop so a second
    // RAF never runs alongside it.
    if (session.meterRaf !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(session.meterRaf)
      session.meterRaf = null
    }
    try {
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      // Analyser is a pure sink — never connected onward, so it never routes the
      // mic to the speakers.
      source.connect(analyser)
      session.analyser = analyser
      this.runMeter(session)
    } catch {
      // AudioContext unavailable (jsdom / unsupported) — speaking level stays 0.
    }
  }

  private runMeter(session: CallSession): void {
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null
    if (!raf || !session.analyser) return
    const buf = new Uint8Array(session.analyser.fftSize)
    const tick = () => {
      const analyser = session.analyser
      if (!analyser || this.session !== session) return
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const s = (buf[i] - 128) / 128
        sum += s * s
      }
      setCallSpeakingLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3))
      session.meterRaf = raf(tick)
    }
    session.meterRaf = raf(tick)
  }

  // ── remote audio (one <audio> per pulled audio track, AEC reference) ────────

  private wireTransport(session: CallSession): void {
    session.transport.onRemoteTrack = (event: RemoteTrackEvent) => {
      if (this.session !== session) return
      // Remote audio renders through a dedicated <audio> element so Chromium's
      // echo canceller stays referenced to the output and setSinkId works. It is
      // NEVER routed through the AudioContext to the speakers (Web Audio taps are
      // pure sinks only).
      if (event.track.kind === "audio") this.attachRemoteAudio(session, event.ref, event.track)
    }
    session.transport.onRemoteTrackEnded = (ref) => {
      this.detachRemoteAudio(session, refKey(ref))
    }
    session.transport.onConnectionStateChange = (state) => {
      if (this.session !== session) return
      if (state === "reconnecting") setCallPhase("reconnecting")
      else if (state === "connected") setCallPhase("connected")
    }
  }

  private attachRemoteAudio(session: CallSession, ref: PeerTrackRef, track: MediaStreamTrack): void {
    if (typeof document === "undefined") return
    const key = refKey(ref)
    this.detachRemoteAudio(session, key)
    const el = document.createElement("audio")
    el.autoplay = true
    el.srcObject = new MediaStream([track])
    const selectedOutput = getCallState().local.devices.selectedOutputId
    const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (selectedOutput && typeof sinkable.setSinkId === "function") {
      void sinkable.setSinkId(selectedOutput).catch(() => {})
    }
    const container = this.audioContainer ?? document.body
    container.appendChild(el)
    session.remoteAudioEls.set(key, el)
    void el.play?.().catch(() => {})
  }

  private detachRemoteAudio(session: CallSession, key: string): void {
    const el = session.remoteAudioEls.get(key)
    if (!el) return
    el.srcObject = null
    el.remove()
    session.remoteAudioEls.delete(key)
  }

  // ── lease + watchdog ─────────────────────────────────────────────────────

  private startLeaseTimer(session: CallSession): void {
    const interval = leaseRenewIntervalMs(session.leaseTtlMs)
    session.leaseTimer = setInterval(() => {
      session.socket.emit("call:lease:renew", {}, (result: unknown) => {
        const ack = result as Ack<{ leaseExpiresAt: string }>
        // A superseded lease means our endpoint was taken over — the call is lost
        // on this incarnation; tear down rather than pretend we're still in.
        if (!ack?.ok && ack?.code === "CALL_LEASE_SUPERSEDED") void this.teardown()
      })
    }, interval)
  }

  private startWatchdog(session: CallSession): void {
    session.watchdogTimer = setInterval(() => {
      void session.transport
        .getStats()
        .then((stats) => {
          if (this.session !== session) return
          setCallDiagnostics({
            rttMs: stats.rttMs,
            packetLoss: stats.packetLoss,
            qualityLimitation: stats.qualityLimitation,
          })
          void this.stepCameraLayer(session, stats.qualityLimitation)
        })
        .catch(() => {})
    }, WATCHDOG_SAMPLE_MS)
  }

  private async stepCameraLayer(
    session: CallSession,
    limitation: "none" | "cpu" | "bandwidth" | "other" | null
  ): Promise<void> {
    if (!session.cameraTrack) return
    const limited = limitation === "bandwidth" || limitation === "cpu"
    if (limited) {
      session.healthySamples = 0
      if (session.cameraLayer < CAMERA_PUBLISH_LADDER.length - 1) {
        session.cameraLayer += 1
        await this.applyCameraLayer(session)
      }
      return
    }
    session.healthySamples += 1
    if (session.healthySamples >= WATCHDOG_HEALTHY_SAMPLES_TO_UPGRADE && session.cameraLayer > 0) {
      session.healthySamples = 0
      session.cameraLayer -= 1
      await this.applyCameraLayer(session)
    }
  }

  private async applyCameraLayer(session: CallSession): Promise<void> {
    const layer = CAMERA_PUBLISH_LADDER[session.cameraLayer]
    const track = session.cameraTrack
    if (!track) return
    try {
      await track.applyConstraints({
        height: { max: layer.maxHeight },
        frameRate: { max: layer.maxFramerate },
      })
    } catch {
      // Some tracks reject mid-stream constraint tightening; the SFU still adapts.
    }
    // Resolution/framerate alone don't cap uplink bitrate — apply the ladder's
    // maxBitrate on the encoder so a collapsing uplink actually steps down.
    await session.transport.setPublishEncoding("camera", { maxBitrate: layer.maxBitrate })
  }

  // ── wake lock + devices ─────────────────────────────────────────────────

  private async acquireWakeLock(session: CallSession): Promise<void> {
    session.wakeLock = await this.deps.requestWakeLock().catch(() => null)
    if (typeof document !== "undefined") {
      const onVisibility = () => {
        if (this.session !== session) return
        if (document.visibilityState === "visible" && (!session.wakeLock || session.wakeLock.released)) {
          void this.deps.requestWakeLock().then((lock) => {
            if (this.session === session) session.wakeLock = lock
          })
        }
      }
      document.addEventListener("visibilitychange", onVisibility)
      // Store the bound handler so teardown can detach it — a listener left on
      // `document` retains the whole session closure and leaks it (and stacks
      // per call).
      session.onVisibility = onVisibility
    }
    // Auto-refresh the device list on hot-plug/unplug for the call's life.
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      const onDeviceChange = () => {
        if (this.session !== session) return
        void this.refreshDevices()
      }
      navigator.mediaDevices.addEventListener("devicechange", onDeviceChange)
      session.onDeviceChange = onDeviceChange
    }
  }

  private async refreshDevices(): Promise<void> {
    const session = this.session
    if (!session) return
    const devices = await this.deps.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
    const current = getCallState().local.devices
    const next: CallDeviceState = {
      inputs: devices.filter((d) => d.kind === "audioinput"),
      outputs: devices.filter((d) => d.kind === "audiooutput"),
      cameras: devices.filter((d) => d.kind === "videoinput"),
      selectedInputId: current.selectedInputId,
      selectedOutputId: current.selectedOutputId,
      selectedCameraId: current.selectedCameraId,
    }
    setCallDevices(next)
  }

  // ── locks ──────────────────────────────────────────────────────────────

  private acquireLock(callId: string): Promise<(() => void) | null> {
    const locks = this.deps.locks
    if (!locks) return Promise.resolve(null)
    const name = `call:${callId}`
    return new Promise<(() => void) | null>((resolveOuter) => {
      // A single `ifAvailable` request both detects a prior holder and, when
      // granted, holds the lock for the call's life. A null callback arg means
      // another tab already owns the call → activeElsewhere; a granted lock is
      // held until the returned promise resolves (on teardown/crash).
      void locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            setCallActiveElsewhere(true)
            resolveOuter(null)
            return
          }
          return new Promise<void>((releaseLock) => {
            resolveOuter(() => releaseLock())
          })
        })
        .catch(() => resolveOuter(null))
    })
  }

  // ── emit helpers ────────────────────────────────────────────────────────

  private emitLeave(session: CallSession): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      try {
        session.socket.emit("call:leave", {}, () => done())
      } catch {
        done()
      }
      // Don't wedge teardown on a missing ack.
      setTimeout(done, 2_000)
    })
  }

  private emitState(session: CallSession, state: { muted?: boolean; cameraOn?: boolean }): void {
    try {
      session.socket.emit("call:state", state)
    } catch {
      // Control event is best-effort; the roster reconciles on the next snapshot.
    }
  }

  // ── teardown ───────────────────────────────────────────────────────────

  /** Synchronous ordered hangup for the store flush (account switch / logout). */
  private hangupSync(): void {
    const session = this.session
    if (!session) return
    // Emit leave (fire-and-forget — the flush can't await), then close transport,
    // then stop tracks. The store drops state after this returns.
    try {
      session.socket.emit("call:leave", {})
    } catch {
      // ignore
    }
    void session.transport.close()
    this.stopLocalCapture(session)
    for (const key of [...session.remoteAudioEls.keys()]) this.detachRemoteAudio(session, key)
    this.clearTimers(session)
    this.removeSessionListeners(session)
    void session.wakeLock?.release().catch(() => {})
    session.releaseLock?.()
    setDictationExternalHold(false)
    try {
      session.socket.disconnect()
    } catch {
      // ignore
    }
    this.session = null
    // clearCallState is driven by the store flush itself; nothing else to do.
  }

  private async teardown(): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null
    this.clearTimers(session)
    try {
      session.socket.off("call:roster")
      session.socket.off("disconnect")
      session.socket.off("connect")
    } catch {
      // ignore
    }
    await session.transport.close().catch(() => {})
    this.stopLocalCapture(session)
    for (const key of [...session.remoteAudioEls.keys()]) this.detachRemoteAudio(session, key)
    this.removeSessionListeners(session)
    session.releaseLock?.()
    await session.wakeLock?.release().catch(() => {})
    try {
      session.socket.disconnect()
    } catch {
      // ignore
    }
    setDictationExternalHold(false)
    clearCallState()
    setCallConfirmPending(false)
    setCallActiveElsewhere(false)
  }

  private stopLocalCapture(session: CallSession): void {
    session.micTrack?.stop()
    session.cameraTrack?.stop()
    session.micStream?.getTracks().forEach((t) => t.stop())
    void session.audioContext?.close?.().catch(() => {})
    session.micTrack = null
    session.cameraTrack = null
    session.micStream = null
    session.analyser = null
  }

  private removeSessionListeners(session: CallSession): void {
    if (session.onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", session.onVisibility)
    }
    if (session.onDeviceChange && typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener("devicechange", session.onDeviceChange)
    }
    session.onVisibility = null
    session.onDeviceChange = null
  }

  private clearTimers(session: CallSession): void {
    if (session.leaseTimer) clearInterval(session.leaseTimer)
    if (session.watchdogTimer) clearInterval(session.watchdogTimer)
    if (session.meterRaf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(session.meterRaf)
    session.leaseTimer = null
    session.watchdogTimer = null
    session.meterRaf = null
  }
}

// ── production wiring ────────────────────────────────────────────────────────

function resolveCallsUrl(workspaceId: string): string | null {
  const config = getCachedWsConfig(workspaceId)
  if (!config) return null
  const base = import.meta.env.DEV ? config.wsUrl.replace("localhost", window.location.hostname) : config.wsUrl
  const url = new URL(base)
  url.pathname = "/calls"
  return url.toString()
}

export function defaultCallManagerDeps(): CallManagerDeps {
  return {
    async startCallRest({ workspaceId, streamId, mode, mediaIncarnation }) {
      return api.post<StartCallResponse>(`/api/workspaces/${workspaceId}/calls`, { streamId, mode, mediaIncarnation })
    },
    connectSocket(workspaceId) {
      const url = resolveCallsUrl(workspaceId)
      if (!url) return null
      return io(url, { path: "/socket.io/", withCredentials: true, autoConnect: true }) as unknown as CallSocket
    },
    createTransport({ workspaceId, callId }) {
      return new CloudflareSfuTransport({ workspaceId, callId })
    },
    acquireUserMedia(constraints) {
      return navigator.mediaDevices.getUserMedia(constraints)
    },
    createAudioContext() {
      const Ctx =
        typeof window !== "undefined"
          ? (window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
          : undefined
      return Ctx ? new Ctx() : null
    },
    enumerateDevices() {
      return navigator.mediaDevices.enumerateDevices()
    },
    locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : null,
    async requestWakeLock() {
      const wl =
        typeof navigator !== "undefined" ? (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock : undefined
      if (!wl) return null
      const sentinel = await wl.request("screen")
      return {
        release: () => sentinel.release(),
        get released() {
          return sentinel.released
        },
      }
    },
    mintIncarnation() {
      return `mi_${ulid()}`
    },
  }
}

let singleton: CallManager | null = null

/** Lazily build the account-scoped singleton with production deps. */
export function getCallManager(): CallManager {
  if (!singleton) singleton = new CallManager(defaultCallManagerDeps())
  return singleton
}
