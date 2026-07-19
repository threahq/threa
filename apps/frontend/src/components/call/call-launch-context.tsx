import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { CallMode } from "@/calls/config"
import { CallCaptureError, CallStartCancelledError } from "@/calls/call-manager"
import { useCallManager } from "./call-manager-context"
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
  launch: (request: CallLaunchRequest) => void
  retry: () => void
  cancel: () => void
}

const CallLaunchContext = createContext<CallLaunchContextValue | null>(null)

export function CallLaunchProvider({ children }: { children: ReactNode }) {
  const manager = useCallManager()
  const [state, setState] = useState<CallLaunchState>({ status: "idle" })
  // Guards against a stale async settling over a newer launch/cancel.
  const runIdRef = useRef(0)

  const run = useCallback(
    async (request: CallLaunchRequest) => {
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

  const value = useMemo<CallLaunchContextValue>(
    () => ({ state, launch, retry, cancel }),
    [state, launch, retry, cancel]
  )

  return <CallLaunchContext.Provider value={value}>{children}</CallLaunchContext.Provider>
}

export function useCallLaunch(): CallLaunchContextValue {
  const ctx = useContext(CallLaunchContext)
  if (!ctx) throw new Error("useCallLaunch must be used within a CallLaunchProvider")
  return ctx
}
