import { ChevronDown, Phone, Video } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useCallLaunch } from "./call-launch-context"

/**
 * The call-start affordance: a small menu offering "Start call" (mic only, opens
 * to the compact bar) and "Start with camera" (camera publishing at join, opens to
 * the gallery). The camera decision is explicit — like the "Copy as markdown" menu
 * — rather than a hidden default. The launch runs inside the item click's user
 * gesture so iOS honors the AudioContext (INV via CallLaunch). Disabled (and the
 * menu unopenable) while a call is already active.
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
  const { launch, callActive } = useCallLaunch()
  const start = (cameraOn: boolean) => launch({ workspaceId, streamId, mode: "video", expectedCallId, cameraOn })
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
          {startLabel}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => start(true)}>
          <Video className="mr-2 h-4 w-4" />
          Start with camera
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
