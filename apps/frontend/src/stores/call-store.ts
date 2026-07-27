import { useSyncExternalStore } from "react"
import type { CallMode, PublishedTrackKind } from "@/calls/config"
import type { DesktopSurface } from "./call-prefs-store"

// Module store (useSyncExternalStore) for the single active call. The CallManager
// (non-React, account-scoped) is the sole writer; components read via the hooks.
// Registered in `flushModuleStoreCaches` (account-scope.tsx) — the reset performs
// the ordered hangup (emit leave → close transport → stop tracks) BEFORE dropping
// state, so an account switch never leaves the prior account's mic hot. A guard
// test asserts the registration exists (the flush list is hand-maintained).

export type CallPhase = "idle" | "joining" | "connected" | "reconnecting"

/**
 * Unified surface size for the call UI. One enum, four steps; each surface maps a
 * step to its own presentation (mobile Tab/Bar/Tiny-gallery/Fullscreen; desktop-side
 * Rail/Panel/Wide/Fullscreen). The floating square ignores it (own local state).
 * Ephemeral — defaults to "min" and resets to "min" on teardown, like the roster.
 */
export type CallSurfaceMode = "min" | "compact" | "standard" | "full"

export interface CallPublishedTrack {
  kind: PublishedTrackKind
  trackName: string
}

export interface CallRosterParticipant {
  userId: string
  participantStatus: "joined" | "left" | "removed"
  endpointId: string | null
  connectionStatus: "connected" | "reconnecting" | "closed" | null
  mediaState: { muted?: boolean; cameraOn?: boolean }
  publishedTracks: CallPublishedTrack[]
  /**
   * The publisher endpoint's CF session id — required to pull this participant's
   * tracks. NOT sent by the 0.2 roster (contract gap, see PR report); when
   * absent the CallManager cannot pull this peer's media.
   */
  cfSessionId?: string | null
}

export interface CallDeviceState {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
  selectedInputId: string | null
  selectedOutputId: string | null
  selectedCameraId: string | null
  /**
   * Mobile front/back flip preference. A flip sets this and clears
   * `selectedCameraId`; picking an explicit device sets that and clears this. They
   * are not permanently exclusive, though: once a facingMode capture lands,
   * `refreshDevices` reflects the resulting device back into `selectedCameraId`
   * (so the picker highlights it), leaving both set. Capture precedence is
   * deviceId → facingMode → default, so an explicit device always wins next.
   */
  facingMode: "user" | "environment" | null
}

export interface CallLocalState {
  muted: boolean
  cameraOn: boolean
  devices: CallDeviceState
  /** Local speaking level [0,1] from the AudioContext analyser. */
  speakingLevel: number
}

export interface CallDiagnostics {
  rttMs: number | null
  packetLoss: number | null
  qualityLimitation: "none" | "cpu" | "bandwidth" | "other" | null
}

/**
 * Surfaced when a mid-call recapture (device switch / camera on) fails. `code`
 * distinguishes a switch that failed but restored the prior capture
 * (`capture_failed`, audio survives) from one whose rollback also failed
 * (`capture_rollback_failed`, outbound audio is dead). Cleared on the next
 * successful capture and on teardown.
 */
export interface CallCaptureErrorInfo {
  code: "capture_failed" | "capture_rollback_failed"
  message: string
}

/**
 * Why the call left this device, in descending order of what we actually know.
 *
 * `taken_over` is claimed ONLY for the `call:endpoint:closed` push — the server
 * closed this endpoint under the call-row lock, so it is the one signal that
 * proves another device took the call. Every other signal is a lost endpoint
 * with no cause attached: `renewLease` returns the same null for a superseded
 * lease as for one the sweeper reaped, and a re-join that fails or comes back
 * with a new endpoint id says nothing about who has the call now. Those split on
 * the only evidence the client holds — whether this page was suspended since its
 * last good renew — into `ended_while_away` (it was) and `connection_lost` (it
 * was not, so the likely cause is a network gap longer than the lease TTL).
 *
 * Guessing `taken_over` for the ambiguous cases is what this type exists to
 * prevent: it tells a user their call moved to a device they never touched.
 */
export type DisplacedCallReason = "taken_over" | "ended_while_away" | "connection_lost"

/**
 * The call this device lost without the user ending it. Survives the teardown
 * that removes the call itself — the manager writes it AFTER `clearCallState` —
 * so the dock can say what happened and offer the call back instead of the
 * surface silently vanishing. Cleared by a dismiss, by the next call, and by an
 * account switch.
 */
export interface DisplacedCall {
  callId: string
  workspaceId: string
  streamId: string
  mode: CallMode
  reason: DisplacedCallReason
}

export interface CallState {
  phase: CallPhase
  /** Unified surface size ({@link CallSurfaceMode}); "min" until a surface steps it up. */
  surfaceMode: CallSurfaceMode
  /**
   * In-call desktop-surface override — an explicit dock-to-side / float this call
   * only. Wins over the persisted pref while set; cleared on teardown (so a pinned
   * Sidebar/Floating governs the next call). Session-scoped like {@link surfaceMode}.
   */
  desktopSurfaceOverride: DesktopSurface | null
  /**
   * `Date.now()` at the first "connected" transition — the in-call timer anchor.
   * Stamped once and preserved across reconnects (a blip must not reset the clock);
   * reset to null on a new session and on teardown.
   */
  connectedAt: number | null
  callId: string | null
  workspaceId: string | null
  streamId: string | null
  /**
   * The `call_started` event id — the anchor for this call's chat thread. Handed
   * back by the start/join REST response so the dock's Chat control can open the
   * thread panel (draft on the anchor, or the real thread once it exists) without
   * loading the host-stream timeline. Null when the started card row is missing.
   */
  chatAnchorId: string | null
  mode: CallMode | null
  roster: CallRosterParticipant[]
  rosterVersion: number
  local: CallLocalState
  /** True when another tab holds the call's Web Lock (this tab can offer rejoin). */
  activeElsewhere: boolean
  /** Set when another device took this call over; see {@link DisplacedCall}. */
  displacedCall: DisplacedCall | null
  /** Set when an account switch is requested with a live call — UI confirms (M1.2). */
  confirmPending: boolean
  diagnostics: CallDiagnostics
  /** Last mid-call recapture failure, or null. See {@link CallCaptureErrorInfo}. */
  captureError: CallCaptureErrorInfo | null
  /**
   * Monotonic tick bumped whenever the CallManager's per-endpoint video-track
   * ref-map changes (a camera track attaches/detaches). The live
   * `MediaStream`/`MediaStreamTrack` objects stay OFF the store snapshot — they
   * are unstable for `useSyncExternalStore` and never belong in React state — so
   * tiles read them from `getCallManager().getVideoStream(endpointId)` and
   * re-attach their `<video>` when this counter changes. Discrete, not per-frame.
   */
  mediaEpoch: number
}

const EMPTY_DEVICES: CallDeviceState = {
  inputs: [],
  outputs: [],
  cameras: [],
  selectedInputId: null,
  selectedOutputId: null,
  selectedCameraId: null,
  facingMode: null,
}

function idleState(): CallState {
  return {
    phase: "idle",
    surfaceMode: "min",
    desktopSurfaceOverride: null,
    connectedAt: null,
    callId: null,
    workspaceId: null,
    streamId: null,
    chatAnchorId: null,
    mode: null,
    roster: [],
    rosterVersion: 0,
    local: { muted: false, cameraOn: false, devices: EMPTY_DEVICES, speakingLevel: 0 },
    activeElsewhere: false,
    displacedCall: null,
    confirmPending: false,
    diagnostics: { rttMs: null, packetLoss: null, qualityLimitation: null },
    captureError: null,
    mediaEpoch: 0,
  }
}

let state: CallState = idleState()
const listeners = new Set<() => void>()

// The CallManager registers its ordered-hangup here so `resetCallStoreCache`
// (the flush entry point) can tear the live call down without the store importing
// the manager (which would be circular). A plain ref, not reactive state.
let hangupRef: (() => void) | null = null

function emit(): void {
  for (const listener of listeners) listener()
}

function setState(next: CallState): void {
  state = next
  emit()
}

export function getCallState(): CallState {
  return state
}

export function registerCallHangup(hangup: () => void): () => void {
  hangupRef = hangup
  return () => {
    if (hangupRef === hangup) hangupRef = null
  }
}

export function setCallPhase(phase: CallPhase): void {
  if (state.phase === phase) return
  // Stamp the timer anchor on the first connect; keep it across reconnects.
  const connectedAt = phase === "connected" ? (state.connectedAt ?? Date.now()) : state.connectedAt
  setState({ ...state, phase, connectedAt })
}

export function setCallSurfaceMode(surfaceMode: CallSurfaceMode): void {
  if (state.surfaceMode === surfaceMode) return
  setState({ ...state, surfaceMode })
}

export function setDesktopSurfaceOverride(desktopSurfaceOverride: DesktopSurface | null): void {
  if (state.desktopSurfaceOverride === desktopSurfaceOverride) return
  setState({ ...state, desktopSurfaceOverride })
}

export function setCallSession(args: {
  callId: string
  workspaceId: string
  streamId: string
  mode: CallMode
  /** The `call_started` event id anchoring this call's chat thread; null if unknown. */
  chatAnchorId?: string | null
}): void {
  const { chatAnchorId = null, ...session } = args
  // A new call supersedes any "this moved to another device" notice, including
  // the one whose Rejoin started this very call.
  setState({ ...state, ...session, chatAnchorId, phase: "joining", connectedAt: null, displacedCall: null })
}

export function setCallRoster(roster: CallRosterParticipant[], rosterVersion: number): void {
  setState({ ...state, roster, rosterVersion })
}

export function patchCallLocal(patch: Partial<CallLocalState>): void {
  setState({ ...state, local: { ...state.local, ...patch } })
}

export function setCallSpeakingLevel(level: number): void {
  if (state.local.speakingLevel === level) return
  setState({ ...state, local: { ...state.local, speakingLevel: level } })
}

export function setCallDevices(devices: CallDeviceState): void {
  setState({ ...state, local: { ...state.local, devices } })
}

export function setCallDiagnostics(diagnostics: CallDiagnostics): void {
  setState({ ...state, diagnostics })
}

export function setCallActiveElsewhere(activeElsewhere: boolean): void {
  if (state.activeElsewhere === activeElsewhere) return
  setState({ ...state, activeElsewhere })
}

/**
 * Record (or dismiss) the call another device took over. Written by the manager
 * AFTER its teardown has cleared the call state, which is the only ordering that
 * survives — see {@link DisplacedCall}.
 */
export function setDisplacedCall(displacedCall: DisplacedCall | null): void {
  if (state.displacedCall === displacedCall) return
  setState({ ...state, displacedCall })
}

export function setCallConfirmPending(confirmPending: boolean): void {
  if (state.confirmPending === confirmPending) return
  setState({ ...state, confirmPending })
}

export function setCallCaptureError(captureError: CallCaptureErrorInfo | null): void {
  if (state.captureError === captureError) return
  setState({ ...state, captureError })
}

/** Bump the video ref-map version tick (see {@link CallState.mediaEpoch}). */
export function bumpCallMediaEpoch(): void {
  setState({ ...state, mediaEpoch: state.mediaEpoch + 1 })
}

/** Drop all call state without a hangup — the manager calls this after teardown. */
export function clearCallState(): void {
  setState(idleState())
}

/**
 * Flush entry point (account switch / logout). Performs the ordered hangup FIRST
 * — emit leave, close transport, stop tracks (the manager's registered callback)
 * — THEN drops state, so a switch with a live call never strands a hot mic.
 */
export function resetCallStoreCache(): void {
  hangupRef?.()
  setState(idleState())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Raw store subscription. Exposed so selector hooks (`call-store-hooks.ts`) can
 * subscribe once and re-render only on the slice they read — the whole-state
 * {@link useCallState} re-renders every consumer on any change, including the
 * per-frame `speakingLevel` tick.
 */
export function subscribeCall(listener: () => void): () => void {
  return subscribe(listener)
}

export function useCallState(): CallState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}
