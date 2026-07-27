import { PhoneForwarded, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { setDisplacedCall } from "@/stores/call-store"
import { useCallLaunch } from "./call-launch-context"
import { useDisplacedCall } from "./call-store-hooks"

/**
 * Shown after another of this user's devices took the call over ("Join on this
 * device" there). The server closed this endpoint, so the dock has already torn
 * down — without this the call surface would simply vanish mid-conversation.
 *
 * A chip with actions rather than a toast (INV-63): it needs a decision, and a
 * toast would expire before a user who was looking at their other device sees it.
 * Rejoin runs the ordinary launch, so if the other device is still holding the
 * call the takeover prompt confirms moving it back.
 */
export function CallMovedChip() {
  const displaced = useDisplacedCall()
  const { launch } = useCallLaunch()
  if (!displaced) return null
  return (
    <div className="flex items-center gap-1.5 rounded-full border bg-background py-1.5 pl-3 pr-1.5 text-xs shadow-lg">
      <PhoneForwarded className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">Call moved to another device</span>
      <Button
        size="sm"
        variant="secondary"
        className="h-6 px-2 text-[11px]"
        onClick={() =>
          launch({
            workspaceId: displaced.workspaceId,
            streamId: displaced.streamId,
            mode: displaced.mode,
            expectedCallId: displaced.callId,
          })
        }
      >
        Rejoin here
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6"
        aria-label="Dismiss"
        onClick={() => setDisplacedCall(null)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
