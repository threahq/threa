import { useState } from "react"
import { toast } from "sonner"
import { Mic, MicOff, Video, VideoOff, PhoneOff, Settings, Signal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { CallDeviceState, CallDiagnostics } from "@/stores/call-store"
import { useCallManager } from "./call-manager-context"
import { useCallCameraOn, useCallDevices, useCallDiagnostics, useCallMode, useCallMuted } from "./call-store-hooks"

// setSinkId (output device selection) is unsupported on Safari/Firefox; hide the
// speaker picker where the API is absent rather than showing a dead control.
const OUTPUT_SELECTION_SUPPORTED = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype

function deviceLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Device ${index + 1}`
}

export function DevicePickerMenu({ devices }: { devices: CallDeviceState }) {
  const manager = useCallManager()
  const hasInputs = devices.inputs.length > 0
  const hasOutputs = OUTPUT_SELECTION_SUPPORTED && devices.outputs.length > 0
  if (!hasInputs && !hasOutputs) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Devices">
          <Settings className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-w-[280px]">
        {hasInputs && (
          <>
            <DropdownMenuLabel>Microphone</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={devices.selectedInputId ?? undefined}
              onValueChange={(id) =>
                void manager.switchInputDevice(id).catch(() => toast.error("Couldn't switch microphone"))
              }
            >
              {devices.inputs.map((d, i) => (
                <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                  {deviceLabel(d, i)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {hasInputs && hasOutputs && <DropdownMenuSeparator />}
        {hasOutputs && (
          <>
            <DropdownMenuLabel>Speaker</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={devices.selectedOutputId ?? undefined}
              onValueChange={(id) =>
                void manager.setOutputDevice(id).catch(() => toast.error("Couldn't switch speaker"))
              }
            >
              {devices.outputs.map((d, i) => (
                <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                  {deviceLabel(d, i)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function formatRtt(rttMs: number | null): string {
  return rttMs == null ? "—" : `${Math.round(rttMs)} ms`
}

function formatLoss(loss: number | null): string {
  return loss == null ? "—" : `${(loss * 100).toFixed(1)}%`
}

function formatLimitation(limitation: CallDiagnostics["qualityLimitation"]): string {
  switch (limitation) {
    case "bandwidth":
      return "Limited by bandwidth"
    case "cpu":
      return "Limited by CPU"
    case "other":
      return "Limited"
    case "none":
      return "None"
    default:
      return "—"
  }
}

export function ConnectionDiagnostics({ diagnostics }: { diagnostics: CallDiagnostics }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Connection diagnostics">
          <Signal className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-56 text-sm">
        <p className="mb-2 font-medium">Connection</p>
        <dl className="space-y-1">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Round-trip</dt>
            <dd className="tabular-nums">{formatRtt(diagnostics.rttMs)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Packet loss</dt>
            <dd className="tabular-nums">{formatLoss(diagnostics.packetLoss)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Quality</dt>
            <dd>{formatLimitation(diagnostics.qualityLimitation)}</dd>
          </div>
        </dl>
      </PopoverContent>
    </Popover>
  )
}

export function CallControls() {
  const manager = useCallManager()
  const muted = useCallMuted()
  const cameraOn = useCallCameraOn()
  const mode = useCallMode()
  const devices = useCallDevices()
  const diagnostics = useCallDiagnostics()
  const [leaving, setLeaving] = useState(false)

  const toggleCamera = () => {
    void manager.setCameraOn(!cameraOn).catch(() => toast.error("Couldn't switch the camera"))
  }

  const leave = () => {
    setLeaving(true)
    void manager.leaveCall().catch(() => {
      setLeaving(false)
      toast.error("Couldn't leave the call")
    })
  }

  return (
    <div className="flex items-center justify-center gap-1.5">
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
      {mode !== "audio_only" && (
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9"
          aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
          aria-pressed={cameraOn}
          onClick={toggleCamera}
        >
          {cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </Button>
      )}
      <DevicePickerMenu devices={devices} />
      <ConnectionDiagnostics diagnostics={diagnostics} />
      <Button
        variant="destructive"
        size="icon"
        className="h-9 w-9"
        aria-label="Leave call"
        disabled={leaving}
        onClick={leave}
      >
        <PhoneOff className="h-4 w-4" />
      </Button>
    </div>
  )
}
