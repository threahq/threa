import { useRef, type MouseEvent, type PointerEvent } from "react"

/**
 * Linux and macOS fire contextmenu on mousedown, so the menu mounts under the held button and Radix
 * would select whichever item the release lands on. Spread `onContextMenu` on the `ContextMenuTrigger`
 * and `onPointerUpCapture` on the `ContextMenuContent`.
 */
export function useContextMenuHoldGuard() {
  const heldRef = useRef(false)
  return {
    // The window listener runs after React's handlers, so the release that opened the menu is still swallowed.
    onContextMenu: (event: MouseEvent) => {
      if (event.buttons === 0 || heldRef.current) return
      heldRef.current = true
      window.addEventListener("pointerup", () => (heldRef.current = false), { once: true })
    },
    onPointerUpCapture: (event: PointerEvent) => {
      if (heldRef.current) event.stopPropagation()
    },
  }
}
