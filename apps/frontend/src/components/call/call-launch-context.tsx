import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { CallMode } from "@/calls/config"
import { CallCaptureError, CallStartCancelledError } from "@/calls/call-manager"
import { getCallState } from "@/stores/call-store"
import { useCallManager } from "./call-manager-context"
import { useCallPhase } from "./call-store-hooks"
import { classifyMediaError, type MediaPermissionError } from "./media-permissions"

export interface CallLaunchRequest {
  workspaceId: string
  streamId: string
  mode: CallMode
}

/**
 * The pre-join flow state. `requesting` spans the whole join (the dock shows a
 * joining spinner across it); `permission_error` carries the taxonomy class so the
 * gate renders its distinct copy + retry; `join_error` is a non-media failure
 * (REST/socket) with a plain retry.
 */
export type CallLaunchState =
  | { status: "idle" }
  | { status: "requesting"; request: CallLaunchRequest }
  | { status: "permission_error"; request: CallLaunchRequest; error: MediaPermissionError }
  | { status: "join_error"; request: CallLaunchRequest; message: string }

interface CallLaunchContextValue {
  state: CallLaunchState
  /** True while a call is active/connecting or a launch is in flight — entry points gate on it. */
  callActive: boolean
  launch: (request: CallLaunchRequest) => void
  retry: () => void
  cancel: () => void
}

const CallLaunchContext = createContext<CallLaunchContextValue | null>(null)

export function CallLaunchProvider({ children }: { children: ReactNode }) {
  const manager = useCallManager()
  const phase = useCallPhase()
  const [state, setState] = useState<CallLaunchState>({ status: "idle" })
  // Guards against a stale async settling over a newer launch/cancel.
  const runIdRef = useRef(0)

  const run = useCallback(
    async (request: CallLaunchRequest) => {
      // Already in (or joining) a call: startCall would synchronously reject with
      // a plain Error, which the catch below would surface as a stale join_error
      // carrying the wrong request (and a "Try again" that starts an unintended
      // call). Ignore the launch — entry points also gate their affordance.
      if (getCallState().phase !== "idle") return
      const runId = ++runIdRef.current
      setState({ status: "requesting", request })
      // startCall is the single media acquisition and must run synchronously in the
      // click's transient activation — it creates+resumes the AudioContext before
      // its first await so iOS Safari honors it. Probing media first (a prior await)
      // would exhaust the gesture and leave the analyser's context suspended, so the
      // permission taxonomy is derived from startCall's own typed capture failure
      // instead of a separate pre-flight getUserMedia.
      try {
        await manager.startCall(request)
        if (runId !== runIdRef.current) return
        setState({ status: "idle" })
      } catch (err) {
        if (runId !== runIdRef.current) return
        // A cancel during joining rolls the manager back cleanly — not an error surface.
        if (err instanceof CallStartCancelledError) {
          setState({ status: "idle" })
          return
        }
        if (err instanceof CallCaptureError) {
          const error = classifyMediaError((err as { cause?: unknown }).cause ?? err)
          setState({ status: "permission_error", request, error })
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setState({ status: "join_error", request, message })
        toast.error("Couldn't start the call")
      }
    },
    [manager]
  )

  const launch = useCallback((request: CallLaunchRequest) => void run(request), [run])

  const retry = useCallback(() => {
    if (state.status === "permission_error" || state.status === "join_error") void run(state.request)
  }, [run, state])

  const cancel = useCallback(() => {
    runIdRef.current++
    setState({ status: "idle" })
    void manager.leaveCall()
  }, [manager])

  // A launch error only makes sense while idle. Once a call is actually active
  // (or connecting), any residual join_error/permission_error is stale — clear it
  // so no unprompted "Try again" survives to a normal call exit.
  useEffect(() => {
    if (phase !== "idle" && (state.status === "join_error" || state.status === "permission_error")) {
      setState({ status: "idle" })
    }
  }, [phase, state.status])

  const callActive = phase !== "idle" || state.status === "requesting"

  const value = useMemo<CallLaunchContextValue>(
    () => ({ state, callActive, launch, retry, cancel }),
    [state, callActive, launch, retry, cancel]
  )

  return <CallLaunchContext.Provider value={value}>{children}</CallLaunchContext.Provider>
}

export function useCallLaunch(): CallLaunchContextValue {
  const ctx = useContext(CallLaunchContext)
  if (!ctx) throw new Error("useCallLaunch must be used within a CallLaunchProvider")
  return ctx
}
