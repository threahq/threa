import { useState } from "react"
import { toast } from "sonner"
import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useCallManager } from "./call-manager-context"
import { useCallCameraOn, useCallMode, useCallMuted } from "./call-store-hooks"

// The mute / camera / leave triple, one component each so the compact bar and the
// (later) desktop pill share one implementation instead of re-inlining the manager
// wiring + INV-63 error toasts (success stays silent). Icon-only, 9x9 like CallControls.

export function MuteButton() {
  const manager = useCallManager()
  const muted = useCallMuted()
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", muted && "text-destructive")}
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      onClick={() => manager.setMuted(!muted)}
    >
      {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
    </Button>
  )
}

export function CameraButton() {
  const manager = useCallManager()
  const cameraOn = useCallCameraOn()
  const mode = useCallMode()
  if (mode === "audio_only") return null
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9"
      aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
      aria-pressed={cameraOn}
      onClick={() => void manager.setCameraOn(!cameraOn).catch(() => toast.error("Couldn't switch the camera"))}
    >
      {cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
    </Button>
  )
}

export function LeaveButton() {
  const manager = useCallManager()
  const [leaving, setLeaving] = useState(false)
  return (
    <Button
      variant="destructive"
      size="icon"
      className="h-9 w-9"
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
