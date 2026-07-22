import { type RefObject, useLayoutEffect } from "react"

export function useCommittedSidebarWidth(shellRef: RefObject<HTMLElement | null>, width: number, sidebarState: string) {
  useLayoutEffect(() => {
    // Collapse can leave width unchanged, so the state dependency reclaims this var from the live drag writer.
    shellRef.current?.style.setProperty("--nav-sidebar-width", `${width}px`)
    shellRef.current?.style.setProperty("--nav-sidebar-shell-width", `${width}px`)
  }, [shellRef, sidebarState, width])
}
