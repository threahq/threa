import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"
import { parseAsidePanel } from "@/contexts"
import { asideHostKey, dropAsideForHost, dropAsideForHostStream } from "@/stores/aside-store"

const NO_PANES: readonly string[] = []

/**
 * Binds the aside surface to the page: leaving the page (the host key
 * changing, or the page unmounting) drops whatever aside was open on it, and so
 * does closing the pane of the stream it was opened on (`panes`, every pane the
 * page shows), or the aside's own pane — so the next stream is clean by
 * construction and the anchor row is the only way back in.
 */
export function useAsideHost(panes: readonly string[] = NO_PANES): string {
  const hostKey = asideHostKey(useLocation().pathname)
  useEffect(() => () => dropAsideForHost(hostKey), [hostKey])
  // Only a pane that closes: an aside opened for a stream the page is about to show waits for it.
  const shown = useRef(panes)
  useEffect(() => {
    for (const pane of shown.current) {
      if (!panes.includes(pane)) dropAsideForHostStream(hostKey, parseAsidePanel(pane) ?? pane)
    }
    shown.current = panes
  }, [hostKey, panes])
  return hostKey
}
