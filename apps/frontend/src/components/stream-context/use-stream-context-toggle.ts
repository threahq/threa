import { contextPanelOf, createContextPanelId, usePanel } from "@/contexts"
import { isPanelOnShow } from "@/lib/panel-tabs"

/**
 * Whether `streamId`'s overview is on show, and a toggle for it: it opens as a
 * pane beside where it is asked for (or brings an open one to the front), and
 * closes when on show.
 */
export function useStreamContextToggle(streamId: string): [boolean, () => void] {
  const { layout, openPanel, closeTab } = usePanel()
  const openId = contextPanelOf(layout, streamId)
  const onShow = openId !== null && isPanelOnShow(layout, openId)
  const toggle = () => {
    if (onShow) closeTab(openId)
    else openPanel(openId ?? createContextPanelId(streamId))
  }
  return [onShow, toggle]
}
