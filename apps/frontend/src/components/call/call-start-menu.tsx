import { ChevronDown, Phone, PhoneForwarded, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useActiveCallsForStream } from "@/stores/active-calls-store"
import { useCallLaunch } from "./call-launch-context"
import { useCallOnAnotherDevice } from "./use-call-on-another-device"

/** The room the start trigger takes in a header, and the wider "Take over" that replaces it. */
const CALL_START_WIDTH = 48
const CALL_TAKE_OVER_WIDTH = 92

/**
 * What a stream offers for starting a call here: `takeOver` when its live call
 * has the viewer on another device, else `start`. Each launches synchronously,
 * so calling one from a click keeps the user gesture.
 */
export function useCallStart(workspaceId: string, streamId: string, expectedCallId?: string) {
  const { launch, callActive } = useCallLaunch()
  // Store-only (no fetch): this menu renders on channels and DMs, which are their
  // own root, so the stream's live call is the entry filed under it.
  const liveHere = useActiveCallsForStream(workspaceId, streamId).find((call) => call.streamId === streamId)
  const liveCallId = expectedCallId ?? liveHere?.callId
  const onAnotherDevice = useCallOnAnotherDevice(workspaceId, liveCallId)
  return {
    callActive,
    width: onAnotherDevice ? CALL_TAKE_OVER_WIDTH : CALL_START_WIDTH,
    start: (cameraOn: boolean) => launch({ workspaceId, streamId, mode: "video", expectedCallId, cameraOn }),
    takeOver: onAnotherDevice
      ? () => launch({ workspaceId, streamId, mode: "video", expectedCallId: liveCallId, takeover: true })
      : null,
  }
}

/**
 * The call-start affordance: a small menu offering "Start voice call" (mic only,
 * opens to the compact bar) and "Start video call" (camera publishing at join, opens
 * to the gallery). The voice/video decision is explicit — like the "Copy as markdown"
 * menu — rather than a hidden default. The launch runs inside the item click's user
 * gesture so iOS honors the AudioContext (INV via CallLaunch). Disabled (and the
 * menu unopenable) while a call is already active.
 *
 * When this stream's live call already has the viewer on ANOTHER device, the menu
 * collapses to a single "Take over" button: the voice/video choice belongs to the
 * call that is already running, and the only thing left to decide is which device
 * carries it. The camera is still a tap away once the call lands here.
 */
export function CallStartMenu({
  workspaceId,
  streamId,
  expectedCallId,
  startLabel = "Start call",
  className,
}: {
  workspaceId: string
  streamId: string
  expectedCallId?: string
  startLabel?: string
  className?: string
}) {
  const { callActive, start, takeOver } = useCallStart(workspaceId, streamId, expectedCallId)

  if (takeOver) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className={cn("h-8 gap-1 px-2", className)}
        disabled={callActive}
        title={callActive ? "You're already in a call" : "Move this call to this device"}
        aria-label="Take over call on this device"
        onClick={takeOver}
      >
        <PhoneForwarded className="h-4 w-4" />
        <span className="text-xs">Take over</span>
      </Button>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-8 gap-1 px-2", className)}
          disabled={callActive}
          title={callActive ? "You're already in a call" : startLabel}
          aria-label={callActive ? "You're already in a call" : startLabel}
        >
          <Phone className="h-4 w-4" />
          {/* Caret so the icon reads as a menu (start-call vs start-with-camera), not a one-tap button. */}
          <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => start(false)}>
          <Phone className="mr-2 h-4 w-4" />
          Start voice call
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => start(true)}>
          <Video className="mr-2 h-4 w-4" />
          Start video call
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
