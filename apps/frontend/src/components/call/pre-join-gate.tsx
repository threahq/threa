import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCallLaunch } from "./call-launch-context"
import type { MediaPermissionErrorKind } from "./media-permissions"

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

/**
 * The joining phase of the dock: a spinner while the permission probe + join run,
 * or the taxonomy-specific permission error with retry/cancel. Rendered by the
 * dock whenever a launch is in flight or has failed pre-connection.
 */
export function PreJoinGate() {
  const { state, retry, cancel } = useCallLaunch()

  if (state.status === "requesting") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">Joining…</p>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    )
  }

  if (state.status === "join_error") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p className="text-sm font-medium">Couldn't start the call</p>
        <p className="text-xs text-muted-foreground">The call service didn't respond. Try again in a moment.</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (state.status === "permission_error") {
    const copy = PERMISSION_COPY[state.error.kind]
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" data-error-kind={state.error.kind}>
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="text-xs text-muted-foreground">{copy.body}</p>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
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
