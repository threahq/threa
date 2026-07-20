import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { cn } from "@/lib/utils"
import { useWorkspaceUsers } from "@/stores/workspace-store"
import type { CallRosterParticipant } from "@/stores/call-store"
import type { CallFilmstripSide, CallLayout } from "@/stores/call-prefs-store"
import { CallTile } from "./call-tile"

interface CallStageLayoutProps {
  layout: CallLayout
  /** Speaker filmstrip placement: horizontal row (`bottom`) or vertical column (`side`). */
  filmstripSide: CallFilmstripSide
  participants: CallRosterParticipant[]
  currentUserId: string | null
  workspaceId: string | null
  /** View-only local pin (not the store): overrides the default speaker. `null` = default. */
  pinnedUserId: string | null
  onPin: (userId: string) => void
}

/** grid-cols by participant count: 1 up, 2×2 up to 4, 3×3 (scrolls) beyond. */
function gridColsClass(count: number): string {
  if (count <= 1) return "grid-cols-1"
  if (count <= 4) return "grid-cols-2"
  return "grid-cols-3"
}

/** Draggable self-view PiP, constrained to the stage. Defaults to the top-right. */
function SelfPip({ participant, workspaceId }: { participant: CallRosterParticipant; workspaceId: string | null }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const stage = e.currentTarget.parentElement
    if (!d || !stage) return
    const bounds = stage.getBoundingClientRect()
    const box = e.currentTarget.getBoundingClientRect()
    const x = Math.min(Math.max(e.clientX - d.dx - bounds.left, 0), Math.max(bounds.width - box.width, 0))
    const y = Math.min(Math.max(e.clientY - d.dy - bounds.top, 0), Math.max(bounds.height - box.height, 0))
    setPos({ x, y })
  }
  const onPointerUp = () => {
    drag.current = null
  }

  return (
    <div
      className="absolute h-24 w-16 touch-none overflow-hidden rounded-lg shadow-lg"
      style={pos ? { left: pos.x, top: pos.y } : { right: 12, top: 12 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      data-testid="call-self-pip"
    >
      <CallTile participant={participant} workspaceId={workspaceId} isSelf stage fill />
    </div>
  )
}

/**
 * The in-call stage: Grid (equal responsive tiles) or Speaker (active speaker large
 * + draggable self-PiP + filmstrip). Shared by the mobile drawer's Fullscreen and
 * (chunk 6) the desktop dock's Fullscreen/Wide. Renders the stage region only; the
 * caller owns the header (with {@link import("./layout-toggle").LayoutToggle}) and controls.
 *
 * Active speaker is pin-based, not audio-driven: v1 has no per-remote speaking level,
 * so the default is the first joined non-self peer and a tap pins any tile. Auto-switch
 * on the analyser signal is a follow-up once remote levels exist.
 */
export function CallStageLayout({
  layout,
  filmstripSide,
  participants,
  currentUserId,
  workspaceId,
  pinnedUserId,
  onPin,
}: CallStageLayoutProps) {
  const users = useWorkspaceUsers(workspaceId ?? undefined)
  const joined = participants.filter((p) => p.participantStatus === "joined")
  const self = joined.find((p) => p.userId === currentUserId) ?? null
  const nameFor = (userId: string) => users.find((u) => u.id === userId)?.name ?? "participant"

  if (layout === "grid") {
    return (
      <div
        className={cn(
          // Row floor so a large group scrolls rather than compressing to slivers.
          "grid min-h-0 flex-1 auto-rows-[minmax(7rem,1fr)] gap-2 overflow-y-auto bg-call-stage p-3",
          gridColsClass(joined.length)
        )}
        data-testid="call-stage-grid"
      >
        {joined.map((p) => (
          <button
            key={p.userId}
            type="button"
            onClick={() => onPin(p.userId)}
            aria-label={`Pin ${nameFor(p.userId)}`}
            data-testid="call-grid-tile"
            className="min-h-0 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CallTile participant={p} workspaceId={workspaceId} isSelf={p.userId === currentUserId} stage fill />
          </button>
        ))}
      </div>
    )
  }

  const defaultSpeaker = joined.find((p) => p.userId !== currentUserId) ?? self
  const speaker = joined.find((p) => p.userId === pinnedUserId) ?? defaultSpeaker
  const selfPip = self && self !== speaker ? self : null
  const filmstrip = joined.filter((p) => p !== speaker && p !== selfPip)

  return (
    <div
      className={cn("flex min-h-0 flex-1 bg-call-stage", filmstripSide === "side" ? "flex-row" : "flex-col")}
      data-testid="call-stage-speaker"
      data-filmstrip-side={filmstripSide}
    >
      <div className="relative min-h-0 flex-1" data-testid="call-stage-main">
        {speaker && (
          <CallTile
            participant={speaker}
            workspaceId={workspaceId}
            isSelf={speaker.userId === currentUserId}
            stage
            fill
          />
        )}
        {selfPip && <SelfPip participant={selfPip} workspaceId={workspaceId} />}
      </div>

      {filmstrip.length > 0 && (
        <div
          className={cn(
            "flex shrink-0 gap-2",
            filmstripSide === "side" ? "flex-col overflow-y-auto px-2 py-3" : "overflow-x-auto px-3 py-2"
          )}
          data-testid="call-filmstrip"
        >
          {filmstrip.map((p) => (
            <button
              key={p.userId}
              type="button"
              onClick={() => onPin(p.userId)}
              aria-label={`Pin ${nameFor(p.userId)}`}
              data-testid="call-filmstrip-tile"
              className="h-20 w-32 shrink-0 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CallTile participant={p} workspaceId={workspaceId} isSelf={p.userId === currentUserId} stage fill />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
