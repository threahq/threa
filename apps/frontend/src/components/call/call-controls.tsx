import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Check, Copy, Settings, Signal } from "lucide-react"
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
import { useCallLifecycleEvents, type CallLifecycleEntry } from "@/calls/lifecycle-log"

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

/** Device-local wall clock with milliseconds — a lifecycle log is read by ordering. */
function formatLifecycleTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function lifecycleLogText(entries: CallLifecycleEntry[]): string {
  return entries.map((e) => [formatLifecycleTime(e.at), e.kind, e.detail].filter(Boolean).join(" ")).join("\n")
}

/**
 * Page-lifecycle / socket / lease trace for the current and previous calls. It
 * survives teardown by design — a call that already died is exactly what it has
 * to explain.
 */
function LifecycleLogSection() {
  const events = useCallLifecycleEvents()
  const [copied, setCopied] = useState(false)
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (resetRef.current && clearTimeout(resetRef.current)), [])

  const newestFirst = [...events].reverse()
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(lifecycleLogText(newestFirst))
    } catch {
      return
    }
    setCopied(true)
    if (resetRef.current) clearTimeout(resetRef.current)
    resetRef.current = setTimeout(() => setCopied(false), 1200)
  }, [newestFirst])

  return (
    <div className="mt-3 border-t pt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="font-medium">Lifecycle</p>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={copied ? "Copied" : "Copy lifecycle log"}
          disabled={newestFirst.length === 0}
          onClick={() => void copy()}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {newestFirst.length === 0 ? (
        <p className="text-muted-foreground text-xs">No events yet</p>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
          {newestFirst.map((e, i) => (
            <li key={`${e.at}:${e.kind}:${i}`} className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0 tabular-nums">{formatLifecycleTime(e.at)}</span>
              <span className="min-w-0 truncate">{e.detail ? `${e.kind} ${e.detail}` : e.kind}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
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
        <LifecycleLogSection />
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
