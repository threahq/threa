import type { ReactNode } from "react"
import { useDraggable, useDroppable } from "@dnd-kit/core"
import { cn } from "@/lib/utils"
import { customSectionId, labelSectionId } from "./sidebar-config"

/**
 * Drag-and-drop wiring for filing streams into sidebar sections. A stream row is
 * the drag source; a custom section or a pinned label section is the drop
 * target. Dropping onto a custom section files the stream there; dropping onto a
 * label section applies that label to the stream (and unfiles it from any custom
 * section). The data payloads (not the ids) carry the resolved ids, so the drop
 * handler reads them directly without parsing prefixes. Desktop-only — mobile
 * files streams through the action drawer's section picker instead, so dragging
 * is `disabled` there to leave touch scrolling and long-press untouched.
 */

interface StreamDragData {
  type: "stream"
  streamId: string
}

interface CustomSectionDropData {
  type: "custom-section"
  customSectionId: string
}

interface LabelSectionDropData {
  type: "label-section"
  labelId: string
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

/** The target label id under the pointer, or null when not over a label section. */
export function labelIdFromDropData(data: unknown): string | null {
  const d = data as LabelSectionDropData | undefined
  return d?.type === "label-section" ? d.labelId : null
}

/**
 * Wraps a sidebar stream row to make it draggable. Rendered only where dragging
 * is enabled (desktop) — the caller renders the row bare otherwise, so we never
 * register a dead draggable per row. Only the pointer listeners are spread (not
 * dnd-kit's keyboard `attributes`) so the wrapper doesn't turn into a focusable
 * button around the row's `<Link>` — keyboard users file streams through the
 * accessible "Add to section…" action instead. With an activation distance on
 * the sensor, a plain click still navigates the link.
 */
export function DraggableStreamRow({ streamId, children }: { streamId: string; children: ReactNode }) {
  const data: StreamDragData = { type: "stream", streamId }
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: `stream:${streamId}`, data })

  return (
    <div ref={setNodeRef} {...listeners} className={cn(isDragging && "opacity-40")}>
      {children}
    </div>
  )
}

/**
 * A droppable wrapper that highlights a custom section while a stream hovers it.
 * The droppable id reuses the section's stable id ({@link customSectionId}) so
 * the `custom:`-prefix convention lives in one place; the handler reads the
 * section id from the data payload, not by parsing the id.
 */
export function CustomSectionDropZone({
  sectionId,
  enabled,
  children,
}: {
  sectionId: string
  enabled: boolean
  children: ReactNode
}) {
  const data: CustomSectionDropData = { type: "custom-section", customSectionId: sectionId }
  const { setNodeRef, isOver } = useDroppable({ id: customSectionId(sectionId), data, disabled: !enabled })

  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-lg transition-colors", isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}
    >
      {children}
    </div>
  )
}

/**
 * A droppable wrapper that highlights a pinned label section while a stream
 * hovers it. Dropping applies the label to the stream. The droppable id reuses
 * the label section's stable id ({@link labelSectionId}) so the `label:`-prefix
 * convention lives in one place; the handler reads the label id from the data
 * payload, not by parsing the id.
 */
export function LabelSectionDropZone({
  labelId,
  enabled,
  children,
}: {
  labelId: string
  enabled: boolean
  children: ReactNode
}) {
  const data: LabelSectionDropData = { type: "label-section", labelId }
  const { setNodeRef, isOver } = useDroppable({ id: labelSectionId(labelId), data, disabled: !enabled })

  return (
    <div
      ref={setNodeRef}
      className={cn("rounded-lg transition-colors", isOver && "bg-primary/5 ring-2 ring-primary/40 ring-inset")}
    >
      {children}
    </div>
  )
}
