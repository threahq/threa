import { useState, type RefObject } from "react"
import { Users } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { setCallFilmstripSide, useCallPrefs, type DesktopSurface } from "@/stores/call-prefs-store"
import { CallControls } from "./call-controls"
import { CaptureErrorBanner } from "./call-capture-error"
import { CallStageLayout } from "./call-stage-layout"
import { CallTimer } from "./call-timer"
import { DesktopCallSurfacePicker } from "./desktop-call-surface-picker"
import { LayoutToggle } from "./layout-toggle"
import { CallJoiningBody } from "./pre-join-gate"
import { useCallCaptureError, useCallConnectedAt, useCallRoster } from "./call-store-hooks"

function FilmstripSideToggle() {
  const { filmstripSide } = useCallPrefs()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      role="radiogroup"
      value={filmstripSide}
      onValueChange={(value) => {
        if (value === "bottom" || value === "side") setCallFilmstripSide(value)
      }}
      aria-label="Filmstrip position"
      data-testid="call-filmstrip-side-toggle"
      className="shrink-0 gap-0.5 rounded-md bg-muted p-0.5"
    >
      <ToggleGroupItem value="bottom" aria-label="Filmstrip bottom" className="h-7 px-2 text-xs">
        Bottom
      </ToggleGroupItem>
      <ToggleGroupItem value="side" aria-label="Filmstrip side" className="h-7 px-2 text-xs">
        Side
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

export function DesktopCallFullscreen({
  workspaceId,
  streamId,
  joining,
  onSelectSurface,
  surfacePickerTriggerRef,
}: {
  workspaceId: string | null
  streamId: string | null
  joining: boolean
  onSelectSurface: (surface: DesktopSurface) => void
  surfacePickerTriggerRef?: RefObject<HTMLButtonElement | null>
}) {
  const { layout, filmstripSide } = useCallPrefs()
  const roster = useCallRoster()
  const connectedAt = useCallConnectedAt()
  const captureError = useCallCaptureError()
  const currentUserId = useWorkspaceUserId(workspaceId ?? "")
  const title = useStreamName(workspaceId ?? "", streamId ?? "", "generic") ?? "Call"
  const joined = roster.filter((participant) => participant.participantStatus === "joined")
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null)

  return (
    <div
      data-testid="desktop-call-fullscreen"
      data-phase={joining ? "joining" : "connected"}
      className="fixed inset-y-0 right-0 z-40 flex flex-col bg-background text-foreground"
      style={{ left: "var(--app-content-left, 0px)" }}
    >
      {captureError && <CaptureErrorBanner error={captureError} className="mx-3 mt-2" />}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          {!joining && <CallTimer connectedAt={connectedAt} className="text-muted-foreground" />}
        </div>
        {!joining && (
          <span
            className="ml-2 flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
            aria-label="Participants in call"
          >
            <Users className="h-3.5 w-3.5" aria-hidden />
            {joined.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!joining && layout === "speaker" && <FilmstripSideToggle />}
          {!joining && (
            <div data-testid="call-layout-slot">
              <LayoutToggle className="bg-muted" />
            </div>
          )}
          <DesktopCallSurfacePicker
            value="fullscreen"
            onValueChange={onSelectSurface}
            triggerRef={surfacePickerTriggerRef}
          />
        </div>
      </div>
      {joining ? (
        <CallJoiningBody />
      ) : (
        <>
          <CallStageLayout
            layout={layout}
            filmstripSide={filmstripSide}
            participants={roster}
            currentUserId={currentUserId}
            workspaceId={workspaceId}
            pinnedUserId={pinnedUserId}
            onPin={setPinnedUserId}
            backgroundClassName="bg-background"
          />
          <div className="shrink-0 px-3 pb-3 pt-1">
            <CallControls />
          </div>
        </>
      )}
    </div>
  )
}
