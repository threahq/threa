import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import {
  subscribeCall,
  getCallState,
  type CallState,
  type CallPhase,
  type CallSurfaceMode,
  type CallRosterParticipant,
  type CallDeviceState,
  type CallDiagnostics,
  type CallCaptureErrorInfo,
} from "@/stores/call-store"
import type { CallMode } from "@/calls/config"

/**
 * Slice-scoped reads over the call store. {@link useCallState} re-renders every
 * consumer on ANY change — including the per-frame `speakingLevel` tick from the
 * analyser (the 1.1 review's flagged 60fps concern). These hooks cache the
 * selected value by reference so a store change that doesn't touch the slice
 * yields the same snapshot and React bails the re-render. The speaking level is
 * never selected here — it drives the tile ring through {@link useSpeakingLevelRef}
 * (ref-only, zero re-renders) — so a talking participant never re-renders the dock.
 */
function useCallSelector<T>(selector: (s: CallState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const isEqualRef = useRef(isEqual)
  isEqualRef.current = isEqual
  const cache = useRef<{ value: T } | null>(null)
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(getCallState())
    const prev = cache.current
    if (prev && isEqualRef.current(prev.value, next)) return prev.value
    cache.current = { value: next }
    return next
  }, [])
  return useSyncExternalStore(subscribeCall, getSnapshot, getSnapshot)
}

export function useCallPhase(): CallPhase {
  return useCallSelector((s) => s.phase)
}

export function useCallSurfaceMode(): CallSurfaceMode {
  return useCallSelector((s) => s.surfaceMode)
}

export function useCallStreamId(): string | null {
  return useCallSelector((s) => s.streamId)
}

export function useCallConnectedAt(): number | null {
  return useCallSelector((s) => s.connectedAt)
}

export function useCallMode(): CallMode | null {
  return useCallSelector((s) => s.mode)
}

export function useCallWorkspaceId(): string | null {
  return useCallSelector((s) => s.workspaceId)
}

export function useCallRoster(): CallRosterParticipant[] {
  // A roster update replaces the array reference, so identity equality is a
  // precise change signal — the per-frame speaking tick never touches it.
  return useCallSelector((s) => s.roster)
}

export function useCallMuted(): boolean {
  return useCallSelector((s) => s.local.muted)
}

export function useCallCameraOn(): boolean {
  return useCallSelector((s) => s.local.cameraOn)
}

export function useCallDevices(): CallDeviceState {
  return useCallSelector((s) => s.local.devices)
}

export function useCallDiagnostics(): CallDiagnostics {
  return useCallSelector((s) => s.diagnostics)
}

export function useCallActiveElsewhere(): boolean {
  return useCallSelector((s) => s.activeElsewhere)
}

export function useCallCaptureError(): CallCaptureErrorInfo | null {
  return useCallSelector((s) => s.captureError)
}

export function useCallMediaEpoch(): number {
  return useCallSelector((s) => s.mediaEpoch)
}

/**
 * Drive a speaking-indicator element from the local analyser level WITHOUT a
 * React re-render: the effect subscribes to the store and writes the level into
 * a CSS custom property (`--speaking-level`) on the referenced node on every
 * tick. The ring's opacity/scale reads that var, so a 60fps level stream is one
 * cheap style write per frame and zero reconciliation. Only the self tile has a
 * level (the roster carries no per-peer level in v1), so only it uses this.
 */
export function useSpeakingLevelRef<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const apply = () => {
      const el = ref.current
      if (!el) return
      el.style.setProperty("--speaking-level", String(getCallState().local.speakingLevel))
    }
    apply()
    return subscribeCall(apply)
  }, [])
  return ref
}
