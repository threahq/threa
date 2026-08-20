import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { ApiError } from "@/api/client"
import type { CallMode } from "@/calls/config"
import { CallCaptureError, CallStartCancelledError } from "@/calls/call-manager"
import { getCallState } from "@/stores/call-store"
import { useCallManager } from "./call-manager-context"
import { useCallPhase } from "./call-store-hooks"
import { classifyMediaError, type MediaPermissionError } from "@/calls/media-permissions"

export interface CallLaunchRequest {
  workspaceId: string
  streamId: string
  mode: CallMode
  /**
   * Binds accept/rejoin/Join to the call the surface is showing: the server 409s
   * `CALL_ENDED` if the stream's live call has since changed (INV-64-adjacent
   * ring-to-call binding). A fresh start-or-join (header/profile) omits it.
   */
  expectedCallId?: string
  /** Join with the camera already publishing (the "Start with camera" choice). */
  cameraOn?: boolean
  /**
   * Displace this user's live endpoint on another device instead of being
   * rejected by it (409 `CALL_ENDPOINT_ACTIVE`). Set by an entry point that
   * already knows the call is on another device — see `useCallOnAnotherDevice` —
   * or by answering the takeover prompt. Never set on a plain first join.
   */
  takeover?: boolean
}

/**
 * The pre-join flow state. `requesting` spans the whole join (the dock shows a
 * joining spinner across it); `permission_error` carries the taxonomy class so the
 * gate renders its distinct copy + retry; `join_error` is a non-media failure
 * (REST/socket) with a plain retry; `takeover_prompt` is the user's own other
 * device already holding this call, which is a choice, not a failure.
 */
export type CallLaunchState =
  | { status: "idle" }
  | { status: "requesting"; request: CallLaunchRequest }
  | { status: "permission_error"; request: CallLaunchRequest; error: MediaPermissionError }
  | { status: "join_error"; request: CallLaunchRequest; message: string }
  | { status: "takeover_prompt"; request: CallLaunchRequest }

interface CallLaunchContextValue {
  state: CallLaunchState
  /** True while a call is active/connecting or a launch is in flight — entry points gate on it. */
  callActive: boolean
  launch: (request: CallLaunchRequest) => void
  retry: () => void
  /** Answer a `takeover_prompt`: rerun the same launch, displacing the other device. */
  takeOver: () => void
  cancel: () => void
}

const CallLaunchContext = createContext<CallLaunchContextValue | null>(null)

export function CallLaunchProvider({ children }: { children: ReactNode }) {
  const manager = useCallManager()
  const phase = useCallPhase()
  const [state, setState] = useState<CallLaunchState>({ status: "idle" })
  // Guards against a stale async settling over a newer launch/cancel.
  const runIdRef = useRef(0)
  // Synchronous re-entrancy guard. `phase` alone is not enough: it flips off
  // "idle" only after the REST start resolves, so a second launch inside that
  // window (a StrictMode double effect on the `?call=` path, a double-tap racing
  // the re-render) would pass the phase check and hit startCall's synchronous
  // "already active" throw — surfacing a false join_error over a live join.
  const inFlightRef = useRef(false)

  const run = useCallback(
    async (request: CallLaunchRequest) => {
      // Already in (or joining) a call: startCall would synchronously reject with
      // a plain Error, which the catch below would surface as a stale join_error
      // carrying the wrong request (and a "Try again" that starts an unintended
      // call). Ignore the launch — entry points also gate their affordance.
      if (inFlightRef.current || getCallState().phase !== "idle") return
      const runId = ++runIdRef.current
      inFlightRef.current = true
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
        // The user is already in this call on another device (or another tab —
        // the REST start runs before the Web Lock check, so both land here). Not a
        // failure: offer to move the call to this device rather than toasting.
        if (ApiError.isApiError(err) && err.code === "CALL_ENDPOINT_ACTIVE") {
          setState({ status: "takeover_prompt", request })
          return
        }
        // The bound call is gone (expectedCallId guard). A retry would join
        // whatever call now lives in the stream — not what the user accepted, so
        // no join_error retry surface; just say what happened.
        if (ApiError.isApiError(err) && err.code === "CALL_ENDED") {
          setState({ status: "idle" })
          toast.info("This call has ended")
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setState({ status: "join_error", request, message })
        toast.error("Couldn't start the call")
      } finally {
        inFlightRef.current = false
      }
    },
    [manager]
  )

  const launch = useCallback((request: CallLaunchRequest) => void run(request), [run])

  const retry = useCallback(() => {
    if (state.status === "permission_error" || state.status === "join_error") void run(state.request)
  }, [run, state])

  // `retry` replays the request untouched, so takeover is only ever added by an
  // entry point that already knew (`request.takeover`) or by answering this
  // prompt — no error path can displace another device unasked.
  const takeOver = useCallback(() => {
    if (state.status === "takeover_prompt") void run({ ...state.request, takeover: true })
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
    if (
      phase !== "idle" &&
      (state.status === "join_error" || state.status === "permission_error" || state.status === "takeover_prompt")
    ) {
      setState({ status: "idle" })
    }
  }, [phase, state.status])

  const callActive = phase !== "idle" || state.status === "requesting"

  const value = useMemo<CallLaunchContextValue>(
    () => ({ state, callActive, launch, retry, takeOver, cancel }),
    [state, callActive, launch, retry, takeOver, cancel]
  )

  return <CallLaunchContext.Provider value={value}>{children}</CallLaunchContext.Provider>
}

export function useCallLaunch(): CallLaunchContextValue {
  const ctx = useContext(CallLaunchContext)
  if (!ctx) throw new Error("useCallLaunch must be used within a CallLaunchProvider")
  return ctx
}
