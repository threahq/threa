import { useCallback } from "react"
import { ASIDE_STAGE_MIN_WIDTH, setAsideColumnWidth, useAsideColumnWidth } from "@/stores/aside-store"
import { useResizeDrag } from "@/hooks/use-resize-drag"

/**
 * The aside column's stored width, clamped to `maxWidth`, and the drag and
 * arrow-key resizing of it from its left edge.
 */
export function useAsideWidth(asideId: string, maxWidth: number) {
  const storedWidth = useAsideColumnWidth(asideId)
  const width = Math.min(Math.max(storedWidth, ASIDE_STAGE_MIN_WIDTH), maxWidth)
  const applyWidth = useCallback(
    (next: number) => setAsideColumnWidth(asideId, Math.min(Math.max(next, ASIDE_STAGE_MIN_WIDTH), maxWidth)),
    [asideId, maxWidth]
  )
  const drag = useResizeDrag({ width, onWidthChange: applyWidth, direction: "left" })
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 50 : 10
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        applyWidth(width + step)
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        applyWidth(width - step)
      }
    },
    [applyWidth, width]
  )
  return { width, onKeyDown, ...drag }
}
