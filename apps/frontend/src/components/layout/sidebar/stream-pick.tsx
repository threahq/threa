import { createContext, useContext, type MouseEvent, type ReactNode } from "react"
import { useLocation, useMatch, useNavigate, useSearchParams } from "react-router-dom"
import {
  isConversationPanel,
  parseAsidePanel,
  parseComposePanel,
  parseConversationsPanel,
  parsePersonaTestPanel,
  parseContextPanel,
  parseDraftPanel,
  useCurrentPane,
  usePanel,
} from "@/contexts"
import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  activatePanelTab,
  canonicalPanelLayout,
  closePanelTab,
  formatPanelLayout,
  readablePanelParam,
  panelIdsOf,
  replacePanelTab,
  PANEL_PARAM,
  type PanelLayout,
} from "@/lib/panel-tabs"
import { isPagePane, isServerStreamId } from "@/lib/stream-ids"
import { pagePaneAt, pagePathOf } from "@/lib/page-panes"
import { flashPane } from "@/lib/pane-flash"
import { getCachedWorkspaceTables, indexStreams } from "@/stores/workspace-store"

export interface StreamPage {
  layout: PanelLayout
  /** The pane worked in. */
  current: string
}

type ParentOf = (streamId: string) => string | null

/** The stream a pane was opened from: a draft's, aside's, conversations list's or overview's stream, a new thread's parent, else the stream's parent. */
function openedFrom(id: string, parentOf: ParentOf): string | null {
  return (
    parseComposePanel(id) ??
    parseAsidePanel(id) ??
    parseConversationsPanel(id) ??
    parseContextPanel(id)?.streamId ??
    parseDraftPanel(id)?.parentStreamId ??
    parentOf(id)
  )
}

/** The stream a pane belongs to: a draft's, aside's, conversations list's or overview's stream, a new thread's parent, a stream's own; null for a conversation, a page or a persona's test chat. */
export function streamOfPane(id: string): string | null {
  if (isConversationPanel(id) || isPagePane(id) || parsePersonaTestPanel(id)) return null
  return (
    parseComposePanel(id) ??
    parseAsidePanel(id) ??
    parseConversationsPanel(id) ??
    parseContextPanel(id)?.streamId ??
    parseDraftPanel(id)?.parentStreamId ??
    id
  )
}

/** The pane a pick replaces: a draft's, aside's, conversations list's or overview's stream while it is open, else the pane itself. */
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
 * becomes that stream and what was opened from it closes. Other panes stay. A
 * stream already open is brought forward instead.
 */
export function pickStream(page: StreamPage, streamId: string, parentOf: ParentOf): StreamPage {
  const { layout } = page
  if (panelIdsOf(layout).includes(streamId)) {
    const shown = activatePanelTab(layout, streamId)
    // Under another pane floating, it would stay out of reach.
    const reachable =
      shown.focused === undefined || shown.focused.includes(streamId) ? shown : { columns: shown.columns }
    return { layout: reachable, current: streamId }
  }
  const replaced = pageOfPane(page)
  const rest = panesOpenedFrom(layout, replaced, parentOf).reduce(closePanelTab, layout)
  return { layout: replacePanelTab(rest, replaced, streamId), current: streamId }
}

/**
 * Picks a stream or a workspace page from the sidebar, keeping the other panes: it takes the place of the pane
 * worked in, and one already open is brought forward. False where a row's link goes there on its own, as on a
 * phone, whose route goes there and drops its pane.
 */
function useStreamPicker(workspaceId: string): (streamId: string) => boolean {
  const navigate = useNavigate()
  const location = useLocation()
  const path = useMatch("/w/:workspaceId/s/:streamId")?.params.streamId
  const [searchParams] = useSearchParams()
  const { layout, hasTabs, phone, setCurrentPane, markCurrentPane, showPanes } = usePanel()
  const current = useCurrentPane()
  return useStableCallback((streamId: string) => {
    if (phone) return false
    const streams = indexStreams(getCachedWorkspaceTables(workspaceId).streams ?? [])
    const parentOf = (id: string) => streams.get(id)?.parentStreamId ?? null
    // A page's route stays put while the page is open, which only the pane system knows.
    if (!path || !isServerStreamId(streamId)) {
      const routePage = path ?? pagePaneAt(location.pathname)
      if (!hasTabs || routePage === null || (!isServerStreamId(streamId) && pagePathOf(streamId) === null)) return false
      showPanes(
        (now) => pickStream({ layout: now, current: current ?? routePage }, streamId, parentOf).layout,
        streamId
      )
      return true
    }
    const page = { layout, current: current ?? path }
    const next = pickStream(page, streamId, parentOf)
    // Moving to a pane already on show changes only which pane is worked in, which is no step in history.
    if (formatPanelLayout(next.layout) === formatPanelLayout(layout) && !searchParams.has("m")) {
      setCurrentPane(next.current)
      flashPane(next.current)
      return true
    }
    // A pick is a fresh look: a deep link, and anything else the route's stream carried once it is gone, stay behind.
    const params = panelIdsOf(next.layout).includes(path) ? new URLSearchParams(searchParams) : new URLSearchParams()
    params.delete("m")
    const value = formatPanelLayout(canonicalPanelLayout(next.layout, next.current))
    if (value) params.set(PANEL_PARAM, value)
    else params.delete(PANEL_PARAM)
    const query = params.toString()
    const url = `/w/${workspaceId}/s/${next.current}${query ? `?${readablePanelParam(query)}` : ""}`
    // The panes follow the route to the stream it names; setting one ahead of the URL would have a second quick pick
    // replace a tab not yet there. Marked, not set: setting also rewrites the entry this push leaves for Back.
    if (next.current === path) markCurrentPane(next.current)
    if (url !== `${location.pathname}${location.search}`) navigate(url)
    return true
  })
}

const StreamPickContext = createContext<((streamId: string) => boolean) | null>(null)

export function StreamPickProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const pick = useStreamPicker(workspaceId)
  return <StreamPickContext.Provider value={pick}>{children}</StreamPickContext.Provider>
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
