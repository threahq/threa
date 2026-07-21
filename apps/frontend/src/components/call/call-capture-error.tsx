import { cn } from "@/lib/utils"
import type { CallCaptureErrorInfo } from "@/stores/call-store"

export function captureErrorText(code: CallCaptureErrorInfo["code"]): string {
  return code === "capture_rollback_failed"
    ? "Your microphone stopped working and couldn't be restored. Try leaving and rejoining."
    : "Couldn't switch your microphone or camera. Your previous device is still active."
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
      {captureErrorText(error.code)}
    </p>
  )
}
