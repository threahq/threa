import { createContext, useContext, type MouseEvent, type ReactNode } from "react"
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom"
import {
  isConversationPanel,
  parseComposePanel,
  parseConversationsPanel,
  parseContextPanel,
  parseDraftPanel,
  useCurrentPane,
  usePanel,
  useSidebar,
} from "@/contexts"
import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  activatePanelTab,
  canonicalPanelLayout,
  closePanelTab,
  formatPanelLayout,
  openPanelTab,
  panelIdsOf,
  primaryPanelOf,
  replacePanelTab,
  NO_PANELS,
  PANEL_PARAM,
  type PanelLayout,
} from "@/lib/panel-tabs"
import { isServerStreamId } from "@/lib/stream-ids"
import { getCachedWorkspaceTables, indexStreams } from "@/stores/workspace-store"

export interface StreamPage {
  layout: PanelLayout
  /** The pane worked in. */
  current: string
  /** A phone, which shows one pane at a time. */
  stacked: boolean
}

type ParentOf = (streamId: string) => string | null

/** The stream a pane was opened from: a draft's, conversations list's or overview's stream, a new thread's parent, else the stream's parent. */
function openedFrom(id: string, parentOf: ParentOf): string | null {
  return (
    parseComposePanel(id) ??
    parseConversationsPanel(id) ??
    parseContextPanel(id)?.streamId ??
    parseDraftPanel(id)?.parentStreamId ??
    parentOf(id)
  )
}

/** The stream a pane belongs to: a draft's, conversations list's or overview's stream, a new thread's parent, a stream's own; null for a conversation. */
export function streamOfPane(id: string): string | null {
  if (isConversationPanel(id)) return null
  return (
    parseComposePanel(id) ??
    parseConversationsPanel(id) ??
    parseContextPanel(id)?.streamId ??
    parseDraftPanel(id)?.parentStreamId ??
    id
  )
}

/** The pane a pick replaces: a draft's, conversations list's or overview's stream while it is open, else the pane itself. */
function pageOfPane({ current, layout }: StreamPage): string {
  const streamId = streamOfPane(current)
  if (streamId === null || streamId === current) return current
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
 * Where a sidebar pick of `streamId` leaves the stream page: the pane worked in
 * becomes that stream and what was opened from it closes. Other panes stay,
 * except on a phone, where the first page shows only with no page over it. A
 * stream already open is brought forward instead.
 */
export function pickStream(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const next = pickOnPage(page, streamId, parentOf)
  if (!page.stacked || primaryPanelOf(next.layout) !== next.current) return next
  return { ...next, layout: openPanelTab(NO_PANELS, next.current) }
}

function pickOnPage(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const { layout, stacked } = page
  if (panelIdsOf(layout).includes(streamId)) {
    const shown = activatePanelTab(layout, streamId)
    // Under another pane floating, it would stay out of reach.
    const reachable = shown.focused === undefined || shown.focused === streamId ? shown : { columns: shown.columns }
    return { layout: reachable, current: streamId, stacked }
  }
  const replaced = pageOfPane(page)
  const rest = panesOpenedFrom(layout, replaced, parentOf).reduce(closePanelTab, layout)
  return { layout: replacePanelTab(rest, replaced, streamId), current: streamId, stacked }
}

/** Picks a stream from the sidebar on the stream page; false elsewhere, where a row's link goes to the stream on its own. */
function useStreamPicker(workspaceId: string): (streamId: string) => boolean {
  const navigate = useNavigate()
  const location = useLocation()
  const path = useMatch("/w/:workspaceId/s/:streamId")?.params.streamId
  const [searchParams] = useSearchParams()
  const { layout, setCurrentPane, markCurrentPane } = usePanel()
  const { isMobile } = useSidebar()
  const current = useCurrentPane()
  return useStableCallback((streamId: string) => {
    // A draft stream only opens as a page of its own.
    if (!path || !isServerStreamId(streamId)) return false
    const streams = indexStreams(getCachedWorkspaceTables(workspaceId).streams ?? [])
    const page = { layout, current: current ?? path, stacked: isMobile }
    const next = pickStream(page, streamId, (id) => streams.get(id)?.parentStreamId ?? null)
    // Moving to a pane already on show changes only which pane is worked in, which is no step in history.
    if (formatPanelLayout(next.layout) === formatPanelLayout(layout) && !searchParams.has("m")) {
      setCurrentPane(next.current)
      return true
    }
    // A pick is a fresh look: a deep link, and anything else the route's stream carried once it is gone, stay behind.
    const params = panelIdsOf(next.layout).includes(path) ? new URLSearchParams(searchParams) : new URLSearchParams()
    params.delete("m")
    const value = formatPanelLayout(canonicalPanelLayout(next.layout, next.current))
    if (value) params.set(PANEL_PARAM, value)
    else params.delete(PANEL_PARAM)
    const query = params.toString()
    const url = `/w/${workspaceId}/s/${next.current}${query ? `?${query}` : ""}`
    // The panes follow the route to the stream it names; setting one ahead of the URL would have a second quick pick
    // replace a tab not yet there. Marked, not set: on a phone, setting also rewrites the entry this push leaves for Back.
    if (next.current === path) markCurrentPane(next.current)
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
