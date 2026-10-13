import { createContext, useContext, type MouseEvent, type ReactNode } from "react"
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom"
import {
  isConversationPanel,
  parseComposePanel,
  parseContextPanel,
  parseDraftPanel,
  useCurrentPane,
  useFrontPanel,
  usePanel,
  useSidebar,
} from "@/contexts"
import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  activatePanelTab,
  closePanelTab,
  formatPanelLayout,
  panelIdsOf,
  replacePanelTab,
  NO_PANELS,
  PANEL_PARAM,
  type PanelLayout,
} from "@/lib/panel-tabs"
import { isServerStreamId } from "@/lib/stream-ids"
import { getCachedWorkspaceTables, indexStreams } from "@/stores/workspace-store"

export interface StreamPage {
  mainStreamId: string
  layout: PanelLayout
  /** The pane worked in, or null for the main view. */
  current: string | null
  /** A phone, which shows one pane at a time. */
  stacked: boolean
}

type ParentOf = (streamId: string) => string | null

/** The stream a pane was opened from: a draft's or overview's stream, a new thread's parent, else the stream's parent. */
function openedFrom(id: string, parentOf: ParentOf): string | null {
  return parseComposePanel(id) ?? parseContextPanel(id)?.streamId ?? parseDraftPanel(id)?.parentStreamId ?? parentOf(id)
}

/** The stream a pane belongs to: a draft's or overview's stream, a new thread's parent, a stream's own; null for a conversation. */
export function streamOfPane(id: string): string | null {
  if (isConversationPanel(id)) return null
  return parseComposePanel(id) ?? parseContextPanel(id)?.streamId ?? parseDraftPanel(id)?.parentStreamId ?? id
}

/** The page a pick replaces: a draft's or overview's stream, as a tab or the main view (null), else the pane itself. */
function pageOfPane(page: StreamPage): string | null {
  const { current, layout, mainStreamId } = page
  if (current === null) return null
  const streamId = streamOfPane(current)
  if (streamId === null || streamId === current) return current
  if (streamId === mainStreamId) return null
  return panelIdsOf(layout).includes(streamId) ? streamId : current
}

/** The panes opened from `owner`: its draft and overview, the threads under it, and theirs. A pane whose stream isn't known stays. */
export function panesOpenedFrom(layout: PanelLayout, owner: string, parentOf: ParentOf): string[] {
  return panelIdsOf(layout).filter((id) => {
    const seen = new Set([id])
    for (let up = openedFrom(id, parentOf); up !== null && !seen.has(up); up = openedFrom(up, parentOf)) {
      if (up === owner) return true
      seen.add(up)
    }
    return false
  })
}

/**
 * Where a sidebar pick of `streamId` leaves the stream page: the page worked in
 * becomes that stream and what was opened from it closes. Other tabs stay,
 * except on a phone, where the main view shows only with no tab over it. A
 * stream already open is brought forward instead.
 */
export function pickStream(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const next = pickOnPage(page, streamId, parentOf)
  return page.stacked && next.current === null ? { ...next, layout: NO_PANELS } : next
}

function pickOnPage(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const { mainStreamId, layout, stacked } = page
  const current = pageOfPane(page)
  if (streamId === mainStreamId) {
    const unfocused = layout.focused === undefined ? layout : { columns: layout.columns }
    return { mainStreamId, layout: unfocused, current: null, stacked }
  }
  if (panelIdsOf(layout).includes(streamId)) {
    return { mainStreamId, layout: activatePanelTab(layout, streamId), current: streamId, stacked }
  }
  const rest = panesOpenedFrom(layout, current ?? mainStreamId, parentOf).reduce(closePanelTab, layout)
  if (current === null) return { mainStreamId: streamId, layout: rest, current: null, stacked }
  return { mainStreamId, layout: replacePanelTab(rest, current, streamId), current: streamId, stacked }
}

/** Picks a stream from the sidebar on the stream page; false elsewhere, where a row's link goes to the stream on its own. */
function useStreamPicker(workspaceId: string): (streamId: string) => boolean {
  const navigate = useNavigate()
  const location = useLocation()
  const mainStreamId = useMatch("/w/:workspaceId/s/:streamId")?.params.streamId
  const [searchParams] = useSearchParams()
  const { layout, setCurrentPane } = usePanel()
  const { isMobile } = useSidebar()
  const current = useCurrentPane()
  const front = useFrontPanel()
  return useStableCallback((streamId: string) => {
    // A draft stream only opens as the main view.
    if (!mainStreamId || !isServerStreamId(streamId)) return false
    const streams = indexStreams(getCachedWorkspaceTables(workspaceId).streams ?? [])
    // A phone shows the pane in front, whichever was last touched.
    const page = { mainStreamId, layout, current: isMobile ? front : current, stacked: isMobile }
    const next = pickStream(page, streamId, (id) => streams.get(id)?.parentStreamId ?? null)
    // A pick is a fresh look: a deep link and anything else main carried stay behind with it.
    const params = next.mainStreamId === mainStreamId ? new URLSearchParams(searchParams) : new URLSearchParams()
    params.delete("m")
    const value = formatPanelLayout(next.layout)
    if (value) params.set(PANEL_PARAM, value)
    else params.delete(PANEL_PARAM)
    const query = params.toString()
    const url = `/w/${workspaceId}/s/${next.mainStreamId}${query ? `?${query}` : ""}`
    // A tab swapped in place is followed by the panes themselves; setting it here,
    // ahead of the URL, would have a second quick pick replace a tab not yet there.
    const swapped = next.current !== null && !panelIdsOf(layout).includes(streamId)
    if (!swapped) setCurrentPane(next.current)
    if (url !== `${location.pathname}${location.search}`) navigate(url)
    return true
  })
}

const StreamPickContext = createContext<((streamId: string) => boolean) | null>(null)

export function StreamPickProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return <StreamPickContext.Provider value={useStreamPicker(workspaceId)}>{children}</StreamPickContext.Provider>
}

/** Picks `streamId` from the sidebar; false outside the provider or off the stream page. */
export function useStreamPick(): (streamId: string) => boolean {
  return useContext(StreamPickContext) ?? noPick
}

const noPick = () => false

/** A plain click on a row's link picks its stream; a modified or middle click keeps the link's own behavior. */
export function useStreamRowPick(): (event: MouseEvent<HTMLAnchorElement>, streamId: string) => void {
  const pick = useStreamPick()
  return (event, streamId) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    if (pick(streamId)) event.preventDefault()
  }
}
