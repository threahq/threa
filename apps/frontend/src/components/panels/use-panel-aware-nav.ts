import { useCallback, useMemo } from "react"
import { useNavigate, type To, type NavigateOptions } from "react-router-dom"
import { usePanel, useSidebar } from "@/contexts"

/**
 * Panels are part of the user's workspace layout: navigating the main view
 * (sidebar, quick switcher) should not blow away the side panels they've
 * arranged. These helpers carry the current `?panel=` params onto navigation
 * targets that don't specify their own.
 */

function mergePanelsIntoSearch(targetSearch: string, panels: string[]): string {
  const params = new URLSearchParams(targetSearch)
  // A target that names panels explicitly wins — it's making a statement.
  if (!params.has("panel")) {
    for (const id of panels) params.append("panel", id)
  }
  const s = params.toString()
  return s ? `?${s}` : ""
}

/** A drop-in `navigate` that carries open panels onto the destination URL. */
export function usePanelPreservingNavigate() {
  const navigate = useNavigate()
  const { panels } = usePanel()

  return useCallback(
    (to: To | number, options?: NavigateOptions) => {
      if (typeof to === "number") {
        navigate(to)
        return
      }
      if (panels.length === 0) {
        navigate(to, options)
        return
      }
      if (typeof to === "string") {
        const [path, search = ""] = to.split("?")
        navigate(`${path}${mergePanelsIntoSearch(search, panels)}`, options)
        return
      }
      navigate({ ...to, search: mergePanelsIntoSearch(to.search ?? "", panels) }, options)
    },
    [navigate, panels]
  )
}

/**
 * Link behavior for things that exist both as a main-view route and as a
 * panel. Plain click follows the focused pane (the VS Code model): with a
 * side panel focused it opens there; with the main pane focused it navigates
 * the main view. A target already on screen is just focused, never
 * duplicated. Mobile keeps the plain navigate behavior — there is no pane
 * strip to target. Cmd/ctrl-click is NOT handled here: the global
 * PanelCmdClickHandler intercepts modifier clicks on every internal anchor,
 * this one included, so the gesture stays consistent across all surfaces.
 */
export function usePanelAwareLink(targetPath: string, panelId: string | null) {
  const { panels, paneZeroId, openPanel, setFocusedPane, getFocusedPane } = usePanel()
  const { isMobile } = useSidebar()

  const to = useMemo(() => `${targetPath}${mergePanelsIntoSearch("", panels)}`, [targetPath, panels])

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (!panelId) return
      if (e.metaKey || e.ctrlKey) return
      if (isMobile || panels.length === 0) return
      if (panelId === paneZeroId) {
        e.preventDefault()
        e.stopPropagation()
        setFocusedPane("main")
        return
      }
      if (panels.includes(panelId)) {
        e.preventDefault()
        e.stopPropagation()
        setFocusedPane(panelId)
        return
      }
      const focused = getFocusedPane()
      if (focused !== "main" && panels.includes(focused)) {
        e.preventDefault()
        e.stopPropagation()
        // openPanel defaults to the focused panel as its target.
        openPanel(panelId)
      }
      // Focused pane is main: fall through to the link and navigate pane 0.
    },
    [panelId, panels, paneZeroId, isMobile, openPanel, setFocusedPane, getFocusedPane]
  )

  return { to, onClick }
}
