import { useState, type DragEvent, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { buildStreamLink } from "@/lib/stream-links"

/**
 * Drag-and-drop wiring for sidebar stream rows. A row is the drag source; a
 * custom section or a pinned label section is the drop target. Dropping onto a
 * custom section files the stream there; dropping onto a label section applies
 * that label (and unfiles it from any custom section).
 *
 * Native HTML5 drag, not dnd-kit: a row carries its permalink on `text/uri-list`
 * so the same gesture also drops a link into the composer or another window,
 * which is the whole point of dragging a stream. The two can't share the row —
 * dnd-kit's pointer sensor arms a window-level `dragstart` → `preventDefault`
 * from pointerdown onward, killing the native drag before its distance
 * constraint is even evaluated.
 *
 * Desktop-only — mobile files streams through the action drawer's section picker
 * instead, so `enabled` is false there to leave touch scrolling and long-press
 * untouched.
 */

/**
 * Marks a drag as carrying a sidebar stream. Only `dataTransfer.types` is
 * readable during `dragover`, so the id needs its own MIME type for a section to
 * decide whether it accepts the drop before it lands.
 */
export const STREAM_DRAG_TYPE = "application/x-threa-stream+json"

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }

const escapeHtml = (value: string) => value.replace(/[&<>"]/g, (char) => HTML_ESCAPES[char])

/**
 * The payload a stream drag carries. A native drag crosses windows, so the
 * workspace rides along: dropping a row from one workspace's window onto
 * another's sidebar must not file an id that workspace has never heard of.
 */
function readStreamDrag(data: DataTransfer, workspaceId: string): string | null {
  try {
    const payload = JSON.parse(data.getData(STREAM_DRAG_TYPE)) as { workspaceId?: string; streamId?: string }
    return payload.workspaceId === workspaceId && payload.streamId ? payload.streamId : null
  } catch {
    return null
  }
}

/**
 * A drag that lands on nothing — the timeline, the header, empty sidebar space —
 * would otherwise hit the document's default handler, which navigates the whole
 * page to the dragged URL. Swallow only the drops nobody claimed: a zone that
 * handled the drag has already called `preventDefault`.
 */
function swallowUnclaimedDrop(event: globalThis.DragEvent) {
  if (event.defaultPrevented) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
}

function setMissedDropGuard(armed: boolean) {
  if (armed) {
    window.addEventListener("dragover", swallowUnclaimedDrop)
    window.addEventListener("drop", swallowUnclaimedDrop)
    return
  }
  window.removeEventListener("dragover", swallowUnclaimedDrop)
  window.removeEventListener("drop", swallowUnclaimedDrop)
}

/**
 * Wraps a sidebar stream row to make it draggable. Rendered only where dragging
 * is enabled (desktop) — the caller renders the row bare otherwise. The row's
 * `<Link>` is natively draggable already and pre-fills the clipboard from its
 * own `href`, which in board mode is a board-scoped URL; every flavour is
 * overwritten with the canonical permalink so that one never escapes.
 */
export function DraggableStreamRow({
  workspaceId,
  streamId,
  label,
  children,
}: {
  workspaceId: string
  streamId: string
  label: string
  children: ReactNode
}) {
  const [isDragging, setIsDragging] = useState(false)

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    const link = buildStreamLink(workspaceId, streamId)
    event.dataTransfer.setData(STREAM_DRAG_TYPE, JSON.stringify({ workspaceId, streamId }))
    event.dataTransfer.setData("text/uri-list", link)
    event.dataTransfer.setData("text/plain", link)
    // Rich-text targets (mail, docs, other chat apps) prefer this flavour.
    event.dataTransfer.setData("text/html", `<a href="${escapeHtml(link)}">${escapeHtml(label)}</a>`)
    event.dataTransfer.effectAllowed = "all"
    setMissedDropGuard(true)
    // The browser snapshots the drag image right after this handler, and React
    // flushes a discrete event's state synchronously — dimming now would dim the
    // ghost the user drags around.
    setTimeout(() => setIsDragging(true), 0)
  }

  const handleDragEnd = () => {
    setMissedDropGuard(false)
    setIsDragging(false)
  }

  return (
    <div draggable onDragStart={handleDragStart} onDragEnd={handleDragEnd} className={cn(isDragging && "opacity-40")}>
      {children}
    </div>
  )
}

/** Highlight-while-hovered drop handlers for a section that accepts a stream. */
function useStreamDropZone(enabled: boolean, workspaceId: string, onDropStream: (streamId: string) => void) {
  const [isOver, setIsOver] = useState(false)
  // Only `types` is readable during `dragover`, so the workspace check has to
  // wait for the drop, where the payload itself is readable.
  const accepts = (event: DragEvent<HTMLDivElement>) => enabled && event.dataTransfer.types.includes(STREAM_DRAG_TYPE)

  return {
    isOver,
    dropProps: {
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        if (!accepts(event)) return
        // Without preventDefault the browser refuses the drop outright.
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        setIsOver(true)
      },
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        // Crossing between children re-fires leave; only the zone's own boundary
        // ends the hover.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setIsOver(false)
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        if (!accepts(event)) return
        event.preventDefault()
        setIsOver(false)
        const streamId = readStreamDrag(event.dataTransfer, workspaceId)
        if (streamId) onDropStream(streamId)
      },
    },
  }
}

/**
 * A section that accepts a dropped stream row. What the drop means — filing into
 * a custom section, applying a pinned label — is the caller's `onDropStream`.
 */
export function StreamDropZone({
  enabled,
  workspaceId,
  onDropStream,
  children,
}: {
  enabled: boolean
  workspaceId: string
  onDropStream: (streamId: string) => void
  children: ReactNode
}) {
  const { isOver, dropProps } = useStreamDropZone(enabled, workspaceId, onDropStream)
  return (
    <div
      {...dropProps}
      className={cn("rounded-lg transition-colors", isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}
    >
      {children}
    </div>
  )
}
