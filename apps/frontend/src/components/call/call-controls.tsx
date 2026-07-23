import { toast } from "sonner"
import { Settings, Signal } from "lucide-react"
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
import { setCallSelfMirror, useCallPrefs, type CallSelfMirror } from "@/stores/call-prefs-store"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/use-mobile"
import type { CallDeviceState, CallDiagnostics } from "@/stores/call-store"
import { CALL_SURFACE_PROTECTED_ATTR } from "./call-surface-geometry"
import { useCallManager } from "./call-manager-context"
import { CameraButton, ChatButton, FlipButton, LeaveButton, MuteButton } from "./call-control-buttons"
import { useCallDevices, useCallDiagnostics } from "./call-store-hooks"

// setSinkId (output device selection) is unsupported on Safari/Firefox; hide the
// speaker picker where the API is absent rather than showing a dead control.
const OUTPUT_SELECTION_SUPPORTED = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype

function deviceLabel(device: MediaDeviceInfo, index: number, fallbackPrefix = "Device"): string {
  return device.label || `${fallbackPrefix} ${index + 1}`
}

export function DevicePickerMenu({ devices }: { devices: CallDeviceState }) {
  const manager = useCallManager()
  const isMobile = useIsMobile()
  const { selfMirror } = useCallPrefs()
  // Mobile hides per-camera selection: phones enumerate several back cameras
  // (wide/ultrawide/tele) and picking a specific one by exact deviceId can reject
  // the capture (freezes the feed, then errors). Front/back is the Flip button.
  const hasCameras = !isMobile && devices.cameras.length > 0
  // The mirror control shows on any surface with a camera (front/back on mobile too).
  const hasVideo = devices.cameras.length > 0
  const hasInputs = devices.inputs.length > 0
  const hasOutputs = OUTPUT_SELECTION_SUPPORTED && devices.outputs.length > 0
  if (!hasVideo && !hasInputs && !hasOutputs) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Devices">
          <Settings className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-w-[280px]">
        {hasVideo && (
          <>
            {/* Tri-state (matches the Calls settings tab): a boolean toggle would
                silently drop `auto`, and disagree with the settings radio on a back camera. */}
            <DropdownMenuLabel>Mirror my video</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selfMirror}
              onValueChange={(value) => setCallSelfMirror(value as CallSelfMirror)}
            >
              <DropdownMenuRadioItem value="auto">Automatic</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="on">On</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            {(hasCameras || hasInputs || hasOutputs) && <DropdownMenuSeparator />}
          </>
        )}
        {hasCameras && (
          <>
            <DropdownMenuLabel>Camera</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={devices.selectedCameraId ?? undefined}
              onValueChange={(id) =>
                void manager.switchCameraDevice(id).catch(() => toast.error("Couldn't switch camera"))
              }
            >
              {devices.cameras.map((d, i) => (
                <DropdownMenuRadioItem key={d.deviceId} value={d.deviceId} className="truncate">
                  {deviceLabel(d, i, "Camera")}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {hasCameras && (hasInputs || hasOutputs) && <DropdownMenuSeparator />}
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
  const devices = useCallDevices()
  const diagnostics = useCallDiagnostics()

  // Mute/Camera/Flip/Leave are the shared, async-aware controls (call-control-buttons):
  // Camera hides itself on audio_only, Flip on desktop / single-camera — so the row
  // gates itself without CallControls re-deciding.
  return (
    <div {...{ [CALL_SURFACE_PROTECTED_ATTR]: "" }} className="flex items-center justify-center gap-1.5">
      <MuteButton />
      <CameraButton />
      <FlipButton />
      <DevicePickerMenu devices={devices} />
      <ConnectionDiagnostics diagnostics={diagnostics} />
      <ChatButton />
      <LeaveButton />
    </div>
  )
}
