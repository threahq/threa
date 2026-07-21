import { useState } from "react"
import { toast } from "sonner"
import { Mic, MicOff, PhoneOff, SwitchCamera, Video, VideoOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { useCallManager } from "./call-manager-context"
import { useCallCameraOn, useCallDevices, useCallMode, useCallMuted } from "./call-store-hooks"

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

export function CameraButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const cameraOn = useCallCameraOn()
  const mode = useCallMode()
  if (mode === "audio_only") return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
      aria-pressed={cameraOn}
      onClick={() => void manager.setCameraOn(!cameraOn).catch(() => toast.error("Couldn't switch the camera"))}
    >
      {cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
    </Button>
  )
}

/** Front/back flip — mobile only, and only when there's more than one camera. */
export function FlipButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const mode = useCallMode()
  const devices = useCallDevices()
  const isMobile = useIsMobile()
  if (mode === "audio_only" || !isMobile || devices.cameras.length <= 1) return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label="Flip camera"
      onClick={() => void manager.flipCamera().catch(() => toast.error("Couldn't flip the camera"))}
    >
      <SwitchCamera className="h-4 w-4" />
    </Button>
  )
}

export function LeaveButton({ className }: { className?: string }) {
  const manager = useCallManager()
  const [leaving, setLeaving] = useState(false)
  return (
    <Button
      variant="destructive"
      size="icon"
      className={cn("h-9 w-9", className)}
      aria-label="Leave call"
      disabled={leaving}
      onClick={() => {
        setLeaving(true)
        void manager.leaveCall().catch(() => {
          setLeaving(false)
          toast.error("Couldn't leave the call")
        })
      }}
    >
      <PhoneOff className="h-4 w-4" />
    </Button>
  )
}
