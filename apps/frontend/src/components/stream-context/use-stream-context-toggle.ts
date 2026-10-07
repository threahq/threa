import { contextPanelOf, coverPaneOf, createContextPanelId, useDisplayedPanelLayout, usePanel } from "@/contexts"
import { isPanelOnShow, panelIdsOf, type PanelLayout } from "@/lib/panel-tabs"

/**
 * Whether `streamId`'s overview is on show, and a toggle for it: it opens as a
 * pane beside where it is asked for (or brings an open one to the front), and
 * closes when on show. `display` is the screen's arrangement, for a caller
 * outside the tabs that arrange it.
 */
export function useStreamContextToggle(streamId: string, display?: PanelLayout): [boolean, () => void] {
  const { layout, openPanel, closeTab, setCurrentPane } = usePanel()
  const shown = useDisplayedPanelLayout()
  const screen = display ?? shown
  const openId = contextPanelOf(layout, streamId)
  // Off the screen's grid it is a drawer, on show over its stream's page (null: the main view).
  const drawn = openId !== null && !panelIdsOf(screen).includes(openId)
  const host = drawn ? coverPaneOf(layout, openId) : openId
  const hostOnShow = host === null ? screen.columns.length === 0 : isPanelOnShow(screen, host)
  // Folded behind another tab or under a floating one, it is not on show.
  const onShow = openId !== null && hostOnShow && (layout.focused === undefined || layout.focused === openId)
  const toggle = () => {
    if (onShow) return closeTab(openId)
    // Folded behind another tab its place in the URL is already right; working in it brings it forward.
    if (openId && isPanelOnShow(layout, openId) && layout.focused === undefined) return setCurrentPane(openId)
    openPanel(openId ?? createContextPanelId(streamId))
  }
  return [onShow, toggle]
}
