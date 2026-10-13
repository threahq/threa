import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react"
import { useSearchParams, useLocation, useMatch, useNavigationType } from "react-router-dom"
import { useCoverHistory } from "@/hooks/use-cover-close"
import { PANEL_COVER } from "@/lib/covers"
import {
  NO_PANELS,
  PANEL_PARAM,
  activatePanelTab,
  closePanelTab,
  focusPanelTab,
  followCurrentPanel,
  followPanel,
  formatPanelLayout,
  isPanelOnShow,
  newestPanelOf,
  openPanelTab,
  openPanelTabBeside,
  openPanelTabWith,
  panelIdsOf,
  parsePanelLayout,
  primaryPanelOf,
  replacePanelTab,
  splitPanelTab,
  type PanelLayout,
  type PanelSection,
  type SplitDirection,
} from "@/lib/panel-tabs"

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

/** A stream's draft, written in a pane of its own. One per stream: the stream's composer, shown there instead. */
const COMPOSE_PANEL_PREFIX = "compose:"

function isComposePanel(panelId: string): boolean {
  return panelId.startsWith(COMPOSE_PANEL_PREFIX)
}

/** The stream behind a `compose:<id>` panel, or null when it isn't one. */
export function parseComposePanel(panelId: string): string | null {
  if (!isComposePanel(panelId)) return null
  return panelId.slice(COMPOSE_PANEL_PREFIX.length) || null
}

export function createComposePanelId(streamId: string): string {
  return `${COMPOSE_PANEL_PREFIX}${streamId}`
}

/** A stream's "In this stream" overview, with its category filter when it has one: `context:<streamId>[:<filter>]`. */
const CONTEXT_PANEL_PREFIX = "context:"

/** The stream and filter behind a `context:` panel, or null when it isn't one. */
export function parseContextPanel(panelId: string): { streamId: string; filter: string | null } | null {
  if (!panelId.startsWith(CONTEXT_PANEL_PREFIX)) return null
  const [streamId, filter] = panelId.slice(CONTEXT_PANEL_PREFIX.length).split(":")
  if (!streamId) return null
  return { streamId, filter: filter || null }
}

export function createContextPanelId(streamId: string, filter: string | null = null): string {
  return filter ? `${CONTEXT_PANEL_PREFIX}${streamId}:${filter}` : `${CONTEXT_PANEL_PREFIX}${streamId}`
}

/** The open overview of `streamId`, whichever filter it shows. */
export function contextPanelOf(layout: PanelLayout, streamId: string): string | null {
  return panelIdsOf(layout).find((id) => parseContextPanel(id)?.streamId === streamId) ?? null
}

/** One stream has one overview, whichever filter it shows. */
export function paneIdentity(panelId: string): string {
  const context = parseContextPanel(panelId)
  return context ? createContextPanelId(context.streamId) : panelId
}

/** A pane that lists its stream rather than showing one: where it can't sit
 *  beside that stream (a phone, the board), it is a drawer over it. */
export function presentsAsDrawer(panelId: string): boolean {
  return parseContextPanel(panelId) !== null
}

/** The pane that shows `?m` set from `panelId`: a draft or an overview shows no
 *  messages of its own, so its stream does — main (null) unless it is a tab. */
export function coverPaneOf(layout: PanelLayout, panelId: string | null): string | null {
  if (panelId === null) return null
  const streamId = parseComposePanel(panelId) ?? parseContextPanel(panelId)?.streamId
  if (!streamId) return panelId
  return panelIdsOf(layout).includes(streamId) ? streamId : null
}

/** The panes that belong to a stream's own: its draft and its overview. */
function panesOwnedBy(layout: PanelLayout, streamId: string): string[] {
  return panelIdsOf(layout).filter(
    (id) => parseComposePanel(id) === streamId || parseContextPanel(id)?.streamId === streamId
  )
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
   *  tab's id; elsewhere, the first section's tab on show. Stream id or draft/conv panel id. */
  panelId: string | null
  /** The whole arrangement, as the URL has it. */
  layout: PanelLayout
  /** The section this consumer's tab shows in, as laid out on screen; elsewhere the first. */
  section: PanelSection | null
  /** Whether a panel is currently open */
  isPanelOpen: boolean
  /** Whether panels show their tab rows: more than one panel open, on a page that has tabs. */
  tabbed: boolean
  /** Whether this page lays panels out as tabs beside each other (the stream page). */
  hasTabs: boolean

  /** URL that opens a panel from here (for `<Link>`). On the stream page the main
   *  view adds or activates a tab of the first section and a tab opens it beside
   *  itself; pages without tabs swap the one panel. */
  getPanelUrl: (panelId: string) => string
  /** {@link getPanelUrl}, opening the panel floating over the rest. */
  getFocusedPanelUrl: (panelId: string) => string
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
  /** Reopen the tab on this page closed most recently and not open since, as a tab of the section
   *  worked in (the first section from the main view). */
  reopenTab: () => string | null
  /** Whether {@link reopenTab} has a tab to reopen. */
  canReopenTab: () => boolean
  /** Move a tab out of its section into a new one beside or below it. */
  splitTab: (panelId: string, direction: SplitDirection) => void
  /** Float a tab over the rest of the page, or put the floating one back with null. */
  focusTab: (panelId: string | null) => void
  /** The ways this consumer's tab can split off as it is laid out now. */
  splits: readonly SplitDirection[]
  /** Record the pane the user is working in: a panel id, or null for the main view. */
  setCurrentPane: (panelId: string | null) => void
  /** Whether `?m` is this panel's: it belongs to the pane that was in front
   *  when it was set, so a pane beside it doesn't look for it too. */
  ownsCover: boolean
}

interface PanelOps {
  layout: PanelLayout
  urlFor: (edit: (layout: PanelLayout) => PanelLayout, dropDeepLink?: boolean) => string
  open: (edit: (layout: PanelLayout) => PanelLayout, replace: boolean) => void
  /** Whether this page shows tabs (the stream page); elsewhere a second panel replaces the first. */
  tabbed: boolean
  /** Opening from `scopeId`'s tab, or the main view when null. */
  contextual: (layout: PanelLayout, panelId: string, scopeId: string | null) => PanelLayout
  closeTab: (panelId: string) => void
  reopenTab: (scopeId: string | null) => string | null
  canReopenTab: () => boolean
  splitTab: (panelId: string, direction: SplitDirection) => void
  focusTab: (panelId: string | null) => void
  setCurrentPane: (panelId: string | null) => void
  coverOwner: string | null
  tabFocusHandoff: MutableRefObject<string | null>
  paneShortcutQueue: MutableRefObject<PaneShortcutQueue>
  paneFocusLanding: MutableRefObject<number>
}

/**
 * Pane shortcuts pressed before the URL caught up with the last one, the URL
 * that one acted on, and since when the queue has been waiting. Held here
 * because the pane taking the shortcuts changes as the last tab closes or the
 * first one opens.
 */
export interface PaneShortcutQueue {
  navigatedFrom: string | null
  waitingSince: number
  pending: string[]
}

const PanelOpsContext = createContext<PanelOps | null>(null)
const PanelContext = createContext<PanelContextValue | null>(null)
const CurrentPaneContext = createContext<string | null>(null)
const FrontPanelContext = createContext<string | null>(null)

/** The `?m=` one tab opened at must not send another tab looking for it. */
function dropDeepLink(params: URLSearchParams) {
  params.delete("m")
}

/** The deep link stays with the tab it was opened in while that tab stays on show. */
function withLayout(params: URLSearchParams, layout: PanelLayout, coverOwner: string | null): URLSearchParams {
  const next = new URLSearchParams(params)
  if (coverOwner !== null && !isPanelOnShow(layout, coverOwner)) dropDeepLink(next)
  const value = formatPanelLayout(layout)
  if (value) next.set(PANEL_PARAM, value)
  else next.delete(PANEL_PARAM)
  return next
}

const NO_SPLITS: readonly SplitDirection[] = []

interface ClosedTab {
  path: string
  panelId: string
}
const MAX_CLOSED_TABS = 20

function buildValue(
  ops: PanelOps,
  scopeId: string | null,
  scopeSection: PanelSection | null,
  splits: readonly SplitDirection[] = NO_SPLITS,
  shownTabs: number = panelIdsOf(ops.layout).length
): PanelContextValue {
  const { layout } = ops
  const own = scopeId ?? primaryPanelOf(layout)
  const supersede = (current: PanelLayout, panelId: string) => {
    if (!own) return openPanelTab(current, panelId)
    // An overview lists its own stream, not whatever took that stream's tab.
    const overview = panelId === own ? null : contextPanelOf(current, own)
    const next = replacePanelTab(current, own, panelId)
    return overview ? closePanelTab(next, overview) : next
  }
  return {
    panelId: own,
    layout,
    section: scopeSection ?? layout.columns[0]?.[0] ?? null,
    isPanelOpen: own !== null,
    tabbed: ops.tabbed && shownTabs > 1,
    hasTabs: ops.tabbed,
    getPanelUrl: (panelId) => ops.urlFor((current) => ops.contextual(current, panelId, scopeId)),
    getFocusedPanelUrl: (panelId) =>
      ops.urlFor((current) => focusPanelTab(ops.contextual(current, panelId, scopeId), panelId)),
    openPanel: (panelId, options) =>
      options?.replace
        ? ops.open((current) => supersede(current, panelId), true)
        : ops.open((current) => ops.contextual(current, panelId, scopeId), false),
    withPanelOpen: (params, panelId) =>
      withLayout(params, ops.contextual(parsePanelLayout(params.get(PANEL_PARAM)), panelId, scopeId), ops.coverOwner),
    getNavigateUrl: (panelId) => ops.urlFor((current) => supersede(current, panelId)),
    // A switch from the owner's row covers it, even in a section folded on screen whose URL layout doesn't change.
    getTabUrl: (panelId) =>
      ops.urlFor(
        (current) => activatePanelTab(current, panelId),
        scopeId !== null && scopeId === ops.coverOwner && panelId !== scopeId
      ),
    closePanel: () => {
      if (own) ops.closeTab(own)
    },
    closeTab: ops.closeTab,
    reopenTab: () => ops.reopenTab(scopeId),
    canReopenTab: ops.canReopenTab,
    splitTab: ops.splitTab,
    focusTab: ops.focusTab,
    splits,
    setCurrentPane: ops.setCurrentPane,
    ownsCover: scopeId === null || scopeId === ops.coverOwner,
  }
}

interface PaneState {
  layout: PanelLayout
  deepLink: string | null
  /** The panel last worked in, kept while the main view is: it stays in front of a folded section. */
  front: string | null
  /** Whether the user is working in the main view rather than `front`. */
  inMain: boolean
  /** The tab `?m` belongs to, or null for the main view. */
  coverOwner: string | null
}

function followPanes(state: PaneState, layout: PanelLayout, deepLink: string | null, restored: boolean): PaneState {
  const moved = state.layout !== layout
  const focused = layout.focused !== state.layout.focused ? layout.focused : undefined
  const front = focused ?? (moved ? followCurrentPanel(state.layout, layout, state.front) : state.front)
  // Only a tab opening or floating takes the user out of the main view.
  const inMain =
    state.inMain && focused === undefined && (!moved || followCurrentPanel(state.layout, layout, null) === null)
  // Whoever sets `?m` owns it; clearing it hands nothing on, and otherwise it
  // stays with the pane it was set in. Back and Forward set nothing: the pane it
  // was set in is still the one following it.
  const set = !restored && deepLink !== null && deepLink !== state.deepLink
  let coverOwner = state.coverOwner
  if (set) coverOwner = inMain ? null : coverPaneOf(layout, front)
  else if (moved) coverOwner = followPanel(state.layout, layout, coverOwner)
  return { layout, deepLink, front, inMain, coverOwner }
}

interface PanelProviderProps {
  children: ReactNode
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const restored = useNavigationType() === "POP"
  // Only the stream page shows tabs. Elsewhere (the board) a second panel
  // replaces the first, as it always has.
  const tabbed = useMatch("/w/:workspaceId/s/:streamId") !== null

  const panelValue = searchParams.get(PANEL_PARAM)
  const layout = useMemo(() => parsePanelLayout(panelValue), [panelValue])

  const deepLink = searchParams.get("m")

  // The panes follow the arrangement in the same render, so a pane just opened
  // is in front on its first paint: a phone shows it, and a narrow window folding
  // it in with others brings it forward. Starting from the newest panel keeps a
  // reload showing what the URL's last open showed.
  const [paneState, setPaneState] = useState<PaneState>(() => {
    const front = layout.focused ?? newestPanelOf(layout)
    return { layout, deepLink, front, inMain: false, coverOwner: coverPaneOf(layout, front) }
  })
  let panes = paneState
  if (panes.layout !== layout || panes.deepLink !== deepLink) {
    panes = followPanes(panes, layout, deepLink, restored)
    setPaneState(panes)
  }
  const { coverOwner } = panes
  const current = panes.inMain ? null : panes.front
  const setCurrentPane = useCallback(
    (panelId: string | null) =>
      setPaneState((state) => {
        if (panelId === null) return state.inMain ? state : { ...state, inMain: true }
        return state.front === panelId && !state.inMain ? state : { ...state, front: panelId, inMain: false }
      }),
    []
  )

  const contextual = useCallback(
    (current: PanelLayout, panelId: string, scopeId: string | null) => {
      if (!tabbed) {
        // Without tabs a panel replaces the one open, except a drawer, which keeps its stream under it.
        const primary = primaryPanelOf(current)
        if (!presentsAsDrawer(panelId) || primary === null || presentsAsDrawer(primary)) {
          return openPanelTab(NO_PANELS, panelId)
        }
        return openPanelTabBeside(openPanelTab(NO_PANELS, primary), primary, panelId)
      }
      return scopeId ? openPanelTabBeside(current, scopeId, panelId) : openPanelTab(current, panelId)
    },
    [tabbed]
  )

  const urlFor = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, dropsDeepLink = false) => {
      const params = withLayout(searchParams, edit(layout), coverOwner)
      if (dropsDeepLink) dropDeepLink(params)
      return `${location.pathname}?${params.toString()}`
    },
    [searchParams, location.pathname, layout, coverOwner]
  )

  // Opening a panel PUSHES: on mobile it takes over the whole screen, so back has
  // to close it rather than leave the page. `<Link to={getPanelUrl(...)}>` (branch
  // rows, thread anchors) already pushed; this makes the imperative path match.
  const open = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, replace: boolean) => {
      setSearchParams((prev) => withLayout(prev, edit(parsePanelLayout(prev.get(PANEL_PARAM))), coverOwner), {
        replace,
      })
    },
    [setSearchParams, coverOwner]
  )

  const closedTabs = useRef<ClosedTab[]>([])
  const { close, closeTo } = useCoverHistory(PANEL_COVER)
  const closeTab = useCallback(
    (panelId: string) => {
      // A stream's draft and overview go with the stream: they are that stream's.
      const next = panesOwnedBy(layout, panelId).reduce(closePanelTab, closePanelTab(layout, panelId))
      if (next === layout) return
      // A draft's tab is gone with its draft, and a compose tab's draft is back
      // inline, so only real panels are remembered for reopening.
      if (!isDraftPanel(panelId) && !isComposePanel(panelId)) {
        const others = closedTabs.current.filter((tab) => tab.panelId !== panelId || tab.path !== location.pathname)
        closedTabs.current = [...others, { path: location.pathname, panelId }].slice(-MAX_CLOSED_TABS)
      }
      const value = formatPanelLayout(next)
      if (value === null) {
        close()
        return
      }
      const params = new URLSearchParams(searchParams)
      if (panelId === coverOwner) dropDeepLink(params)
      params.set(PANEL_PARAM, value)
      closeTo(params)
    },
    [close, closeTo, searchParams, layout, coverOwner, location.pathname]
  )

  const findReopenable = useCallback(() => {
    const shown = new Set(panelIdsOf(layout).map(paneIdentity))
    return [...closedTabs.current]
      .reverse()
      .find((closed) => closed.path === location.pathname && !shown.has(paneIdentity(closed.panelId)))
  }, [layout, location.pathname])
  const canReopenTab = useCallback(() => findReopenable() !== undefined, [findReopenable])

  const reopenTab = useCallback(
    (scopeId: string | null) => {
      const tab = findReopenable()
      if (!tab) return null
      closedTabs.current = closedTabs.current.filter((closed) => closed !== tab)
      open((current) => openPanelTabWith(current, scopeId, tab.panelId), false)
      setCurrentPane(tab.panelId)
      return tab.panelId
    },
    [findReopenable, open, setCurrentPane]
  )

  // Splitting rearranges what is already open, so it is not a step of its own in history.
  const splitTab = useCallback(
    (panelId: string, direction: SplitDirection) => {
      open((current) => splitPanelTab(current, panelId, direction), true)
      setCurrentPane(panelId)
    },
    [open, setCurrentPane]
  )

  // Focusing is a step of its own in history, so Back puts the tab back; putting
  // it back by hand pops that step rather than adding one.
  const focusTab = useCallback(
    (panelId: string | null) => {
      if (panelId !== null) {
        // A second press can land before the router commits the first, which already pushed this step.
        if (parsePanelLayout(new URLSearchParams(window.location.search).get(PANEL_PARAM)).focused === panelId) return
        open((current) => focusPanelTab(current, panelId), false)
        return
      }
      const next = focusPanelTab(layout, null)
      if (next === layout) return
      const value = formatPanelLayout(next)
      if (value === null) return
      const params = new URLSearchParams(searchParams)
      params.set(PANEL_PARAM, value)
      closeTo(params)
    },
    [open, closeTo, layout, searchParams]
  )

  const tabFocusHandoff = useRef<string | null>(null)
  const paneShortcutQueue = useRef<PaneShortcutQueue>({ navigatedFrom: null, waitingSince: 0, pending: [] })
  const paneFocusLanding = useRef(0)

  const ops = useMemo<PanelOps>(
    () => ({
      layout,
      urlFor,
      open,
      tabbed,
      contextual,
      closeTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      setCurrentPane,
      coverOwner,
      tabFocusHandoff,
      paneShortcutQueue,
      paneFocusLanding,
    }),
    [
      layout,
      urlFor,
      open,
      tabbed,
      contextual,
      closeTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      setCurrentPane,
      coverOwner,
    ]
  )
  const value = useMemo(() => buildValue(ops, null, null), [ops])

  return (
    <PanelOpsContext.Provider value={ops}>
      <PanelContext.Provider value={value}>
        <FrontPanelContext.Provider value={panes.front}>
          <CurrentPaneContext.Provider value={current}>{children}</CurrentPaneContext.Provider>
        </FrontPanelContext.Provider>
      </PanelContext.Provider>
    </PanelOpsContext.Provider>
  )
}

/**
 * Scopes everything inside to one of the panel's tabs: `usePanel().panelId` is
 * that tab even while another is on show, closing closes that tab, a superseding
 * open (`replace`) or in-place navigation swaps that tab, and opening a panel
 * opens it beside this one.
 */
export function PaneScope({
  panelId,
  section,
  splits,
  children,
}: {
  panelId: string
  section: PanelSection
  splits: readonly SplitDirection[]
  children: ReactNode
}) {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("PaneScope must be used within a PanelProvider")
  // A phone's drawer is no tab of the page under it, so it doesn't turn that page's header into a tab row.
  const displayed = useContext(DisplayedPanelLayoutContext)
  const shownTabs = panelIdsOf(displayed ?? ops.layout).length
  // Sections and split lists are rebuilt whenever the arrangement is laid out; only what they hold matters.
  const ids = section.ids.join(".")
  const { active } = section
  const directions = splits.join(".")
  const value = useMemo(
    () =>
      buildValue(
        ops,
        panelId,
        { ids: ids.split("."), active },
        directions ? (directions.split(".") as SplitDirection[]) : NO_SPLITS,
        shownTabs
      ),
    [ops, panelId, ids, active, directions, shownTabs]
  )
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

export function usePaneShortcutQueue(): MutableRefObject<PaneShortcutQueue> {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("usePaneShortcutQueue must be used within a PanelProvider")
  return ops.paneShortcutQueue
}

/**
 * The latest pane-shortcut focus landing. Landings outlive the shortcuts that
 * started them, so a newer one cancels the last through this counter.
 */
export function usePaneFocusLanding(): MutableRefObject<number> {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("usePaneFocusLanding must be used within a PanelProvider")
  return ops.paneFocusLanding
}

/** The pane the user is working in: an open panel's id, or null for the main view. */
export function useCurrentPane(): string | null {
  return useContext(CurrentPaneContext)
}

/** Whether `?m` belongs to the main view rather than an open panel. */
export function useMainOwnsCover(): boolean {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("useMainOwnsCover must be used within a PanelProvider")
  return ops.coverOwner === null
}

const InPaneDrawerContext = createContext(false)
export const InPaneDrawerProvider = InPaneDrawerContext.Provider
/** Whether this pane shows as a drawer over its stream rather than as a pane of the grid. */
export function useInPaneDrawer(): boolean {
  return useContext(InPaneDrawerContext)
}

const DisplayedPanelLayoutContext = createContext<PanelLayout | null>(null)

/** Where the screen arranges the tabs differently from the URL: a narrow window folds sections together. */
export const DisplayedPanelLayoutProvider = DisplayedPanelLayoutContext.Provider

/** The tabs as arranged on screen. */
export function useDisplayedPanelLayout(): PanelLayout {
  const { layout } = usePanel()
  return useContext(DisplayedPanelLayoutContext) ?? layout
}

/** The panel last worked in, even while the user is in the main view. */
export function useFrontPanel(): string | null {
  return useContext(FrontPanelContext)
}

export function usePanel(): PanelContextValue {
  const context = useContext(PanelContext)
  if (!context) {
    throw new Error("usePanel must be used within a PanelProvider")
  }
  return context
}
