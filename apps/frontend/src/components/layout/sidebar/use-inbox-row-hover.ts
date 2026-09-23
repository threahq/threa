import { useEffect, useRef } from "react"

/**
 * Inbox row hover lifecycle shared by `StreamItem` and `ScratchpadItem`: reports
 * pointer enter/leave to the sidebar's hovered-row ref, which the clear-inbox
 * shortcut reads to find its target. A row that unmounts while hovered (row
 * removed, list reordered, section collapsed) never fires a pointerleave —
 * without the unmount cleanup here, the sidebar's ref would keep pointing at a
 * gone row and the shortcut would silently target nothing (or the wrong row,
 * once guarded).
 */
export function useInboxRowHover(onInboxHoverChange?: (hovering: boolean) => void) {
  const isHoveredRef = useRef(false)
  const onInboxHoverChangeRef = useRef(onInboxHoverChange)
  onInboxHoverChangeRef.current = onInboxHoverChange
  useEffect(() => {
    return () => {
      if (isHoveredRef.current) onInboxHoverChangeRef.current?.(false)
    }
  }, [])
  const handlePointerEnter = () => {
    isHoveredRef.current = true
    onInboxHoverChange?.(true)
  }
  const handlePointerLeave = () => {
    isHoveredRef.current = false
    onInboxHoverChange?.(false)
  }
  return { handlePointerEnter, handlePointerLeave }
}
