import { Link } from "react-router-dom"
import { Loader2, MessageSquare, Mic, MicOff, PhoneOff, SwitchCamera, Video, VideoOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createDraftPanelId } from "@/contexts"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useAsyncAction } from "@/hooks/use-async-action"
import { useCallManager } from "./call-manager-context"
import {
  useCallCameraOn,
  useCallChatAnchor,
  useCallDevices,
  useCallMode,
  useCallMuted,
  useCallStreamId,
  useCallWorkspaceId,
} from "./call-store-hooks"

// The mute / camera / flip / leave controls, one component each so the compact
// island and the (later) desktop pill share one implementation instead of
// re-inlining the manager wiring + INV-63 error toasts (success stays silent).
// Icon-only, 9x9 like CallControls. `className` lets a dark surface (the island)
// override the ghost hover without each caller re-wiring the manager.

export function MuteButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const muted = useCallMuted()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", muted && "text-destructive", className)}
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      onClick={() => manager.setMuted(!muted)}
    >
      {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
    </Button>
  )
}

// Async camera controls disable themselves + swap to an in-place spinner while their
// OWN recapture runs (via useAsyncAction), so a slow toggle can't register a second
// state-reversing tap — and a sibling control (flip, a device menu item) is untouched.

export function CameraButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const cameraOn = useCallCameraOn()
  const mode = useCallMode()
  const { pending, run } = useAsyncAction(() => manager.setCameraOn(!cameraOn), {
    errorMessage: "Couldn't switch the camera",
  })
  if (mode === "audio_only") return null
  let icon = <VideoOff className="h-4 w-4" />
  let label = "Turn camera on"
  if (pending) {
    icon = <Loader2 className="h-4 w-4 animate-spin" />
    label = "Switching camera…"
  } else if (cameraOn) {
    icon = <Video className="h-4 w-4" />
    label = "Turn camera off"
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label={label}
      aria-pressed={cameraOn}
      aria-busy={pending}
      disabled={pending}
      onClick={run}
    >
      {icon}
    </Button>
  )
}

/** Front/back flip — mobile only, and only when there's more than one camera. */
export function FlipButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const mode = useCallMode()
  const devices = useCallDevices()
  const isMobile = useIsMobile()
  const { pending, run } = useAsyncAction(() => manager.flipCamera(), { errorMessage: "Couldn't flip the camera" })
  if (mode === "audio_only" || !isMobile || devices.cameras.length <= 1) return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label={pending ? "Flipping camera…" : "Flip camera"}
      aria-busy={pending}
      disabled={pending}
      onClick={run}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SwitchCamera className="h-4 w-4" />}
    </Button>
  )
}

/**
 * Opens the call's chat thread — a thread anchored on the `call_started` event
 * (`chatAnchorId` from the start/join response). Opening the draft panel resolves
 * to the real thread once one exists (chunk-3 auto-redirect) and otherwise starts
 * one on first send, so a single target covers both. Navigation, so a <Link>
 * (INV-40); hidden until the anchor is known.
 *
 * The dock mounts ABOVE `PanelProvider` (it survives navigation and takes no URL
 * state), so it can't call `getPanelUrl`. It builds the absolute host-stream URL
 * with the `panel` query itself — navigating to the call's stream and opening the
 * thread panel there in one hop, which also lands the user on the right page.
 */
export function ChatButton({ className }: { className?: string }) {
  const workspaceId = useCallWorkspaceId()
  const streamId = useCallStreamId()
  const chatAnchorId = useCallChatAnchor()
  if (!workspaceId || !streamId || !chatAnchorId) return null
  const search = new URLSearchParams({ panel: createDraftPanelId(streamId, chatAnchorId) }).toString()
  return (
    <Button asChild variant="ghost" size="icon" className={cn("h-9 w-9", className)}>
      <Link
        to={{ pathname: `/w/${workspaceId}/s/${streamId}`, search }}
        aria-label="Open call chat"
        title="Open call chat"
      >
        <MessageSquare className="h-4 w-4" />
      </Link>
    </Button>
  )
}

export function LeaveButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const { pending, run } = useAsyncAction(() => manager.leaveCall(), { errorMessage: "Couldn't leave the call" })
  return (
    <Button
      variant="destructive"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label="Leave call"
      aria-busy={pending}
      disabled={pending}
      onClick={run}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />}
    </Button>
  )
}
