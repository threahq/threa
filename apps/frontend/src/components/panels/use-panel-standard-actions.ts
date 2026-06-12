import { useMemo } from "react"
import { useNavigate, useLocation, useParams } from "react-router-dom"
import { ArrowLeft, ArrowRight, PanelLeftClose, SquareArrowOutUpLeft } from "lucide-react"
import type { SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { usePanel } from "@/contexts"
import { panelIdToMainPath, mainPathToPanelId } from "./panel-locations"

/**
 * The panel-management actions every panel's menu carries, regardless of what
 * content it shows: open in main view, move left/right, close others. Content
 * panels append these after their own actions so the menu reads
 * content-first, chrome-second.
 */
export function usePanelStandardActions(panelId: string): SidebarActionItem[] {
  const { panels, movePanel, closeAllPanels } = usePanel()
  const navigate = useNavigate()
  const location = useLocation()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const index = panels.indexOf(panelId)
  const mainPath = workspaceId ? panelIdToMainPath(workspaceId, panelId) : null

  return useMemo(() => {
    const actions: SidebarActionItem[] = []

    if (mainPath) {
      actions.push({
        id: "panel-open-main",
        label: "Open in main view",
        icon: SquareArrowOutUpLeft,
        separatorBefore: true,
        onSelect: () => {
          // Swap: the previous main view takes over this panel's slot when it
          // has a panel-able equivalent; otherwise the slot just closes.
          const previousMain = mainPathToPanelId(location.pathname)
          const params = new URLSearchParams(location.search)
          const current = params.getAll("panel")
          params.delete("panel")
          for (const id of current) {
            if (id === panelId) {
              if (previousMain && previousMain !== panelId && !current.includes(previousMain)) {
                params.append("panel", previousMain)
              }
            } else {
              params.append("panel", id)
            }
          }
          const search = params.toString()
          navigate(`${mainPath}${search ? `?${search}` : ""}`)
        },
      })
    }

    if (index > 0) {
      actions.push({
        id: "panel-move-left",
        label: "Move left",
        icon: ArrowLeft,
        separatorBefore: !mainPath,
        onSelect: () => movePanel(panelId, index - 1),
      })
    }
    if (index !== -1 && index < panels.length - 1) {
      actions.push({
        id: "panel-move-right",
        label: "Move right",
        icon: ArrowRight,
        separatorBefore: !mainPath && index === 0,
        onSelect: () => movePanel(panelId, index + 1),
      })
    }
    if (panels.length > 1) {
      actions.push({
        id: "panel-close-others",
        label: "Close other panels",
        icon: PanelLeftClose,
        onSelect: () => closeAllPanels(panelId),
      })
    }

    return actions
  }, [mainPath, index, panels, panelId, movePanel, closeAllPanels, navigate, location.pathname, location.search])
}
