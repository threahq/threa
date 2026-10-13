import { contextPanelOf, coverPaneOf, createContextPanelId, useDisplayedPanelLayout, usePanel } from "@/contexts"
import { isPanelOnShow, panelIdsOf } from "@/lib/panel-tabs"

/**
 * Whether `streamId`'s overview is on show, and a toggle for it: it opens as a
 * pane beside where it is asked for (or brings an open one to the front), and
 * closes when on show.
 */
export function useStreamContextToggle(streamId: string): [boolean, () => void] {
  const { layout, openPanel, closeTab, setCurrentPane } = usePanel()
  const screen = useDisplayedPanelLayout()
  const openId = contextPanelOf(layout, streamId)
  // Off the screen's grid it is a drawer, on show over its stream's page.
  const drawn = openId !== null && !panelIdsOf(screen).includes(openId)
  const host = drawn ? coverPaneOf(layout, openId) : openId
  // Folded behind another tab or under a floating one, it is not on show.
  const onShow =
    openId !== null &&
    host !== null &&
    isPanelOnShow(screen, host) &&
    (layout.focused === undefined || layout.focused === openId)
  const toggle = () => {
    if (onShow) return closeTab(openId)
    // Folded behind another tab its place in the URL is already right; working in it brings it forward.
    if (openId && isPanelOnShow(layout, openId) && layout.focused === undefined) return setCurrentPane(openId)
    openPanel(openId ?? createContextPanelId(streamId))
  }
  return [onShow, toggle]
}
