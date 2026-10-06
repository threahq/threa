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

  /** URL that opens a panel from here (for `<Link>`). On the stream page the main
   *  view adds or activates a tab of the first section and a tab opens it beside
   *  itself; pages without tabs swap the one panel. */
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
  /** Reopen the tab on this page closed most recently and not open since, as a tab of the section
   *  worked in (the first section from the main view). */
  reopenTab: () => string | null
  /** Whether {@link reopenTab} has a tab to reopen. */
  canReopenTab: () => boolean
  /** Move a tab out of its section into a new one beside or below it. */
  splitTab: (panelId: string, direction: SplitDirection) => void
  /** The ways this consumer's tab can split off as it is laid out now. */
  splits: readonly SplitDirection[]
  /** Record the pane the user is working in: a panel id, or null for the main view. */
  setCurrentPane: (panelId: string | null) => void
  /** Whether `?context` and `?m` are this panel's: they belong to the pane that
   *  was in front when they were set, so a pane beside it doesn't open them too. */
  ownsCover: boolean
  /** Take `?context` and `?m` over from the pane that has them. */
  claimCover: () => void
}

interface PanelOps {
  layout: PanelLayout
  urlFor: (edit: (layout: PanelLayout) => PanelLayout, dropCover?: boolean) => string
  open: (edit: (layout: PanelLayout) => PanelLayout, replace: boolean) => void
  /** Whether this page shows tabs (the stream page); elsewhere a second panel replaces the first. */
  tabbed: boolean
  /** Opening from `scopeId`'s tab, or the main view when null. */
  contextual: (layout: PanelLayout, panelId: string, scopeId: string | null) => PanelLayout
  closeTab: (panelId: string) => void
  reopenTab: (scopeId: string | null) => string | null
  canReopenTab: () => boolean
  splitTab: (panelId: string, direction: SplitDirection) => void
  setCurrentPane: (panelId: string | null) => void
  coverOwner: string | null
  claimCover: (panelId: string) => void
  tabFocusHandoff: MutableRefObject<string | null>
  paneShortcutQueue: MutableRefObject<PaneShortcutQueue>
}

/**
 * Pane shortcuts pressed before the URL caught up with the last one, and the
 * URL that one acted on. Held here because the pane taking the shortcuts
 * changes as the last tab closes or the first one opens.
 */
export interface PaneShortcutQueue {
  navigatedFrom: string | null
  navigatedAt: number
  pending: string[]
}

const PanelOpsContext = createContext<PanelOps | null>(null)
const PanelContext = createContext<PanelContextValue | null>(null)
const CurrentPaneContext = createContext<string | null>(null)
const FrontPanelContext = createContext<string | null>(null)

function clearPanelCover(params: URLSearchParams) {
  for (const param of PANEL_COVER) params.delete(param)
}

/** The `?m=` one tab opened at must not send another tab looking for it. */
function dropDeepLink(params: URLSearchParams) {
  params.delete("m")
}

/**
 * The overview and deep link stay with the tab they were opened over while it
 * stays on show. An open that covers it, or one from the main view's overview,
 * starts the tab in front bare.
 */
function withLayout(params: URLSearchParams, layout: PanelLayout, coverOwner: string | null): URLSearchParams {
  const next = new URLSearchParams(params)
  if (coverOwner === null || !isPanelOnShow(layout, coverOwner)) {
    clearPanelCover(next)
    if (coverOwner !== null) dropDeepLink(next)
  }
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
  splits: readonly SplitDirection[] = NO_SPLITS
): PanelContextValue {
  const { layout } = ops
  const own = scopeId ?? primaryPanelOf(layout)
  const supersede = (current: PanelLayout, panelId: string) =>
    own ? replacePanelTab(current, own, panelId) : openPanelTab(current, panelId)
  return {
    panelId: own,
    layout,
    section: scopeSection ?? layout.columns[0]?.[0] ?? null,
    isPanelOpen: own !== null,
    tabbed: ops.tabbed && panelIdsOf(layout).length > 1,
    getPanelUrl: (panelId) => ops.urlFor((current) => ops.contextual(current, panelId, scopeId)),
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
    splits,
    setCurrentPane: ops.setCurrentPane,
    ownsCover: scopeId === null || scopeId === ops.coverOwner,
    claimCover: () => {
      if (scopeId) ops.claimCover(scopeId)
    },
  }
}

interface PaneState {
  layout: PanelLayout
  context: string | null
  deepLink: string | null
  /** The panel last worked in, kept while the main view is: it stays in front of a folded section. */
  front: string | null
  /** Whether the user is working in the main view rather than `front`. */
  inMain: boolean
  /** The tab `?context` and `?m` belong to, or null for the main view. */
  coverOwner: string | null
}

function followPanes(
  state: PaneState,
  layout: PanelLayout,
  context: string | null,
  deepLink: string | null,
  restored: boolean
): PaneState {
  const moved = state.layout !== layout
  const front = moved ? followCurrentPanel(state.layout, layout, state.front) : state.front
  // Only a tab opening takes the user out of the main view.
  const inMain = state.inMain && (!moved || followCurrentPanel(state.layout, layout, null) === null)
  // Whoever sets `?context` or `?m` owns both; clearing one hands nothing on, and
  // otherwise they stay with the pane they were set in. Back and Forward set
  // nothing: the pane they were set in is still the one following them.
  const set =
    !restored && ((context !== null && context !== state.context) || (deepLink !== null && deepLink !== state.deepLink))
  let coverOwner = state.coverOwner
  if (set) coverOwner = inMain ? null : front
  else if (moved) coverOwner = followPanel(state.layout, layout, coverOwner)
  return { layout, context, deepLink, front, inMain, coverOwner }
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

  const context = searchParams.get("context")
  const deepLink = searchParams.get("m")

  // The panes follow the arrangement in the same render, so a pane just opened
  // is in front on its first paint: a phone shows it, and a narrow window folding
  // it in with others brings it forward. Starting from the newest panel keeps a
  // reload showing what the URL's last open showed.
  const [paneState, setPaneState] = useState<PaneState>(() => {
    const front = newestPanelOf(layout)
    return { layout, context, deepLink, front, inMain: false, coverOwner: front }
  })
  let panes = paneState
  if (panes.layout !== layout || panes.context !== context || panes.deepLink !== deepLink) {
    panes = followPanes(panes, layout, context, deepLink, restored)
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
  const claimCover = useCallback(
    (panelId: string) =>
      setPaneState((state) => (state.coverOwner === panelId ? state : { ...state, coverOwner: panelId })),
    []
  )

  const contextual = useCallback(
    (current: PanelLayout, panelId: string, scopeId: string | null) => {
      if (!tabbed) return openPanelTab(NO_PANELS, panelId)
      return scopeId ? openPanelTabBeside(current, scopeId, panelId) : openPanelTab(current, panelId)
    },
    [tabbed]
  )

  const urlFor = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, dropCover = false) => {
      const params = withLayout(searchParams, edit(layout), coverOwner)
      if (dropCover) {
        params.delete("context")
        dropDeepLink(params)
      }
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
      const next = closePanelTab(layout, panelId)
      if (next === layout) return
      // A draft's tab is gone with its draft, so only real panels are remembered for reopening.
      if (!isDraftPanel(panelId)) {
        const others = closedTabs.current.filter((tab) => tab.panelId !== panelId || tab.path !== location.pathname)
        closedTabs.current = [...others, { path: location.pathname, panelId }].slice(-MAX_CLOSED_TABS)
      }
      const value = formatPanelLayout(next)
      if (value === null) {
        close()
        return
      }
      const params = new URLSearchParams(searchParams)
      if (panelId === coverOwner) {
        clearPanelCover(params)
        dropDeepLink(params)
      }
      params.set(PANEL_PARAM, value)
      closeTo(params)
    },
    [close, closeTo, searchParams, layout, coverOwner, location.pathname]
  )

  const findReopenable = useCallback(() => {
    const shown = new Set(panelIdsOf(layout))
    return [...closedTabs.current]
      .reverse()
      .find((closed) => closed.path === location.pathname && !shown.has(closed.panelId))
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

  const tabFocusHandoff = useRef<string | null>(null)
  const paneShortcutQueue = useRef<PaneShortcutQueue>({ navigatedFrom: null, navigatedAt: 0, pending: [] })

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
      setCurrentPane,
      coverOwner,
      claimCover,
      tabFocusHandoff,
      paneShortcutQueue,
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
      setCurrentPane,
      coverOwner,
      claimCover,
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
        directions ? (directions.split(".") as SplitDirection[]) : NO_SPLITS
      ),
    [ops, panelId, ids, active, directions]
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

/** The pane the user is working in: an open panel's id, or null for the main view. */
export function useCurrentPane(): string | null {
  return useContext(CurrentPaneContext)
}

/** Whether `?context` and `?m` belong to the main view rather than an open panel. */
export function useMainOwnsCover(): boolean {
  const ops = useContext(PanelOpsContext)
  if (!ops) throw new Error("useMainOwnsCover must be used within a PanelProvider")
  return ops.coverOwner === null
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
