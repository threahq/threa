import type { ReactNode } from "react"
import { useDraggable, useDroppable } from "@dnd-kit/core"
import { cn } from "@/lib/utils"

/**
 * Drag-and-drop wiring for filing streams into custom sidebar sections. A stream
 * row is the drag source; a custom section is the drop target. The data payloads
 * (not the ids) carry the resolved ids, so the drop handler reads them directly
 * without parsing prefixes. Desktop-only — mobile files streams through the
 * action drawer's section picker instead, so dragging is `disabled` there to
 * leave touch scrolling and long-press untouched.
 */

interface StreamDragData {
  type: "stream"
  streamId: string
}

interface CustomSectionDropData {
  type: "custom-section"
  customSectionId: string
}

/** The stream id of an in-flight drag, or null when the drag isn't a stream. */
export function streamIdFromDragData(data: unknown): string | null {
  const d = data as StreamDragData | undefined
  return d?.type === "stream" ? d.streamId : null
}

/** The target custom-section id under the pointer, or null when not over one. */
export function customSectionIdFromDropData(data: unknown): string | null {
  const d = data as CustomSectionDropData | undefined
  return d?.type === "custom-section" ? d.customSectionId : null
}

/**
 * Wraps a sidebar stream row to make it draggable. Only the pointer listeners
 * are spread (not dnd-kit's keyboard `attributes`) so the wrapper doesn't turn
 * into a focusable button around the row's `<Link>` — keyboard users file
 * streams through the accessible "Add to section…" action instead. With an
 * activation distance on the sensor, a plain click still navigates the link.
 */
export function DraggableStreamRow({
  streamId,
  enabled,
  children,
}: {
  streamId: string
  enabled: boolean
  children: ReactNode
}) {
  const data: StreamDragData = { type: "stream", streamId }
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `stream:${streamId}`, data, disabled: !enabled })

  return (
    <div ref={setNodeRef} {...(enabled ? listeners : {})} className={cn(isDragging && "opacity-40")}>
      {children}
    </div>
  )
}

/** A droppable wrapper that highlights a custom section while a stream hovers it. */
export function CustomSectionDropZone({
  customSectionId,
  enabled,
  children,
}: {
  customSectionId: string
  enabled: boolean
  children: ReactNode
}) {
  const data: CustomSectionDropData = { type: "custom-section", customSectionId }
  const { setNodeRef, isOver } = useDroppable({ id: `custom-section:${customSectionId}`, data, disabled: !enabled })

  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-lg transition-colors", isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}
    >
      {children}
    </div>
  )
}
