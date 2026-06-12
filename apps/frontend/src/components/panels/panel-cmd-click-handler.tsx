import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"
import { usePanel, useSidebar } from "@/contexts"
import { panelIdFromHref } from "@/lib/panel-locations"

/**
 * One rule for the whole workspace: cmd/ctrl-click on any internal link whose
 * destination can live in a panel opens it in a new side panel instead of a
 * browser tab. A document-level capture listener means surfaces don't opt in
 * individually — sidebar items, thread cards, breadcrumbs, and channel
 * mentions all behave identically. Links inside dialogs are exempt (modal
 * surfaces own their selection semantics; the quick switcher routes its
 * modifier-selects through the same openPanel path itself), as are links to
 * other workspaces, external URLs, and explicit target="_blank" anchors —
 * those keep the browser's native behavior.
 */
export function PanelCmdClickHandler({ workspaceId }: { workspaceId: string }) {
  const { panels, openPanel } = usePanel()
  const { isMobile } = useSidebar()
  const location = useLocation()

  // The listener binds once; state it consults lives in refs.
  const stateRef = useRef({ panels, isMobile, pathname: location.pathname })
  stateRef.current = { panels, isMobile, pathname: location.pathname }
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel

  useEffect(() => {
    const onClickCapture = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const { panels: currentPanels, isMobile: mobile, pathname } = stateRef.current
      if (mobile) return
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return
      if (anchor.closest('[role="dialog"]')) return
      const panelId = panelIdFromHref(anchor.href, workspaceId, currentPanels, pathname)
      if (!panelId) return
      e.preventDefault()
      e.stopPropagation()
      openPanelRef.current(panelId, { mode: "new" })
    }
    document.addEventListener("click", onClickCapture, true)
    return () => document.removeEventListener("click", onClickCapture, true)
  }, [workspaceId])

  return null
}
