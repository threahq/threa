import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCallLaunch } from "./call-launch-context"
import { CALL_SURFACE_PROTECTED_ATTR } from "./call-surface-geometry"
import type { MediaPermissionErrorKind } from "@/calls/media-permissions"

// Distinct copy per permission-taxonomy class (plan §Permission UX). Each states
// what happened and the concrete next step, so the retry affordance is honest.
const PERMISSION_COPY: Record<MediaPermissionErrorKind, { title: string; body: string; retry: string }> = {
  blocked_by_policy: {
    title: "Calls are blocked here",
    body: "Your browser or organization policy is blocking camera and microphone access on this page. An administrator has to allow it.",
    retry: "Try again",
  },
  denied: {
    title: "Microphone access denied",
    body: "Allow microphone (and camera) access for this site in your browser, then try again.",
    retry: "Try again",
  },
  no_device: {
    title: "No microphone found",
    body: "We couldn't find a microphone to use. Connect one and try again.",
    retry: "Try again",
  },
  device_busy: {
    title: "Your microphone is busy",
    body: "Another app is using your microphone or camera. Close it, then try again.",
    retry: "Try again",
  },
  os_denied: {
    title: "Blocked by your system",
    body: "Your operating system is blocking microphone or camera access for this browser. Enable it in your system privacy settings, then try again.",
    retry: "Try again",
  },
  unknown: {
    title: "Couldn't access your devices",
    body: "Something went wrong getting your microphone or camera. Try again.",
    retry: "Try again",
  },
}

/** Shared desktop joining body so floating and sidebar surfaces keep one phase UI. */
export function CallJoiningBody() {
  const { state } = useCallLaunch()
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      {state.status === "idle" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connecting…
        </p>
      ) : (
        <PreJoinGate />
      )}
    </div>
  )
}

/**
 * The joining phase of the dock: a spinner while the join runs, or the
 * taxonomy-specific permission error with retry/cancel. There is no separate
 * permission probe — the taxonomy derives from the start path's own typed
 * capture failure. Rendered by the dock whenever a launch is in flight or has
 * failed pre-connection.
 */
export function PreJoinGate({ onDark = false }: { onDark?: boolean } = {}) {
  const { state, retry, takeOver, cancel } = useCallLaunch()
  // On the mobile island the gate sits on the dark call surface, so subdue text to
  // white-wash and give the ghost Cancel a dark hover — keeps joining → error one shape.
  const subtle = onDark ? "text-white/70" : "text-muted-foreground"
  const cancelClass = onDark ? "text-white hover:bg-white/10 hover:text-white" : undefined

  if (state.status === "requesting") {
    return (
      <div {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }} className="flex flex-col items-center gap-3 py-6 text-center">
        <Loader2 className={cn("h-6 w-6 animate-spin", subtle)} aria-hidden />
        <p className={cn("text-sm", subtle)}>Joining…</p>
        <Button variant="ghost" size="sm" className={cancelClass} onClick={cancel}>
          Cancel
        </Button>
      </div>
    )
  }

  if (state.status === "join_error") {
    return (
      <div {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }} className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm font-medium">Couldn't start the call</p>
        <p className={cn("text-xs", subtle)}>The call service didn't respond. Try again in a moment.</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className={cancelClass} onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  // The user's own other device (or tab) is already in this call. A choice, not a
  // failure — so no "Try again", and the primary action says where the call ends up.
  if (state.status === "takeover_prompt") {
    return (
      <div {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }} className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm font-medium">You&rsquo;re in this call on another device</p>
        <p className={cn("text-xs", subtle)}>Joining here will move the call to this device.</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className={cancelClass} onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={takeOver}>
            Join on this device
          </Button>
        </div>
      </div>
    )
  }

  if (state.status === "permission_error") {
    const copy = PERMISSION_COPY[state.error.kind]
    return (
      <div
        {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }}
        className="flex flex-col items-center gap-3 py-6 text-center"
        data-error-kind={state.error.kind}
      >
        <p className="text-sm font-medium">{copy.title}</p>
        <p className={cn("text-xs", subtle)}>{copy.body}</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className={cancelClass} onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={retry}>
            {copy.retry}
          </Button>
        </div>
      </div>
    )
  }

  return null
}
