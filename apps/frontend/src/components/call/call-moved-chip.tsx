import { PhoneForwarded, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { setDisplacedCall, type DisplacedCallReason } from "@/stores/call-store"
import { useCallLaunch } from "./call-launch-context"
import { useDisplacedCall } from "./call-store-hooks"

/**
 * Shown after the call left this device without the user ending it: another
 * device took it over ("Join on this device" there), or the lease lapsed while
 * this page was frozen. The dock has already torn down — without this the call
 * surface would simply vanish mid-conversation.
 *
 * A chip with actions rather than a toast (INV-63): it needs a decision, and a
 * toast would expire before a user who was looking at their other device sees it.
 * This chip exists BECAUSE the other device holds the call, so its action asks
 * for takeover directly — routing through a plain join would 409 and re-ask a
 * question the chip already answered. Harmless if that device has since left:
 * with no live endpoint, takeover mints a fresh one.
 *
 * The pill caps at the viewport so a phone truncates the message instead of
 * pushing the actions off the left edge (it is `fixed right-4` with no left
 * anchor, and this branch of the dock is shared with mobile).
 */
const DISPLACED_TEXT: Record<DisplacedCallReason, string> = {
  taken_over: "Call moved to another device",
  ended_while_away: "Call ended while your phone was locked",
  connection_lost: "Call ended — this device lost its connection",
}

export function CallMovedChip() {
  const displaced = useDisplacedCall()
  const { launch } = useCallLaunch()
  if (!displaced) return null
  return (
    <div className="flex max-w-[calc(100vw-2rem)] items-center gap-1.5 rounded-full border bg-background py-1.5 pl-3 pr-1.5 text-xs shadow-lg">
      <PhoneForwarded className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate text-muted-foreground">{DISPLACED_TEXT[displaced.reason]}</span>
      <Button
        size="sm"
        variant="secondary"
        className="h-8 shrink-0 px-2 text-[11px]"
        onClick={() =>
          launch({
            workspaceId: displaced.workspaceId,
            streamId: displaced.streamId,
            mode: displaced.mode,
            expectedCallId: displaced.callId,
            takeover: true,
          })
        }
      >
        Rejoin here
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0"
        aria-label="Dismiss"
        onClick={() => setDisplacedCall(null)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
