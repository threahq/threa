import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { AlertTriangle, ChevronDown, ChevronUp, Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidePanel, SidePanelHeader, SidePanelTitle } from "@/components/ui/side-panel"
import { useIsMobile } from "@/hooks/use-mobile"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { cn } from "@/lib/utils"
import { useCallManager } from "./call-manager-context"
import { useCallLaunch } from "./call-launch-context"
import {
  useCallActiveElsewhere,
  useCallCameraOn,
  useCallCaptureError,
  useCallMode,
  useCallMuted,
  useCallPhase,
  useCallRoster,
  useCallStreamId,
  useCallWorkspaceId,
} from "./call-store-hooks"

// Bottom-anchored call surfaces clear the iOS home indicator on desktop (app
// convention — see message-composer.tsx) and, on a phone, sit a composer-height
// above the bottom (`--composer-height`, published on :root) so the dock never
// covers the floating composer.
const DOCK_BOTTOM =
  "bottom-[calc(var(--composer-height,5rem)_+_1rem)] sm:bottom-[max(1rem,env(safe-area-inset-bottom))]"
import { CallTile } from "./call-tile"
import { CallControls } from "./call-controls"
import { PreJoinGate } from "./pre-join-gate"
import { ActiveElsewhereChip } from "./active-elsewhere-chip"

function DockFrame({ children }: { children: ReactNode }) {
  return (
    <div className={cn("fixed right-4 z-50 w-[340px] max-w-[calc(100vw-2rem)]", DOCK_BOTTOM)}>
      <SidePanel className="rounded-lg border shadow-xl sm:border">{children}</SidePanel>
    </div>
  )
}

function DockHeader({ title, collapsed, onToggle }: { title: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <SidePanelHeader className="rounded-t-lg">
      <SidePanelTitle className="text-sm">{title}</SidePanelTitle>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        aria-label={collapsed ? "Expand call" : "Collapse call"}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </Button>
    </SidePanelHeader>
  )
}

/**
 * The docked call surface. Mounts at the app-layout level and is driven purely by
 * the call-store phase — it deliberately survives in-app navigation and takes no
 * URL state. INV-59 exemption (plan §Call surface): a call is session-bound
 * hardware state no URL can restore; the URL-derived surface is the stream page
 * hosting the card, and the refresh story is the (later) rejoin bar — so deriving
 * the dock from `useState`/store rather than the URL is the sanctioned shape here.
 * Non-modal: a plain fixed panel on `side-panel` (never a Radix Dialog/sheet),
 * no autofocus, so it never traps focus or steals it from the composer.
 */
export function CallDock() {
  const phase = useCallPhase()
  const { state: launch } = useCallLaunch()
  const activeElsewhere = useCallActiveElsewhere()
  const storeStreamId = useCallStreamId()
  const workspaceId = useCallWorkspaceId()
  const isMobile = useIsMobile()
  const [collapsed, setCollapsed] = useState(false)

  const launching = launch.status !== "idle"
  const inCall = phase === "connected" || phase === "reconnecting"
  const joining = phase === "joining"

  // The dock is always mounted, so `collapsed` would otherwise leak across call
  // lifecycles. The pre-join/joining window must never be collapsed — a collapsed
  // pill would hide the PreJoinGate and its permission taxonomy — so force it open
  // whenever a launch is in flight or the call is connecting.
  useEffect(() => {
    if (launching || joining) setCollapsed(false)
  }, [launching, joining])

  // On connect, reset the sticky flag: desktop opens the full dock; a phone
  // auto-collapses to a pill so the panel never covers the composer.
  useEffect(() => {
    if (inCall) setCollapsed(isMobile)
  }, [inCall, isMobile])

  // Nothing to show: idle with no launch in flight. Surface the cross-tab chip if
  // another tab holds the call, otherwise render nothing.
  if (!launching && !inCall && !joining) {
    if (activeElsewhere) {
      return (
        <div className={cn("fixed right-4 z-50", DOCK_BOTTOM)}>
          <ActiveElsewhereChip />
        </div>
      )
    }
    return null
  }

  const streamIdForLabel = storeStreamId ?? (launch.status !== "idle" ? launch.request.streamId : null)

  if (inCall) {
    return (
      <ActiveCallDock
        workspaceId={workspaceId}
        streamId={streamIdForLabel}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
      />
    )
  }

  // Joining / permission gate.
  return (
    <DockFrame>
      <DockHeader title="Call" collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      {!collapsed && (
        <div className="p-4">{joining && launch.status === "idle" ? <JoiningBody /> : <PreJoinGate />}</div>
      )}
    </DockFrame>
  )
}

function JoiningBody() {
  return <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">Connecting…</div>
}

function ActiveCallDock({
  workspaceId,
  streamId,
  collapsed,
  onToggle,
}: {
  workspaceId: string | null
  streamId: string | null
  collapsed: boolean
  onToggle: () => void
}) {
  const roster = useCallRoster()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  const title = name ?? "Call"

  const participants = roster.filter((p) => p.participantStatus === "joined")

  if (collapsed) return <CollapsedDock title={title} onToggle={onToggle} />

  return (
    <DockFrame>
      <DockHeader title={title} collapsed={collapsed} onToggle={onToggle} />
      <div className="flex flex-col gap-3 p-3">
        {captureError && (
          <p
            className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
            data-testid="call-capture-error"
          >
            {captureError.code === "capture_rollback_failed"
              ? "Your microphone stopped working and couldn't be restored. Try leaving and rejoining."
              : "Couldn't switch your microphone or camera. Your previous device is still active."}
          </p>
        )}
        <div
          className={cn(
            "grid max-h-[50vh] gap-2 overflow-y-auto",
            participants.length > 1 ? "grid-cols-2" : "grid-cols-1"
          )}
        >
          {participants.map((p) => (
            <CallTile
              key={p.userId}
              participant={p}
              workspaceId={workspaceId}
              isSelf={!!currentUserId && p.userId === currentUserId}
            />
          ))}
        </div>
        <CallControls />
      </div>
    </DockFrame>
  )
}

function CollapsedDock({ title, onToggle }: { title: string; onToggle: () => void }) {
  const manager = useCallManager()
  const muted = useCallMuted()
  const cameraOn = useCallCameraOn()
  const mode = useCallMode()
  const captureError = useCallCaptureError()
  return (
    <div
      className={cn(
        "fixed right-4 z-50 flex items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-xl",
        DOCK_BOTTOM
      )}
    >
      {captureError && (
        // Compact mirror of the expanded banner — a recapture failure must stay
        // visible while collapsed. The full message is on expand.
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full text-destructive"
          role="alert"
          data-testid="call-capture-error"
          aria-label="Microphone or camera problem — expand the call to see details"
        >
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
      )}
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand call"
        aria-expanded={false}
        className="max-w-[140px] truncate text-sm font-medium"
      >
        {title}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8", muted && "text-destructive")}
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
          className="h-8 w-8"
          aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
          aria-pressed={cameraOn}
          onClick={() => void manager.setCameraOn(!cameraOn).catch(() => toast.error("Couldn't switch the camera"))}
        >
          {cameraOn ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        </Button>
      )}
      <Button
        variant="destructive"
        size="icon"
        className="h-8 w-8"
        aria-label="Leave call"
        onClick={() => void manager.leaveCall().catch(() => toast.error("Couldn't leave the call"))}
      >
        <PhoneOff className="h-4 w-4" />
      </Button>
    </div>
  )
}
