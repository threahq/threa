import { useSyncExternalStore } from "react"
import type { CallMode, PublishedTrackKind } from "@/calls/config"

// Module store (useSyncExternalStore) for the single active call. The CallManager
// (non-React, account-scoped) is the sole writer; components read via the hooks.
// Registered in `flushModuleStoreCaches` (account-scope.tsx) — the reset performs
// the ordered hangup (emit leave → close transport → stop tracks) BEFORE dropping
// state, so an account switch never leaves the prior account's mic hot. A guard
// test asserts the registration exists (the flush list is hand-maintained).

export type CallPhase = "idle" | "joining" | "connected" | "reconnecting"

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

export interface CallState {
  phase: CallPhase
  callId: string | null
  workspaceId: string | null
  streamId: string | null
  mode: CallMode | null
  roster: CallRosterParticipant[]
  rosterVersion: number
  local: CallLocalState
  /** True when another tab holds the call's Web Lock (this tab can offer rejoin). */
  activeElsewhere: boolean
  /** Set when an account switch is requested with a live call — UI confirms (M1.2). */
  confirmPending: boolean
  diagnostics: CallDiagnostics
}

const EMPTY_DEVICES: CallDeviceState = {
  inputs: [],
  outputs: [],
  cameras: [],
  selectedInputId: null,
  selectedOutputId: null,
  selectedCameraId: null,
}

function idleState(): CallState {
  return {
    phase: "idle",
    callId: null,
    workspaceId: null,
    streamId: null,
    mode: null,
    roster: [],
    rosterVersion: 0,
    local: { muted: false, cameraOn: false, devices: EMPTY_DEVICES, speakingLevel: 0 },
    activeElsewhere: false,
    confirmPending: false,
    diagnostics: { rttMs: null, packetLoss: null, qualityLimitation: null },
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
  setState({ ...state, phase })
}

export function setCallSession(args: { callId: string; workspaceId: string; streamId: string; mode: CallMode }): void {
  setState({ ...state, ...args, phase: "joining" })
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

export function setCallConfirmPending(confirmPending: boolean): void {
  if (state.confirmPending === confirmPending) return
  setState({ ...state, confirmPending })
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

export function useCallState(): CallState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}
