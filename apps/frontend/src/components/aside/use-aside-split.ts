import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { useResizeDrag } from "@/hooks/use-resize-drag"
import { ASIDE_DRAFT_MIN_HEIGHT, setAsideDraftHeight, useAsideDraftHeight } from "@/stores/aside-store"

/** What the conversation keeps for itself: below this its own composer and the
 *  last thing Ariadne said stop fitting together, which is the whole point of
 *  having them on screen beside the draft. */
const CONVERSATION_MIN_HEIGHT = 200

export interface AsideSplit {
  /** Attach to the column the two halves share; its height bounds the drag. */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** The drafts half's height, clamped to what the column can actually spare. */
  height: number
  maxHeight: number
  isResizing: boolean
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerEnd: (event: React.PointerEvent) => void
  onKeyDown: (event: React.KeyboardEvent) => void
}

/**
 * How the aside divides itself between the draft and the conversation. The
 * default split is a guess about one draft in one column; a long draft beside a
 * short answer (or the reverse) is the normal case, so it is dragged, and the
 * drag is stored per aside for the session like the stage's width.
 *
 * `reservedHeight` is whatever sits between the two halves in the caller's own
 * layout (gaps, the divider) — without it the conversation's floor is measured
 * against height the conversation never gets.
 */
export function useAsideSplit(asideId: string, options: { active: boolean; reservedHeight?: number }): AsideSplit {
  const { active, reservedHeight = 0 } = options
  const containerRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const measure = () => setAvailable(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active])

  const stored = useAsideDraftHeight(asideId)
  // Before the first measurement the viewport stands in — capping at the
  // stored height instead would make the divider inert on the frame the user
  // grabs it (the dock's width cap has the same guard).
  const column = available > 0 ? available : (globalThis.window?.innerHeight ?? 0)
  const maxHeight = Math.max(ASIDE_DRAFT_MIN_HEIGHT, column - CONVERSATION_MIN_HEIGHT - reservedHeight)
  const height = Math.min(Math.max(stored, ASIDE_DRAFT_MIN_HEIGHT), maxHeight)

  const apply = useCallback(
    (next: number) => setAsideDraftHeight(asideId, Math.min(Math.max(next, ASIDE_DRAFT_MIN_HEIGHT), maxHeight)),
    [asideId, maxHeight]
  )
  // The drafts half sits above the conversation, so pulling the divider down is
  // what makes it taller.
  const { isResizing, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizeDrag({
    width: height,
    onWidthChange: apply,
    direction: "down",
  })

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 64 : 16
      if (event.key === "ArrowDown") {
        event.preventDefault()
        apply(height + step)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        apply(height - step)
      }
    },
    [apply, height]
  )

  return {
    containerRef,
    height,
    maxHeight,
    isResizing,
    onPointerDown: handleResizeStart,
    onPointerMove: handleResizeMove,
    onPointerEnd: handleResizeEnd,
    onKeyDown,
  }
}
