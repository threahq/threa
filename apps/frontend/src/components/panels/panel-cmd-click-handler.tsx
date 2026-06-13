import { useEffect, useRef } from "react"
import { useLocation } from "react-router-dom"
import { usePanel, usePreferencesOptional, useSidebar } from "@/contexts"
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
  // Users can turn the gesture off and keep the browser's native new-tab
  // behavior (default on; absent preferences mean defaults).
  const enabled = usePreferencesOptional()?.preferences?.cmdClickOpensPanel ?? true

  // The listener binds once; state it consults lives in refs.
  const stateRef = useRef({ panels, isMobile, enabled, pathname: location.pathname })
  stateRef.current = { panels, isMobile, enabled, pathname: location.pathname }
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel

  useEffect(() => {
    const onClickCapture = (e: MouseEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const { panels: currentPanels, isMobile: mobile, enabled: on, pathname } = stateRef.current
      if (mobile || !on) return
      const target = e.target as HTMLElement | null
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return
      if (anchor.closest('[role="dialog"]')) return
      const panelId = panelIdFromHref(anchor.href, workspaceId, currentPanels, pathname)
      if (!panelId) return
      e.preventDefault()
      e.stopPropagation()
      // Open the target to the right. NOTE: we deliberately do NOT carry the
      // href's `m` message anchor — `m` is a single global param read by EVERY
      // StreamContent (pane 0 + all panels), and its handler unconditionally
      // disables auto-scroll + fires a jumpToEvent, so a panel's anchor would
      // disrupt the main view's auto-follow. Scrolling the opened panel to the
      // exact message needs a per-pane anchor — tracked as a follow-up.
      openPanelRef.current(panelId, { mode: "new" })
    }
    document.addEventListener("click", onClickCapture, true)
    return () => document.removeEventListener("click", onClickCapture, true)
  }, [workspaceId])

  return null
}
