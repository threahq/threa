import type { useLocation, useNavigate } from "react-router-dom"
import { afterOverlayHistory } from "@/components/ui/history-back-close"
import { panelIdsOf, type PanelLayout } from "@/lib/panel-tabs"

/**
 * Brings the share target's composer on show after `queueShareHandoff`, for the message menu's fast paths and the
 * share picker alike. A target among the panes becomes the pane worked in; another opens as a link to it would,
 * beside the pane shared from or, on a phone, in its place. The composer picks the share up from the handoff
 * store wherever it mounts. Waits for the share's overlay to leave history, so Back lands where the share began.
 */
export function navigateAfterShareHandoff({
  workspaceId,
  targetStreamId,
  location,
  navigate,
  panel,
}: {
  workspaceId: string
  targetStreamId: string
  location: ReturnType<typeof useLocation>
  navigate: ReturnType<typeof useNavigate>
  panel: {
    hasTabs: boolean
    layout: PanelLayout
    setCurrentPane: (panelId: string) => void
    openPanel: (panelId: string) => void
  }
}): void {
  const targetPathname = `/w/${workspaceId}/s/${targetStreamId}`
  afterOverlayHistory(() => {
    if (!panel.hasTabs) {
      if (location.pathname !== targetPathname) navigate(targetPathname)
    } else if (panelIdsOf(panel.layout).includes(targetStreamId)) panel.setCurrentPane(targetStreamId)
    else panel.openPanel(targetStreamId)
  })
}
