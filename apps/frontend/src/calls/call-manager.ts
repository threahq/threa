import { ulid } from "ulid"
import { io } from "socket.io-client"
import { api } from "@/api/client"
import { getCachedWsConfig } from "@/lib/cached-ws-config"
import { setDictationExternalHold } from "@/contexts/dictation-coordinator-context"
import { isIosWebKit } from "@/lib/platform"
import {
  setCallSession,
  setCallPhase,
  setCallRoster,
  patchCallLocal,
  setCallSpeakingLevel,
  setCallDevices,
  setCallDiagnostics,
  setCallActiveElsewhere,
  setDisplacedCall,
  setCallConfirmPending,
  setCallCaptureError,
  bumpCallMediaEpoch,
  clearCallState,
  registerCallHangup,
  getCallState,
  type CallRosterParticipant,
  type CallDeviceState,
  type DisplacedCallReason,
} from "@/stores/call-store"
import { recordCallLifecycleEvent, type CallLifecycleKind } from "./lifecycle-log"
import { createCallMediaSession, type CallMediaSession } from "./media-session"
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
  /** The `call_started` event id — anchor for the call's chat thread (dock Chat control). */
  chatAnchorId: string | null
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

/** Thrown by an in-flight `startCall` when `leaveCall` cancels it mid-join. */
export class CallStartCancelledError extends Error {
  constructor() {
    super("Call start cancelled")
    this.name = "CallStartCancelledError"
  }
}

/**
 * Thrown when a mid-call recapture fails. `capture_failed` means the prior
 * capture was restored (audio survives); `capture_rollback_failed` means the
 * restore also failed (outbound audio is dead). The store mirrors the code.
 */
export class CallCaptureError extends Error {
  readonly code: "capture_failed" | "capture_rollback_failed"
  constructor(code: "capture_failed" | "capture_rollback_failed", cause?: unknown) {
    super(
      code === "capture_rollback_failed"
        ? "Recapture failed and the prior capture could not be restored"
        : "Recapture failed"
    )
    this.name = "CallCaptureError"
    this.code = code
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    /**
     * Binds the start to a specific live call: when set and the stream's live
     * call differs, the server returns 409 `CALL_ENDED` rather than starting a
     * new one. Threaded from ring-accept / rejoin / call-card Join, which each
     * know the call they mean to enter; a fresh start-or-join passes none.
     */
    expectedCallId?: string
    /**
     * "Join on this device": displace this user's live endpoint on another
     * device instead of being rejected by it. Only ever set by the retry after a
     * 409 `CALL_ENDPOINT_ACTIVE` — a first attempt must never take over silently.
     */
    takeover?: boolean
  }): Promise<StartCallResponse>
  /**
   * Endpoint-free REST self-leave: closes every live endpoint this user holds on
   * the call and cancels their outgoing rings. Idempotent — the rollback backstop
   * so a failed/cancelled start can't leave the leased endpoint live (~45s) or the
   * DM peer ringing (a false missed call).
   */
  leaveCallRest(args: { workspaceId: string; callId: string }): Promise<void>
  connectSocket(workspaceId: string): CallSocket | null
  createTransport(args: { workspaceId: string; callId: string }): MediaTransport
  acquireUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>
  createAudioContext(): AudioContext | null
  enumerateDevices(): Promise<MediaDeviceInfo[]>
  locks: LockManager | null
  requestWakeLock(): Promise<WakeLockLike | null>
  mintIncarnation(): string
  /**
   * The lock-screen media session for a call, or null where the platform has no
   * Media Session API. Constructed once per call and injected, so no test touches
   * a real `navigator.mediaSession`.
   */
  createMediaSession(): CallMediaSession | null
  /**
   * True on platforms that allow only one active `getUserMedia` at a time (iOS
   * Safari): a recapture must stop the live tracks before acquiring, so an
   * acquire failure is rolled back to the prior constraints. False elsewhere,
   * where the new capture is acquired before the old is stopped.
   */
  singleActiveCapture: boolean
}

interface CallSession {
  /** Monotonic generation claimed synchronously at `startCall`; identifies this incarnation. */
  gen: number
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
  /** Constraints of the current capture, so a failed recapture can be rolled back. */
  captureConstraints: { constraints: MediaStreamConstraints; camera: boolean } | null
  audioContext: AudioContext | null
  analyser: AnalyserNode | null
  pulled: Map<string, { ref: PeerTrackRef; kind: string }>
  remoteAudioEls: Map<string, HTMLAudioElement>
  /**
   * refKey → owning endpoint id, recorded from the roster in `diffPulls` so an
   * `onRemoteTrack` (which carries only the CF ref) can be attributed to the
   * roster participant whose tile renders it.
   */
  remoteTrackOwner: Map<string, string>
  /**
   * endpoint id → the video `MediaStream` a tile attaches to its `<video>`. Kept
   * on the session (never the store snapshot — see {@link CallState.mediaEpoch}),
   * carries the local camera under the session's own endpoint and each pulled
   * peer camera under theirs.
   */
  videoStreams: Map<string, MediaStream>
  cameraLayer: number
  healthySamples: number
  leaseTimer: ReturnType<typeof setInterval> | null
  watchdogTimer: ReturnType<typeof setInterval> | null
  meterRaf: number | null
  wakeLock: WakeLockLike | null
  releaseLock: (() => void) | null
  /**
   * The page was frozen or hidden by a `pagehide` since the last lease renew
   * that succeeded — i.e. we were suspended and have NOT proven the lease
   * survived. `freeze`/`pagehide` only: a desktop tab switch fires
   * `visibilitychange` and would mislabel a genuine takeover.
   */
  suspendedSinceRenew: boolean
  /** Detaches every page-lifecycle listener installed for this session. */
  onLifecycle: (() => void) | null
  onDeviceChange: (() => void) | null
}

function refKey(ref: PeerTrackRef): string {
  return `${ref.sessionId}:${ref.trackName}`
}

/**
 * A capture+publish request: the mic is always captured, the camera optionally.
 * `inputDeviceId` selects the mic; `cameraDeviceId`/`facingMode` select the
 * camera (deviceId wins when both are present, and the two are mutually
 * exclusive by construction — see {@link CallDeviceState.facingMode}).
 */
interface CaptureOpts {
  camera: boolean
  inputDeviceId?: string | null
  cameraDeviceId?: string | null
  facingMode?: "user" | "environment" | null
}

/**
 * The command surface UI components drive (INV-15: components never touch
 * `MediaTransport` or sockets). `CallManager` implements it; tests inject a fake
 * through the `CallManagerProvider`. State is read from the call-store, never
 * from here — this is action-only, plus the video ref-map accessor.
 */
export interface CallController {
  startCall(params: {
    workspaceId: string
    streamId: string
    mode: CallMode
    expectedCallId?: string
    cameraOn?: boolean
    /** Displace this user's other device — see {@link CallManagerDeps.startCallRest}. */
    takeover?: boolean
  }): Promise<void>
  leaveCall(): Promise<void>
  setMuted(muted: boolean): void
  setCameraOn(on: boolean): Promise<void>
  switchInputDevice(deviceId: string): Promise<void>
  switchCameraDevice(deviceId: string): Promise<void>
  flipCamera(): Promise<void>
  setOutputDevice(deviceId: string): Promise<void>
  getVideoStream(endpointId: string): MediaStream | null
  /**
   * Push the call's human label (the stream/DM name) at the lock-screen media
   * session. The manager holds a `streamId`, not a name, and the one stream-name
   * resolver is a hook — so the label is pushed in, never pulled.
   */
  setCallTitle(title: string): void
}

/**
 * The account-scoped, workspace-agnostic call singleton (calls carry their own
 * `workspaceId`, so — unlike the per-workspace SyncEngine — it survives a
 * workspace switch and only dies on account switch / logout via the call-store
 * flush registration). Owns the `/calls` socket, the CF transport + media, the
 * media incarnation, leases, and local capture. It never activates on its own —
 * only an explicit `startCall`/`rejoin` from a user gesture brings it up.
 */
export class CallManager implements CallController {
  private readonly deps: CallManagerDeps
  private session: CallSession | null = null
  // Monotonic generation, claimed synchronously by `startCall` before its first
  // await. Every async continuation captures the gen it belongs to and rechecks
  // `sessionForGen(gen)` before touching `this.session` or the store, so a stale
  // continuation (torn down, or superseded by a newer call) becomes a no-op.
  private sessionGen = 0
  // Synchronous in-flight sentinel: true from `startCall` entry until `runStart`
  // settles. A second `startCall` throws on it (no double-start); `leaveCall`
  // reads it to cancel a start that has not yet produced a session.
  private starting = false
  // Set by `leaveCall` during the joining window; `runStart` checks it after each
  // await and rolls back so a user's cancel wins over an in-flight join.
  private cancelStart = false
  // Serializes capture mutations (mic/camera acquire) so two never run concurrently
  // — the iOS single-active-capture rule and the reentrancy latch in one chain.
  private captureChain: Promise<void> = Promise.resolve()
  private unregisterHangup: (() => void) | null = null
  // The live call's lock-screen media session. Held on the manager, not the
  // session, because it is activated inside the start gesture — before the
  // session object exists — and `setCallTitle` can arrive at any point from then.
  private mediaSession: CallMediaSession | null = null
  private callTitle: string | null = null
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
   *
   * Synchronous (not `async`) so the in-flight guard and generation claim run
   * before the caller's synchronous tail: a second `startCall` before the first
   * settles throws here, in the caller's stack, rather than passing a post-await
   * check and leaking a whole second session.
   */
  startCall(params: {
    workspaceId: string
    streamId: string
    mode: CallMode
    expectedCallId?: string
    cameraOn?: boolean
    takeover?: boolean
  }): Promise<void> {
    if (this.session || this.starting) throw new Error("A call is already active")
    this.starting = true
    this.cancelStart = false
    const gen = ++this.sessionGen
    return this.runStart(gen, params)
  }

  private async runStart(
    gen: number,
    params: {
      workspaceId: string
      streamId: string
      mode: CallMode
      expectedCallId?: string
      cameraOn?: boolean
      takeover?: boolean
    }
  ): Promise<void> {
    const mediaIncarnation = this.deps.mintIncarnation()
    // Synchronous, in-gesture (see startCall doc). Held on a temp until the session exists.
    const audioContext = this.deps.createAudioContext()
    void audioContext?.resume().catch(() => {})
    // Also synchronous and in-gesture: the silent element only plays from a user
    // gesture, and a call that is merely ringing out must already own the session.
    this.activateMediaSession()

    // Held on locals so the catch can release them even when a throw precedes
    // `this.session = session` (teardown early-returns on a null session).
    let releaseLock: (() => void) | null = null
    let socket: CallSocket | null = null
    // Known only once the REST start responds; drives the rollback's server
    // self-leave. Null until then — a throw before the response admitted
    // nothing server-side, so there is nothing to settle.
    let callId: string | null = null
    try {
      const started = await this.deps.startCallRest({ ...params, mediaIncarnation })
      this.assertStartLive(gen)
      callId = started.call.id
      // The server owns the mode: joining an existing call ignores our requested
      // mode, so adopt `started.call.mode` (an audio_only call must stay audio_only
      // even when the launch surface hardcoded "video") — the camera control hides
      // instead of tripping the server's camera-not-allowed gate.
      const mode = started.call.mode
      setCallSession({
        callId,
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        mode,
        chatAnchorId: started.chatAnchorId,
      })
      // One tab owns the call (Web Locks). A second tab sees the lock held →
      // activeElsewhere; on this tab's crash the lock releases and the other tab
      // may offer rejoin (surfaced via the store; UI is M1.2).
      releaseLock = await this.acquireLock(callId)
      this.assertStartLive(gen)

      socket = this.deps.connectSocket(params.workspaceId)
      if (!socket) throw new Error("Calls socket is not available")

      const join = await this.joinOverSocket(socket, {
        workspaceId: params.workspaceId,
        callId,
        mediaIncarnation,
      })
      this.assertStartLive(gen)

      const transport = this.deps.createTransport({ workspaceId: params.workspaceId, callId })
      const session: CallSession = {
        gen,
        callId,
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        mode,
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
        captureConstraints: null,
        audioContext,
        analyser: null,
        pulled: new Map(),
        remoteAudioEls: new Map(),
        remoteTrackOwner: new Map(),
        videoStreams: new Map(),
        cameraLayer: 0,
        healthySamples: 0,
        leaseTimer: null,
        watchdogTimer: null,
        meterRaf: null,
        wakeLock: null,
        releaseLock,
        suspendedSinceRenew: false,
        onLifecycle: null,
        onDeviceChange: null,
      }
      this.session = session

      // Composer dictation off for the call's life — one active capture only.
      setDictationExternalHold(true)

      this.wireTransport(session)
      this.wireSocket(session)

      await transport.connect({ endpointId: join.endpointId, mediaIncarnation })
      this.assertStartLive(gen)
      // Join is mic-on; the camera comes up only when the launch asked for it
      // ("Start with camera") and the server's mode allows it — `mode: "video"` is
      // a capability, not "camera on now", and an audio_only call never publishes
      // one. A mic-only join keeps the camera dark and lets a camera-less device
      // join a video call; the camera is toggled later via setCameraOn.
      const joinWithCamera = !!params.cameraOn && mode !== "audio_only"
      // Set cameraOn BEFORE the capture: the transport's own connectionState handler
      // can flip phase→"connected" while captureAndPublish is still awaiting (mic
      // publish → ICE connects → camera publish still pending), and the surface's
      // open-state effect reads local.cameraOn on that transition — so it must
      // already be true or a camera-join opens to the bar instead of the gallery. A
      // failed capture rolls back via clearCallState, which resets cameraOn.
      if (joinWithCamera) patchCallLocal({ cameraOn: true })
      await this.captureAndPublish(session, { camera: joinWithCamera })
      this.assertStartLive(gen)
      // After the capture, not before: the toggles are seeded from `local`, and a
      // camera join sets `cameraOn` on the line above rather than through
      // `setCameraOn` (the only site that mirrors it). Seeding earlier published a
      // camera-off notification for a call whose camera is live — and the first
      // lock-screen tap, read as "turn on", would have turned it off.
      this.wireMediaSessionToggles(session)

      this.applyRoster(session, join.rosterVersion, join.roster)
      this.startLeaseTimer(session)
      this.startWatchdog(session)
      await this.acquireWakeLock(session)
      this.assertStartLive(gen)
      await this.refreshDevices()
      // Final gate before declaring connected: no await follows, so a cancel can
      // no longer race in between this check and the phase flip.
      this.assertStartLive(gen)

      setCallPhase("connected")
    } catch (err) {
      await this.rollbackStart({ workspaceId: params.workspaceId, callId, releaseLock, socket, audioContext })
      throw err
    } finally {
      this.starting = false
    }
  }

  private activateMediaSession(): void {
    const mediaSession = this.deps.createMediaSession()
    this.mediaSession = mediaSession
    if (!mediaSession) return
    mediaSession.activate({ title: this.callTitle ?? "Call", subtitle: "Threa" })
    // Hang-up only until the session exists: `setMuted`/`setCameraOn` both
    // early-return on a null session, so registering them here would put a mute
    // button on the lock screen that does nothing for the whole ring-out window.
    // `leaveCall` handles the starting path (it cancels the in-flight start).
    mediaSession.setHandlers({
      hangup: () => void this.leaveCall(),
      toggleMicrophone: null,
      toggleCamera: null,
    })
  }

  /**
   * Give the notification its toggles once they can act. Camera only on a video
   * call — `setCameraOn` returns immediately on `audio_only`, and the server's
   * mode isn't known inside the start gesture, so a handler registered there
   * would be a dead button on the default launch mode.
   */
  private wireMediaSessionToggles(session: CallSession): void {
    const mediaSession = this.mediaSession
    if (!mediaSession) return
    // The controller's own methods, so the notification drives exactly the paths
    // the in-app controls drive (INV-35).
    mediaSession.setHandlers({
      hangup: () => void this.leaveCall(),
      toggleMicrophone: () => this.setMuted(!getCallState().local.muted),
      toggleCamera: session.mode === "audio_only" ? null : () => void this.setCameraOn(!getCallState().local.cameraOn),
    })
    // The API's toggles default to inactive, so an unseeded notification shows a
    // live call as muted — and the first tap, read as "unmute", mutes.
    const local = getCallState().local
    mediaSession.setMicrophoneActive(!local.muted)
    mediaSession.setCameraActive(local.cameraOn)
  }

  private releaseMediaSession(): void {
    this.mediaSession?.release()
    this.mediaSession = null
    // Or the next call opens its notification under this one's label.
    this.callTitle = null
  }

  setCallTitle(title: string): void {
    this.callTitle = title
    this.mediaSession?.setTitle(title)
  }

  /**
   * Throws {@link CallStartCancelledError} at a start checkpoint when `leaveCall`
   * cancelled the in-flight join, or when a newer generation superseded this one.
   * Called after every await in `runStart` so a cancel wins over the join.
   */
  private assertStartLive(gen: number): void {
    if (this.cancelStart || gen !== this.sessionGen) throw new CallStartCancelledError()
  }

  /**
   * Ordered rollback of an aborted/failed start. Local cleanup: teardown if a
   * session exists, else the raw locals. Then a best-effort server settle:
   * the REST start already admitted a participant, leased an endpoint, and (for a
   * DM) rang the peer BEFORE media connected, so local cleanup alone leaves that
   * endpoint live for the lease window (~45s) and the peer ringing (a false missed
   * call). The endpoint-free REST self-leave closes all this user's endpoints for
   * the call and cancels their rings; it is idempotent, so it composes with the
   * socket leave below regardless of ordering.
   */
  private async rollbackStart(locals: {
    workspaceId: string
    callId: string | null
    releaseLock: (() => void) | null
    socket: CallSocket | null
    audioContext: AudioContext | null
  }): Promise<void> {
    const session = this.session
    if (session) {
      // Socket leave is faster while the socket is still alive; teardown then
      // releases the lock/socket/audioContext in order. The REST call below backs
      // it up in case the socket had already dropped.
      await this.emitLeave(session)
      await this.teardown()
    } else {
      // Threw before the session existed — teardown can't see these, so release the
      // lock, socket, and AudioContext here or they orphan (a held-forever call lock
      // wedges every later startCall on this tab).
      locals.releaseLock?.()
      try {
        locals.socket?.disconnect()
      } catch {
        // ignore
      }
      void locals.audioContext?.close?.().catch(() => {})
      this.releaseMediaSession()
      clearCallState()
    }
    if (locals.callId) {
      await this.deps.leaveCallRest({ workspaceId: locals.workspaceId, callId: locals.callId }).catch(() => {})
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
    // A rejoin knows exactly which call it means, so bind to it.
    await this.startCall({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      mode: params.mode,
      expectedCallId: params.callId,
    })
  }

  /** Ordered teardown: emit leave → close transport → stop tracks. */
  async leaveCall(): Promise<void> {
    // Cancel wins over an in-flight join: signal the running `runStart`, which
    // rolls back whatever it acquired (lock, socket, context, tracks) at its next
    // checkpoint — so a user's cancel during "joining" never lands a hot mic.
    if (this.starting) {
      this.cancelStart = true
      return
    }
    const session = this.session
    if (!session) return
    // Retire the generation before awaiting the leave ack (up to 2s, and longer
    // in the reconnecting case this is most often used from). Until now nothing
    // read it during that window; a re-join continuation landing in it would
    // write a displaced notice for a call the user deliberately ended.
    this.sessionGen++
    await this.emitLeave(session)
    await this.teardown()
  }

  /**
   * The live session for `gen`, or null when this generation was torn down
   * (`this.session === null`) or superseded by a newer `startCall`
   * (`gen !== this.sessionGen`). Every async continuation gates on this before
   * touching `this.session` or the global store.
   */
  private sessionForGen(gen: number): CallSession | null {
    return gen === this.sessionGen ? this.session : null
  }

  setMuted(muted: boolean): void {
    const session = this.session
    if (!session) return
    if (session.micTrack) session.micTrack.enabled = !muted
    this.mediaSession?.setMicrophoneActive(!muted)
    patchCallLocal({ muted })
    this.emitState(session, { muted })
  }

  async setCameraOn(on: boolean): Promise<void> {
    const session = this.session
    if (!session) return
    if (session.mode === "audio_only") return
    // Serialized on the capture chain so a rapid on/off/switch never runs two
    // captures at once (iOS single-active-capture) and settles at the last state.
    await this.serializeCapture(session, async () => {
      if (on) {
        // Turning the camera on re-acquires mic+camera as ONE stream (iOS single-
        // active-capture): a camera-only gUM while the mic is live would mute it.
        // Apply the stored camera selection (desktop deviceId or mobile facingMode).
        const devices = getCallState().local.devices
        await this.doCaptureAndPublish(session, {
          camera: true,
          inputDeviceId: devices.selectedInputId,
          cameraDeviceId: devices.selectedCameraId,
          facingMode: devices.facingMode,
        })
      } else if (session.cameraTrack) {
        // Camera off fully stops the track (kills the LED) and unpublishes; the
        // mic is untouched, so no recapture is needed.
        session.cameraTrack.stop()
        session.cameraTrack = null
        await session.transport.unpublish("camera")
        this.clearVideoStream(session, session.endpointId)
      }
      this.mediaSession?.setCameraActive(on)
      patchCallLocal({ cameraOn: on })
      this.emitState(session, { cameraOn: on })
    })
  }

  async switchInputDevice(deviceId: string): Promise<void> {
    const session = this.session
    if (!session) return
    // Recapture the whole stream (mic + camera if live) so iOS single-active-
    // capture never mutes the surviving track; serialized on the capture chain.
    await this.serializeCapture(session, async () => {
      // Thread the CURRENT camera selection through the recapture — a mic change
      // that re-acquires the live video track must keep the chosen camera, not
      // silently revert to the browser default.
      const devices = getCallState().local.devices
      await this.doCaptureAndPublish(session, {
        camera: session.cameraTrack != null,
        inputDeviceId: deviceId,
        cameraDeviceId: devices.selectedCameraId,
        facingMode: devices.facingMode,
      })
      patchCallLocal({ devices: { ...getCallState().local.devices, selectedInputId: deviceId } })
    })
    await this.refreshDevices()
  }

  /**
   * Switch which camera the call publishes. Stores the selection regardless (a
   * camera-off call applies it on the next {@link setCameraOn}); when the camera
   * is live, recaptures mic+camera as ONE stream (iOS single-active-capture) on
   * the new device and republishes video — audio and the call stay up. Clears any
   * facingMode flip pref, since an explicit device wins over front/back.
   */
  async switchCameraDevice(deviceId: string): Promise<void> {
    const session = this.session
    if (!session) return
    if (session.mode === "audio_only") return
    const prev = getCallState().local.devices
    patchCallLocal({
      devices: { ...prev, selectedCameraId: deviceId, facingMode: null },
    })
    if (!session.cameraTrack) return
    try {
      await this.serializeCapture(session, async () => {
        await this.doCaptureAndPublish(session, {
          camera: true,
          inputDeviceId: getCallState().local.devices.selectedInputId,
          cameraDeviceId: deviceId,
        })
      })
    } catch (err) {
      // Capture failed (e.g. camera in use); the old feed is still live, so
      // restore the pref that reflects it rather than leaving the tried device highlighted.
      patchCallLocal({
        devices: {
          ...getCallState().local.devices,
          selectedCameraId: prev.selectedCameraId,
          facingMode: prev.facingMode,
        },
      })
      throw err
    }
    await this.refreshDevices()
  }

  /**
   * Mobile front/back flip: toggle `facingMode` (defaulting the first flip to the
   * back camera) and clear the explicit deviceId. Recaptures+republishes video
   * when the camera is live; otherwise the pref applies on the next
   * {@link setCameraOn}.
   */
  async flipCamera(): Promise<void> {
    const session = this.session
    if (!session) return
    if (session.mode === "audio_only") return
    const prev = getCallState().local.devices
    const facingMode: "user" | "environment" = prev.facingMode === "environment" ? "user" : "environment"
    patchCallLocal({
      devices: { ...prev, facingMode, selectedCameraId: null },
    })
    if (!session.cameraTrack) return
    try {
      await this.serializeCapture(session, async () => {
        await this.doCaptureAndPublish(session, {
          camera: true,
          inputDeviceId: getCallState().local.devices.selectedInputId,
          facingMode,
        })
      })
    } catch (err) {
      patchCallLocal({
        devices: {
          ...getCallState().local.devices,
          facingMode: prev.facingMode,
          selectedCameraId: prev.selectedCameraId,
        },
      })
      throw err
    }
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
    const gen = session.gen
    session.socket.on("call:roster", (payload: unknown) => {
      // Session-identity gate: an event already dispatched into the loop before a
      // teardown/flush (or belonging to a superseded call) must not write the
      // prior call's roster into the store.
      const s = this.sessionForGen(gen)
      if (!s) return
      const evt = payload as RosterEvent
      if (evt.callId !== s.callId) return
      this.applyRoster(s, evt.rosterVersion, evt.roster)
    })
    // Another of this user's devices took the call over: the server closed this
    // endpoint and its CF session, so the media here is already dead. Addressed to
    // this endpoint's own room, so it is always about us — but gate on the ids
    // anyway, since a rebind reuses an endpoint id across sessions.
    session.socket.on("call:endpoint:closed", (payload: unknown) => {
      const s = this.sessionForGen(gen)
      if (!s) return
      const evt = payload as { callId?: string; endpointId?: string }
      if (evt.callId !== s.callId || evt.endpointId !== s.endpointId) return
      void this.handleTakenOver(s, "taken_over")
    })
    session.socket.on("disconnect", () => {
      // A socket drop is NOT a call end (the lease holds the slot). Demote to
      // reconnecting; the CF media session survives brief socket loss.
      if (!this.sessionForGen(gen)) return
      recordCallLifecycleEvent({ kind: "socket_disconnect" })
      setCallPhase("reconnecting")
    })
    session.socket.on("connect", () => {
      if (!this.sessionForGen(gen)) return
      recordCallLifecycleEvent({ kind: "socket_connect" })
      // Transient reconnect: rejoin with the SAME incarnation (rebinds the same
      // endpoint + epoch). A new incarnation is only minted by a fresh page load.
      this.joinOverSocket(session.socket, {
        workspaceId: session.workspaceId,
        callId: session.callId,
        mediaIncarnation: session.mediaIncarnation,
      })
        .then((join) => {
          // Recheck AFTER the awaited rejoin: teardown/leave (or a newer call)
          // may have run in between. A stale `.then` must not resurrect a phantom
          // "connected" phase or overwrite a newer call's store.
          const s = this.sessionForGen(gen)
          if (!s) return
          // A reconnect that returns a DIFFERENT endpoint id means the old lease
          // was reaped and the server minted a fresh endpoint. The transport and
          // CF media session are bound to the endpoint id captured at
          // createTransport/connect and can't be rebound in place, so every later
          // media op would 409 while the UI showed "connected". Tear down instead;
          // the user re-enters via the stream's live-call card / rejoin surfaces
          // (a fresh incarnation on the fresh endpoint).
          if (join.endpointId !== s.endpointId) {
            recordCallLifecycleEvent({ kind: "rejoin_new_endpoint", detail: join.endpointId })
            void this.handleTakenOver(s, this.ambiguousDisplacedReason(s))
            return
          }
          recordCallLifecycleEvent({ kind: "rejoin_same_endpoint" })
          s.endpointId = join.endpointId
          this.applyRoster(s, join.rosterVersion, join.roster)
          setCallPhase("connected")
        })
        .catch((err: unknown) => {
          // Same recheck: a stale failed rejoin for the OLD call must not tear
          // down whatever `this.session` now is (possibly a newly started call).
          const s = this.sessionForGen(gen)
          if (!s) return
          recordCallLifecycleEvent({ kind: "rejoin_failed", detail: err instanceof Error ? err.message : undefined })
          void this.handleTakenOver(s, this.ambiguousDisplacedReason(s))
        })
    })
  }

  /**
   * Give the call up and say why it is gone: another device took it over, or a
   * lease lapsed while this page was suspended. Every path that loses the call
   * without the user asking lands here, so none of them can vanish silently.
   *
   * Local teardown ONLY — this must not leave server-side. `call:leave` would
   * cancel this user's own outgoing ring (taking over a still-ringing DM call
   * would kill the ring the new device wants), and the endpoint-free REST leave
   * closes EVERY live endpoint of the user, including the one that just took
   * over. The endpoint here is already closed or reaped server-side; there is
   * nothing left to settle.
   *
   * The notice is written after `teardown` (which clears the store) so it
   * survives — {@link DisplacedCall}.
   */
  private async handleTakenOver(session: CallSession, reason: DisplacedCallReason): Promise<void> {
    const displaced = {
      callId: session.callId,
      workspaceId: session.workspaceId,
      streamId: session.streamId,
      mode: session.mode,
      reason,
    }
    await this.teardown()
    setDisplacedCall(displaced)
  }

  /**
   * A lost endpoint with no cause attached. `renewLease` returns the same null
   * for a superseded lease as for one the sweeper reaped, and a re-join that
   * fails or returns a new endpoint id says nothing about who holds the call —
   * so none of these may claim a takeover, which only the
   * `call:endpoint:closed` push proves. Being suspended since the last good
   * renew is the only evidence the client has, and it separates a locked phone
   * from a network gap longer than the lease TTL.
   */
  private ambiguousDisplacedReason(session: CallSession): DisplacedCallReason {
    return session.suspendedSinceRenew ? "ended_while_away" : "connection_lost"
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
      if (!p.endpointId || p.endpointId === session.endpointId) continue
      if (p.connectionStatus !== "connected" && p.connectionStatus !== "reconnecting") continue
      // The publisher's CF session id is required to pull. The 0.2 roster does
      // not carry it (contract gap) — skip peers we can't address rather than
      // constructing an unpullable ref.
      if (!p.cfSessionId) continue
      for (const track of p.publishedTracks) {
        const ref: PeerTrackRef = { sessionId: p.cfSessionId, trackName: track.trackName }
        const key = refKey(ref)
        desired.set(key, { ref, kind: track.kind })
        // Attribute the eventual onRemoteTrack (CF ref only) to this participant's tile.
        session.remoteTrackOwner.set(key, p.endpointId)
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
        this.detachRemoteVideo(session, key)
        session.remoteTrackOwner.delete(key)
      }
    }
  }

  // ── media ──────────────────────────────────────────────────────────────────

  /**
   * Serialize a capture mutation on the capture chain: never two acquires in
   * flight at once (iOS single-active-capture) and the reentrancy latch behind
   * camera-toggle / input-switch. A mutation queued while the session was torn
   * down is skipped. Chain links swallow their own outcome so one failure does
   * not poison later mutations, but the result still propagates to the caller.
   */
  private serializeCapture(session: CallSession, fn: () => Promise<void>): Promise<void> {
    const run = this.captureChain.then(() => {
      if (this.sessionForGen(session.gen) !== session) return
      return fn()
    })
    this.captureChain = run.then(
      () => {},
      () => {}
    )
    return run
  }

  private captureAndPublish(session: CallSession, opts: CaptureOpts): Promise<void> {
    return this.serializeCapture(session, () => this.doCaptureAndPublish(session, opts))
  }

  private buildCaptureConstraints(opts: CaptureOpts): MediaStreamConstraints {
    const audio: MediaTrackConstraints = opts.inputDeviceId
      ? { ...AUDIO_CAPTURE_CONSTRAINTS, deviceId: { exact: opts.inputDeviceId } }
      : AUDIO_CAPTURE_CONSTRAINTS
    if (!opts.camera) return { audio }
    return { audio, video: this.buildVideoConstraints(opts) }
  }

  /**
   * Camera constraints with the caller's selection applied. An explicit
   * `cameraDeviceId` (desktop picker) wins over `facingMode` (mobile flip); with
   * neither, the unmodified capture defaults let the browser pick a camera.
   */
  private buildVideoConstraints(opts: CaptureOpts): MediaTrackConstraints {
    if (opts.cameraDeviceId) return { ...VIDEO_CAPTURE_CONSTRAINTS, deviceId: { exact: opts.cameraDeviceId } }
    if (opts.facingMode) return { ...VIDEO_CAPTURE_CONSTRAINTS, facingMode: opts.facingMode }
    return VIDEO_CAPTURE_CONSTRAINTS
  }

  /**
   * Acquire mic (and camera when requested) in a SINGLE getUserMedia and publish
   * the split tracks. Combined capture is the iOS rule: a second concurrent gUM
   * mutes the first (single-active-capture). Ordering by platform:
   *
   * - Single-active-capture (iOS): stop the live capture, THEN acquire. If the
   *   acquire rejects (permission revoked, `NotReadableError`), roll back to the
   *   previous constraints so outbound audio survives, and surface a typed
   *   {@link CallCaptureError}.
   * - Elsewhere: acquire the NEW capture FIRST, only stop the old once it
   *   succeeds — a failed acquire leaves the current tracks untouched.
   *
   * Always run through {@link serializeCapture}, never called directly.
   */
  private async doCaptureAndPublish(session: CallSession, opts: CaptureOpts): Promise<void> {
    const constraints = this.buildCaptureConstraints(opts)
    const prev = session.captureConstraints

    if (this.deps.singleActiveCapture) {
      this.stopCapture(session)
      let stream: MediaStream
      try {
        stream = await this.deps.acquireUserMedia(constraints)
      } catch (acquireErr) {
        if (this.sessionForGen(session.gen) !== session) throw acquireErr
        await this.rollbackCapture(session, prev, acquireErr)
        return // rollbackCapture always throws
      }
      if (this.sessionForGen(session.gen) !== session) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      await this.publishStream(session, stream, opts.camera)
      session.captureConstraints = { constraints, camera: opts.camera }
      setCallCaptureError(null)
      return
    }

    let stream: MediaStream
    try {
      stream = await this.deps.acquireUserMedia(constraints)
    } catch (acquireErr) {
      // Old capture untouched — outbound audio survives; just report the failure.
      setCallCaptureError({ code: "capture_failed", message: describeError(acquireErr) })
      throw new CallCaptureError("capture_failed", acquireErr)
    }
    if (this.sessionForGen(session.gen) !== session) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stopCapture(session)
    await this.publishStream(session, stream, opts.camera)
    session.captureConstraints = { constraints, camera: opts.camera }
    setCallCaptureError(null)
  }

  /** Publish a freshly acquired stream's tracks and rewire the speaking analyser. */
  private async publishStream(session: CallSession, stream: MediaStream, camera: boolean): Promise<void> {
    session.micStream = stream

    const micTrack = stream.getAudioTracks()[0] ?? null
    session.micTrack = micTrack
    if (micTrack) {
      micTrack.enabled = !getCallState().local.muted
      try {
        await session.transport.publish("mic", micTrack)
      } catch (publishErr) {
        // Mic publish failed on this fresh capture — stop the WHOLE stream (the mic
        // and any not-yet-published camera track) so no acquired-but-unpublished
        // track stays live, then let the caller's rollback run. The prior capture
        // was already stopped before publish, so nothing survives to restore here.
        stream.getTracks().forEach((t) => t.stop())
        session.micTrack = null
        session.cameraTrack = null
        session.micStream = null
        throw publishErr
      }
    }

    const cameraTrack = camera ? (stream.getVideoTracks()[0] ?? null) : null
    session.cameraTrack = cameraTrack
    if (cameraTrack) {
      try {
        await session.transport.publish("camera", cameraTrack)
        await this.applyCameraLayer(session)
        // Surface the local preview under the session's own endpoint id (self is on
        // the roster with that endpoint), so the self tile renders it uniformly.
        this.setVideoStream(session, session.endpointId, cameraTrack)
      } catch (publishErr) {
        // The camera track is live (LED on, possibly transmitting) but its publish
        // failed — stop it and drop all camera state so the UI's camera-off truth
        // matches the hardware. The mic published just above is left untouched.
        cameraTrack.stop()
        session.cameraTrack = null
        this.clearVideoStream(session, session.endpointId)
        await session.transport.unpublish("camera").catch(() => {})
        setCallCaptureError({ code: "capture_failed", message: describeError(publishErr) })
        throw new CallCaptureError("capture_failed", publishErr)
      }
    } else {
      this.clearVideoStream(session, session.endpointId)
    }

    this.wireSpeakingAnalyser(session, stream)
  }

  /**
   * iOS recapture-failure rollback: the live tracks are already stopped, so
   * re-acquire the previous constraints and republish them. Always throws — a
   * successful restore throws `capture_failed` (switch failed, audio back); a
   * failed restore throws `capture_rollback_failed` (audio dead).
   */
  private async rollbackCapture(
    session: CallSession,
    prev: { constraints: MediaStreamConstraints; camera: boolean } | null,
    acquireErr: unknown
  ): Promise<never> {
    this.stopCapture(session)
    if (prev) {
      try {
        const restored = await this.deps.acquireUserMedia(prev.constraints)
        if (this.sessionForGen(session.gen) === session) {
          await this.publishStream(session, restored, prev.camera)
          session.captureConstraints = prev
        } else {
          restored.getTracks().forEach((t) => t.stop())
        }
      } catch (rollbackErr) {
        setCallCaptureError({ code: "capture_rollback_failed", message: describeError(rollbackErr) })
        throw new CallCaptureError("capture_rollback_failed", rollbackErr)
      }
    }
    setCallCaptureError({ code: "capture_failed", message: describeError(acquireErr) })
    throw new CallCaptureError("capture_failed", acquireErr)
  }

  /** Stop and drop the current local capture tracks (does not touch the AudioContext). */
  private stopCapture(session: CallSession): void {
    session.micTrack?.stop()
    session.cameraTrack?.stop()
    session.micStream?.getTracks().forEach((t) => t.stop())
    session.micTrack = null
    session.cameraTrack = null
    session.micStream = null
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
      else if (event.track.kind === "video") this.attachRemoteVideo(session, event.ref, event.track)
    }
    session.transport.onRemoteTrackEnded = (ref) => {
      const key = refKey(ref)
      this.detachRemoteAudio(session, key)
      this.detachRemoteVideo(session, key)
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

  // ── video registry (tiles read this via getVideoStream; never the store) ────

  /** Wrap a track in a `MediaStream`, or null where the constructor is unavailable (jsdom). */
  private makeVideoStream(track: MediaStreamTrack): MediaStream | null {
    if (typeof MediaStream === "undefined") return null
    return new MediaStream([track])
  }

  /** Register/replace an endpoint's video stream and tick the ref-map version. */
  private setVideoStream(session: CallSession, endpointId: string, track: MediaStreamTrack): void {
    const stream = this.makeVideoStream(track)
    if (!stream) return
    session.videoStreams.set(endpointId, stream)
    bumpCallMediaEpoch()
  }

  /** Drop an endpoint's video stream and tick the version, if one was present. */
  private clearVideoStream(session: CallSession, endpointId: string): void {
    if (session.videoStreams.delete(endpointId)) bumpCallMediaEpoch()
  }

  private attachRemoteVideo(session: CallSession, ref: PeerTrackRef, track: MediaStreamTrack): void {
    const endpointId = session.remoteTrackOwner.get(refKey(ref))
    if (!endpointId) return
    this.setVideoStream(session, endpointId, track)
  }

  private detachRemoteVideo(session: CallSession, key: string): void {
    const endpointId = session.remoteTrackOwner.get(key)
    if (endpointId) this.clearVideoStream(session, endpointId)
  }

  /**
   * The video `MediaStream` for a roster participant's endpoint (self's own
   * camera under the session endpoint, or a pulled peer's camera), or null when
   * that endpoint publishes no video. Tiles attach it to their `<video>` and
   * re-read on {@link CallState.mediaEpoch} changes.
   */
  getVideoStream(endpointId: string): MediaStream | null {
    return this.session?.videoStreams.get(endpointId) ?? null
  }

  // ── lease + watchdog ─────────────────────────────────────────────────────

  private startLeaseTimer(session: CallSession): void {
    const gen = session.gen
    const interval = leaseRenewIntervalMs(session.leaseTtlMs)
    session.leaseTimer = setInterval(() => {
      session.socket.emit("call:lease:renew", {}, (result: unknown) => {
        // The ack can arrive after teardown/supersession; gate before acting so a
        // stale ack never tears down a newer call.
        if (!this.sessionForGen(gen)) return
        const ack = result as Ack<{ leaseExpiresAt: string }>
        if (ack?.ok) {
          session.suspendedSinceRenew = false
          recordCallLifecycleEvent({ kind: "lease_renew_ok" })
        } else recordCallLifecycleEvent({ kind: "lease_renew_failed", detail: ack?.code })
        // A superseded lease means our endpoint was taken over — the call is lost
        // on this incarnation. The socket push above normally gets here first;
        // this is the backstop for a device that lost the socket, and it lands on
        // the same displaced state so the outcome doesn't depend on which won.
        if (!ack?.ok && ack?.code === "CALL_LEASE_SUPERSEDED") {
          const s = this.sessionForGen(gen)
          if (s) void this.handleTakenOver(s, this.ambiguousDisplacedReason(s))
        }
      })
    }, interval)
  }

  private startWatchdog(session: CallSession): void {
    const gen = session.gen
    session.watchdogTimer = setInterval(() => {
      void session.transport
        .getStats()
        .then((stats) => {
          if (this.sessionForGen(gen) !== session) return
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

  /**
   * One listener set for the page-lifecycle signals: visibility carries both the
   * log entry and the wake-lock re-acquire (one listener, two jobs), `freeze`/
   * `resume` are `document` events, `pagehide`/`pageshow` are `window` events.
   * The returned detach closure is stored on the session — a listener left
   * attached retains the whole session closure and stacks per call.
   */
  private installLifecycleListeners(session: CallSession): void {
    if (typeof document === "undefined") return
    const onVisibility = () => {
      if (this.session !== session) return
      const visible = document.visibilityState === "visible"
      recordCallLifecycleEvent({ kind: visible ? "visible" : "hidden" })
      if (visible && (!session.wakeLock || session.wakeLock.released)) {
        void this.deps.requestWakeLock().then((lock) => {
          if (this.session === session) session.wakeLock = lock
        })
      }
    }
    const recorder = (kind: CallLifecycleKind) => () => {
      if (this.session !== session) return
      recordCallLifecycleEvent({ kind })
    }
    const suspendRecorder = (kind: CallLifecycleKind) => () => {
      if (this.session !== session) return
      session.suspendedSinceRenew = true
      recordCallLifecycleEvent({ kind })
    }
    const bindings: Array<[EventTarget, string, () => void]> = [
      [document, "visibilitychange", onVisibility],
      [document, "freeze", suspendRecorder("freeze")],
      [document, "resume", recorder("resume")],
    ]
    if (typeof window !== "undefined") {
      bindings.push([window, "pagehide", suspendRecorder("pagehide")], [window, "pageshow", recorder("pageshow")])
    }
    for (const [target, event, handler] of bindings) target.addEventListener(event, handler)
    session.onLifecycle = () => {
      for (const [target, event, handler] of bindings) target.removeEventListener(event, handler)
    }
  }

  private async acquireWakeLock(session: CallSession): Promise<void> {
    session.wakeLock = await this.deps.requestWakeLock().catch(() => null)
    this.installLifecycleListeners(session)
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
    // A live camera resolves a bare deviceId/facingMode capture to a concrete
    // device only its track knows; reflect that so the picker highlights the
    // actual active camera. Falls back to the prior value when no camera is live.
    // `|| null` not `?? null`: a granted track can report deviceId "" (permission
    // quirk) — treat empty as "unknown" so it can't clobber a real selection.
    const liveCameraId = session.cameraTrack?.getSettings?.().deviceId || null
    const next: CallDeviceState = {
      inputs: devices.filter((d) => d.kind === "audioinput"),
      outputs: devices.filter((d) => d.kind === "audiooutput"),
      cameras: devices.filter((d) => d.kind === "videoinput"),
      selectedInputId: current.selectedInputId,
      selectedOutputId: current.selectedOutputId,
      selectedCameraId: liveCameraId ?? current.selectedCameraId,
      facingMode: current.facingMode,
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
    // During most of runStart `starting` is true with no session yet, so the
    // session teardown below would no-op and the in-flight continuation would go
    // on to create a session and hot-mic under the just-switched-to account.
    // Cancel it: the gen bump fails every assertStartLive / sessionForGen, so
    // runStart rolls back at its next checkpoint (the rollback also settles the
    // server endpoint).
    if (this.starting) {
      this.cancelStart = true
      this.sessionGen++
    }
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
    // Symmetric with teardown: detach the socket handlers so a roster/connect
    // event already dispatched into the loop before this flush can't run against
    // the just-switched-to account (the handlers also gate on gen, belt-and-braces).
    this.removeSocketHandlers(session)
    void session.wakeLock?.release().catch(() => {})
    this.releaseMediaSession()
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
    recordCallLifecycleEvent({ kind: "teardown" })
    this.session = null
    this.clearTimers(session)
    this.removeSocketHandlers(session)
    await session.transport.close().catch(() => {})
    this.stopLocalCapture(session)
    for (const key of [...session.remoteAudioEls.keys()]) this.detachRemoteAudio(session, key)
    this.removeSessionListeners(session)
    session.releaseLock?.()
    await session.wakeLock?.release().catch(() => {})
    this.releaseMediaSession()
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

  private removeSocketHandlers(session: CallSession): void {
    try {
      session.socket.off("call:roster")
      session.socket.off("call:endpoint:closed")
      session.socket.off("disconnect")
      session.socket.off("connect")
    } catch {
      // ignore
    }
  }

  private removeSessionListeners(session: CallSession): void {
    session.onLifecycle?.()
    if (session.onDeviceChange && typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener("devicechange", session.onDeviceChange)
    }
    session.onLifecycle = null
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

/**
 * iOS/iPadOS Safari allows only one active `getUserMedia` at a time — a second
 * concurrent capture mutes the first. Kept as its own name because that is a
 * capture rule, not a platform fact; the probe itself is shared (INV-35).
 */
function detectSingleActiveCapture(): boolean {
  return isIosWebKit()
}

export function defaultCallManagerDeps(): CallManagerDeps {
  return {
    async startCallRest({ workspaceId, streamId, mode, mediaIncarnation, expectedCallId, takeover }) {
      return api.post<StartCallResponse>(`/api/workspaces/${workspaceId}/calls`, {
        streamId,
        mode,
        mediaIncarnation,
        expectedCallId,
        takeover,
      })
    },
    async leaveCallRest({ workspaceId, callId }) {
      await api.post(`/api/workspaces/${workspaceId}/calls/${callId}/leave`, {})
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
    createMediaSession() {
      return createCallMediaSession()
    },
    singleActiveCapture: detectSingleActiveCapture(),
  }
}

let singleton: CallManager | null = null

/** Lazily build the account-scoped singleton with production deps. */
export function getCallManager(): CallManager {
  if (!singleton) singleton = new CallManager(defaultCallManagerDeps())
  return singleton
}
