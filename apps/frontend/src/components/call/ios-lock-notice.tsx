import { cn } from "@/lib/utils"
import { isIosWebKit } from "@/lib/platform"

/**
 * iOS suspends a backgrounded page, which ends the call — say so before it
 * happens rather than landing the user on a call that vanished. Static from
 * mount and never dismissable, so it costs no layout shift (INV-21).
 */
export function IosLockNotice({ className }: { className?: string }) {
  if (!isIosWebKit()) return null
  return (
    <p
      className={cn("rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground", className)}
      data-testid="call-ios-lock-notice"
    >
      Locking your phone ends this call.
    </p>
  )
}
