import { createContext, useContext, type MouseEvent, type ReactNode } from "react"
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom"
import {
  isConversationPanel,
  parseComposePanel,
  parseContextPanel,
  parseDraftPanel,
  useCurrentPane,
  usePanel,
} from "@/contexts"
import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  activatePanelTab,
  closePanelTab,
  formatPanelLayout,
  panelIdsOf,
  replacePanelTab,
  PANEL_PARAM,
  type PanelLayout,
} from "@/lib/panel-tabs"
import { getCachedWorkspaceTables, indexStreams } from "@/stores/workspace-store"

export interface StreamPage {
  mainStreamId: string
  layout: PanelLayout
  /** The pane worked in, or null for the main view. */
  current: string | null
}

type ParentOf = (streamId: string) => string | null

/** The stream a pane was opened from: a draft's or overview's stream, a new thread's parent, else the stream's parent. */
function openedFrom(id: string, parentOf: ParentOf): string | null {
  return parseComposePanel(id) ?? parseContextPanel(id)?.streamId ?? parseDraftPanel(id)?.parentStreamId ?? parentOf(id)
}

/** The stream whose row stands for a pane: a draft's or overview's stream, a stream's own; null for a pane no row lists. */
export function streamOfPane(id: string): string | null {
  if (parseDraftPanel(id) !== null || isConversationPanel(id)) return null
  return parseComposePanel(id) ?? parseContextPanel(id)?.streamId ?? id
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
 * Where a sidebar pick of `streamId` leaves the stream page: the pane worked in
 * becomes that stream and what was opened from it closes. Other tabs stay. A
 * stream already open is brought forward instead.
 */
export function pickStream(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const { mainStreamId, layout, current } = page
  if (streamId === mainStreamId) {
    return { mainStreamId, layout: layout.focused === undefined ? layout : { columns: layout.columns }, current: null }
  }
  if (panelIdsOf(layout).includes(streamId)) {
    return { mainStreamId, layout: activatePanelTab(layout, streamId), current: streamId }
  }
  const rest = panesOpenedFrom(layout, current ?? mainStreamId, parentOf).reduce(closePanelTab, layout)
  if (current === null) return { mainStreamId: streamId, layout: rest, current: null }
  return { mainStreamId, layout: replacePanelTab(rest, current, streamId), current: streamId }
}

/** Picks a stream from the sidebar on the stream page; false elsewhere, where a row's link goes to the stream on its own. */
function useStreamPicker(workspaceId: string): (streamId: string) => boolean {
  const navigate = useNavigate()
  const location = useLocation()
  const mainStreamId = useMatch("/w/:workspaceId/s/:streamId")?.params.streamId
  const [searchParams] = useSearchParams()
  const { layout, setCurrentPane } = usePanel()
  const current = useCurrentPane()
  return useStableCallback((streamId: string) => {
    if (!mainStreamId) return false
    const streams = indexStreams(getCachedWorkspaceTables(workspaceId).streams ?? [])
    const next = pickStream(
      { mainStreamId, layout, current },
      streamId,
      (id) => streams.get(id)?.parentStreamId ?? null
    )
    // A pick is a fresh look: a deep link and anything else main carried stay behind with it.
    const params = next.mainStreamId === mainStreamId ? new URLSearchParams(searchParams) : new URLSearchParams()
    params.delete("m")
    const value = formatPanelLayout(next.layout)
    if (value) params.set(PANEL_PARAM, value)
    else params.delete(PANEL_PARAM)
    const query = params.toString()
    const url = `/w/${workspaceId}/s/${next.mainStreamId}${query ? `?${query}` : ""}`
    setCurrentPane(next.current)
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
