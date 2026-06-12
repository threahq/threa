import { useCallback, useMemo } from "react"
import { useNavigate, type To, type NavigateOptions } from "react-router-dom"
import { usePanel } from "@/contexts"

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
 * panel: plain click navigates the main view (keeping open panels), while
 * cmd/ctrl-click opens the target in a new side panel instead.
 */
export function usePanelAwareLink(targetPath: string, panelId: string | null) {
  const { panels, openPanel } = usePanel()

  const to = useMemo(() => `${targetPath}${mergePanelsIntoSearch("", panels)}`, [targetPath, panels])

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      if (!panelId) return
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      openPanel(panelId, { mode: "new" })
    },
    [panelId, openPanel]
  )

  return { to, onClick }
}
