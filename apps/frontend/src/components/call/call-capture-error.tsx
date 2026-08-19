import { cn } from "@/lib/utils"
import type { CallCaptureErrorInfo } from "@/stores/call-store"

/**
 * A failed rollback trumps the taxonomy: whatever caused it, outbound audio is
 * dead and rejoining is the only recovery. Everything else keys on the
 * permission-taxonomy class so a no-prompt denial ("nothing happened") tells
 * the user where the block actually lives.
 */
export function captureErrorText(error: Pick<CallCaptureErrorInfo, "code" | "kind">): string {
  if (error.code === "capture_rollback_failed") {
    return "Your microphone stopped working and couldn't be restored. Try leaving and rejoining."
  }
  switch (error.kind) {
    case "denied":
      return "Camera or microphone access is blocked. Allow it in your browser's site settings, then try again."
    case "os_denied":
      return "Your operating system is blocking camera or microphone access for this browser."
    case "blocked_by_policy":
      return "Camera and microphone access is blocked here by policy."
    case "device_busy":
      return "Another app or tab is using the camera or microphone. Close it, then try again."
    case "no_device":
      return "No matching camera or microphone was found."
    default:
      return "Couldn't switch your microphone or camera. Your previous device is still active."
  }
}

/**
 * In-surface banner for a mid-call capture failure. Shared by the mobile drawer
 * and the desktop dock (INV-35); the caller supplies surface-specific margins via
 * `className`.
 */
export function CaptureErrorBanner({ error, className }: { error: CallCaptureErrorInfo; className?: string }) {
  return (
    <p
      className={cn("rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive", className)}
      role="alert"
      data-testid="call-capture-error"
    >
      {captureErrorText(error)}
    </p>
  )
}
