import { useMemo } from "react"
import { useParams } from "react-router-dom"
import { ArrowLeft, ArrowRight, PanelLeftClose, SquareArrowOutUpLeft } from "lucide-react"
import type { SidebarActionItem } from "@/components/layout/sidebar/sidebar-actions"
import { usePanel } from "@/contexts"
import { panelIdToMainPath } from "@/lib/panel-locations"

/**
 * The pane-management actions every panel's menu carries, regardless of what
 * content it shows. All positions are in the combined pane order — pane 0
 * (the routed page) included, so "Move left" from the first side panel makes
 * it the routed surface.
 */
export function usePanelStandardActions(panelId: string): SidebarActionItem[] {
  const { panes, paneZeroId, movePane, closeAllPanels } = usePanel()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const index = panes.indexOf(panelId)
  const isRoutable = workspaceId ? panelIdToMainPath(workspaceId, panelId) != null : false
  // A pane with no routed equivalent (draft threads) can't take index 0.
  const leftFloor = paneZeroId && !isRoutable ? 1 : 0

  return useMemo(() => {
    const actions: SidebarActionItem[] = []

    if (isRoutable && index > 0) {
      actions.push({
        id: "panel-make-first",
        label: "Make first pane",
        icon: SquareArrowOutUpLeft,
        separatorBefore: true,
        onSelect: () => movePane(panelId, 0),
      })
    }

    if (index > leftFloor) {
      actions.push({
        id: "panel-move-left",
        label: "Move left",
        icon: ArrowLeft,
        separatorBefore: actions.length === 0,
        onSelect: () => movePane(panelId, index - 1),
      })
    }
    if (index !== -1 && index < panes.length - 1) {
      actions.push({
        id: "panel-move-right",
        label: "Move right",
        icon: ArrowRight,
        separatorBefore: actions.length === 0,
        onSelect: () => movePane(panelId, index + 1),
      })
    }
    // "Others" = other side panels; pane 0 isn't closed by this.
    if (panes.length > (paneZeroId ? 2 : 1)) {
      actions.push({
        id: "panel-close-others",
        label: "Close other panels",
        icon: PanelLeftClose,
        onSelect: () => closeAllPanels(panelId),
      })
    }

    return actions
  }, [isRoutable, index, leftFloor, panes, paneZeroId, panelId, movePane, closeAllPanels])
}
