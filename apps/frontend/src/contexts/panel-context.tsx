import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from "react"
import { useSearchParams, useLocation, useMatch } from "react-router-dom"
import { useCoverHistory } from "@/hooks/use-cover-close"
import { PANEL_COVER } from "@/lib/covers"
import {
  NO_PANEL_TABS,
  PANEL_PARAM,
  activatePanelTab,
  closePanelTab,
  formatPanelTabs,
  openPanelTab,
  parsePanelTabs,
  replacePanelTab,
  type PanelTabs,
} from "@/lib/panel-tabs"

/** Which pane the user most recently interacted with — drives "copy current link" (mod+L). */
export type FocusedPane = "main" | "panel"

/**
 * Check if a panel ID represents a draft thread
 */
export function isDraftPanel(panelId: string): boolean {
  return panelId.startsWith("draft:")
}

/**
 * Parse a draft panel id into its parent stream and anchor ids. `anchorId` is the
 * canonical id of the timeline item the draft thread hangs under — `msg_…` for a
 * message, `event_…` for a card (INV-2 prefix discriminates). The id is opaque:
 * message anchors produce byte-identical strings to before, so persisted panel
 * state migrates by construction. Returns null when not a draft panel.
 */
export function parseDraftPanel(panelId: string): { parentStreamId: string; anchorId: string } | null {
  if (!isDraftPanel(panelId)) return null
  const parts = panelId.split(":")
  if (parts.length !== 3) return null
  const [, parentStreamId, anchorId] = parts
  if (!parentStreamId || !anchorId) return null
  return { parentStreamId, anchorId }
}

/**
 * Create a draft panel id from a parent stream id and an anchor id (the canonical
 * id of the timeline item the thread hangs under).
 */
export function createDraftPanelId(parentStreamId: string, anchorId: string): string {
  return `draft:${parentStreamId}:${anchorId}`
}

/** A conversation panel (Mechanism B) opens a single conversation as a projection
 *  peer to a thread, keyed by its conversation id rather than a stream id. */
const CONVERSATION_PANEL_PREFIX = "conv:"

export function isConversationPanel(panelId: string): boolean {
  return panelId.startsWith(CONVERSATION_PANEL_PREFIX)
}

/** The conversation id behind a `conv:<id>` panel, or null when it isn't one. */
export function parseConversationPanel(panelId: string): string | null {
  if (!isConversationPanel(panelId)) return null
  const conversationId = panelId.slice(CONVERSATION_PANEL_PREFIX.length)
  return conversationId || null
}

export function createConversationPanelId(conversationId: string): string {
  return `${CONVERSATION_PANEL_PREFIX}${conversationId}`
}

export interface OpenPanelOptions {
  /** Overwrite the current history entry instead of adding one. Only for a panel
   *  that SUPERSEDES the open one — a draft thread promoted to its real stream —
   *  where going back would land on an id that no longer exists. The new id
   *  takes the superseded one's tab. */
  replace?: boolean
}

interface PanelContextValue {
  /** The panel this consumer belongs to: inside a {@link PaneScope}, that
   *  tab's id; elsewhere, the active tab's. Stream id or draft/conv panel id. */
  panelId: string | null
  /** Every open tab, in order. */
  panelIds: readonly string[]
  /** The tab the panel is showing. */
  activePanelId: string | null
  /** Whether a panel is currently open */
  isPanelOpen: boolean
  /** Whether the panel shows its tab row: more than one tab, on a page that has tabs. */
  tabbed: boolean

  /** URL that opens a panel from here (for `<Link>`): on the stream page it adds
   *  or activates a tab; pages without tabs swap the one panel. */
  getPanelUrl: (panelId: string) => string
  /** Imperative twin of {@link getPanelUrl}. */
  openPanel: (panelId: string, options?: OpenPanelOptions) => void
  /** {@link openPanel} as a params edit, for a navigation that changes more than the panel. */
  withPanelOpen: (params: URLSearchParams, panelId: string) => URLSearchParams
  /** URL that shows `panelId` in this panel's own tab instead (breadcrumbs). */
  getNavigateUrl: (panelId: string) => string
  /** URL that brings an open tab to the front. Switching tabs is not a step of
   *  its own in history, so its link replaces. */
  getTabUrl: (panelId: string) => string
  /** Close this consumer's panel tab. */
  closePanel: () => void
  closeTab: (panelId: string) => void

  /** Record which pane the user is interacting with (main view vs thread panel). */
  setFocusedPane: (pane: FocusedPane) => void
  /** Read the most recently focused pane. Defaults to "main". */
  getFocusedPane: () => FocusedPane
}

interface PanelOps {
  tabs: PanelTabs
  urlFor: (edit: (tabs: PanelTabs) => PanelTabs) => string
  tabUrl: (panelId: string) => string
  open: (edit: (tabs: PanelTabs) => PanelTabs, replace: boolean) => void
  /** Whether this page shows tabs (the stream page); elsewhere a second panel replaces the first. */
  tabbed: boolean
  /** Opening from here: a tab on the stream page, the one panel elsewhere. */
  contextual: (tabs: PanelTabs, panelId: string) => PanelTabs
  closeTab: (panelId: string) => void
  setFocusedPane: (pane: FocusedPane) => void
  getFocusedPane: () => FocusedPane
  tabFocusHandoff: MutableRefObject<string | null>
}

const PanelOpsContext = createContext<PanelOps | null>(null)
const PanelContext = createContext<PanelContextValue | null>(null)

/** A newly opened panel starts bare: the old panel's (or the page's) overview must not reopen over it. */
function clearPanelCover(params: URLSearchParams) {
  for (const param of PANEL_COVER) params.delete(param)
}

/** A tab switch or close is not a deep link: the `?m=` one tab opened at must not
 *  send the tab coming to the front looking for it. */
function dropDeepLink(params: URLSearchParams) {
  params.delete("m")
}

function withTabs(params: URLSearchParams, tabs: PanelTabs): URLSearchParams {
  const next = new URLSearchParams(params)
  clearPanelCover(next)
  const value = formatPanelTabs(tabs)
  if (value) next.set(PANEL_PARAM, value)
  return next
}

function buildValue(ops: PanelOps, scopeId: string | null): PanelContextValue {
  const { tabs } = ops
  const own = scopeId ?? tabs.active
  const supersede = (current: PanelTabs, panelId: string) =>
    own ? replacePanelTab(current, own, panelId) : openPanelTab(current, panelId)
  return {
    panelId: own,
    panelIds: tabs.ids,
    activePanelId: tabs.active,
    isPanelOpen: tabs.active !== null,
    tabbed: ops.tabbed && tabs.ids.length > 1,
    getPanelUrl: (panelId) => ops.urlFor((current) => ops.contextual(current, panelId)),
    openPanel: (panelId, options) =>
      options?.replace
        ? ops.open((current) => supersede(current, panelId), true)
        : ops.open((current) => ops.contextual(current, panelId), false),
    withPanelOpen: (params, panelId) =>
      withTabs(params, ops.contextual(parsePanelTabs(params.get(PANEL_PARAM)), panelId)),
    getNavigateUrl: (panelId) => ops.urlFor((current) => supersede(current, panelId)),
    getTabUrl: ops.tabUrl,
    closePanel: () => {
      if (own) ops.closeTab(own)
    },
    closeTab: ops.closeTab,
    setFocusedPane: ops.setFocusedPane,
    getFocusedPane: ops.getFocusedPane,
  }
}

interface PanelProviderProps {
  children: ReactNode
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  // Only the stream page shows tabs. Elsewhere (the board) a second panel
  // replaces the first, as it always has.
  const tabbed = useMatch("/w/:workspaceId/s/:streamId") !== null

  const panelValue = searchParams.get(PANEL_PARAM)
  const tabs = useMemo(() => parsePanelTabs(panelValue), [panelValue])

  const contextual = useCallback(
    (current: PanelTabs, panelId: string) => openPanelTab(tabbed ? current : NO_PANEL_TABS, panelId),
    [tabbed]
  )

  const urlFor = useCallback(
    (edit: (tabs: PanelTabs) => PanelTabs) => `${location.pathname}?${withTabs(searchParams, edit(tabs)).toString()}`,
    [searchParams, location.pathname, tabs]
  )

  const tabUrl = useCallback(
    (panelId: string) => {
      // The overview belongs to the tab on show, so it stays behind with the tab it covered.
      const params = withTabs(searchParams, activatePanelTab(tabs, panelId))
      dropDeepLink(params)
      return `${location.pathname}?${params.toString()}`
    },
    [searchParams, location.pathname, tabs]
  )

  // Opening a panel PUSHES: on mobile it takes over the whole screen, so back has
  // to close it rather than leave the page. `<Link to={getPanelUrl(...)}>` (branch
  // rows, thread anchors) already pushed; this makes the imperative path match.
  const open = useCallback(
    (edit: (tabs: PanelTabs) => PanelTabs, replace: boolean) => {
      setSearchParams((prev) => withTabs(prev, edit(parsePanelTabs(prev.get(PANEL_PARAM)))), { replace })
    },
    [setSearchParams]
  )

  const { close, closeTo } = useCoverHistory(PANEL_COVER)
  const closeTab = useCallback(
    (panelId: string) => {
      if (!tabs.ids.includes(panelId)) return
      const next = closePanelTab(tabs, panelId)
      if (next.active === null) {
        close()
        return
      }
      const params = new URLSearchParams(searchParams)
      // The overview belongs to the tab on show; a tab closing behind it leaves it be.
      if (panelId === tabs.active) {
        clearPanelCover(params)
        dropDeepLink(params)
      }
      params.set(PANEL_PARAM, formatPanelTabs(next)!)
      closeTo(params)
    },
    [close, closeTo, searchParams, tabs]
  )

  // Tracked via a ref, not state: only the copy-link shortcut reads it (on
  // keypress), so updating it on every click/focus must not re-render panel
  // consumers. Seed from the initial URL so a deep link that opens a panel
  // (which then autofocuses) reports the panel before any pointer interaction.
  const focusedPaneRef = useRef<FocusedPane>(tabs.active !== null ? "panel" : "main")
  const setFocusedPane = useCallback((pane: FocusedPane) => {
    focusedPaneRef.current = pane
  }, [])
  const getFocusedPane = useCallback(() => focusedPaneRef.current, [])

  // When the panel closes, focus belongs to the main pane again.
  useEffect(() => {
    if (tabs.active === null) focusedPaneRef.current = "main"
  }, [tabs.active])

  const tabFocusHandoff = useRef<string | null>(null)

  const ops = useMemo<PanelOps>(
    () => ({
      tabs,
      urlFor,
      tabUrl,
      open,
      tabbed,
      contextual,
      closeTab,
      setFocusedPane,
      getFocusedPane,
      tabFocusHandoff,
    }),
    [tabs, urlFor, tabUrl, open, tabbed, contextual, closeTab, setFocusedPane, getFocusedPane]
  )
  const value = useMemo(() => buildValue(ops, null), [ops])

  return (
    <PanelOpsContext.Provider value={ops}>
      <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
    </PanelOpsContext.Provider>
  )
}

/**
 * Scopes everything inside to one of the panel's tabs: `usePanel().panelId` is
 * that tab even while another is on show, closing closes that tab, and a
 * superseding open (`replace`) or in-place navigation swaps that tab.
 */
export function PaneScope({ panelId, children }: { panelId: string; children: ReactNode }) {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("PaneScope must be used within a PanelProvider")
  const value = useMemo(() => buildValue(ops, panelId), [ops, panelId])
  return <PanelContext.Provider value={value}>{children}</PanelContext.Provider>
}

/**
 * Every tab renders its own row, so switching or closing from the keyboard
 * leaves focus in a row that just went inert or unmounted. The tab that ends up
 * on show is recorded here, and its row takes focus once it is uncovered.
 */
export function usePanelTabFocusHandoff(): MutableRefObject<string | null> {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("usePanelTabFocusHandoff must be used within a PanelProvider")
  return ops.tabFocusHandoff
}

export function usePanel(): PanelContextValue {
  const context = useContext(PanelContext)
  if (!context) {
    throw new Error("usePanel must be used within a PanelProvider")
  }
  return context
}
