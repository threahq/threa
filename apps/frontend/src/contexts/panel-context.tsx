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
import {
  matchPath,
  UNSAFE_DataRouterContext,
  useSearchParams,
  useLocation,
  useMatch,
  useNavigate,
  useNavigationType,
} from "react-router-dom"
import { useCoverHistory, type CoverLanding } from "@/hooks/use-cover-close"
import { useIsMobile } from "@/hooks/use-mobile"
import { PANEL_COVER } from "@/lib/covers"
import { isPagePane, isServerStreamId } from "@/lib/stream-ids"
import {
  PANEL_PARAM,
  activatePanelTab,
  canonicalPanelLayout,
  closePanelTab,
  focusPanelTab,
  followCurrentPanel,
  firstColumnHolds,
  phonePanelRoute,
  followPanel,
  formatPanelLayout,
  fullPanelLayout,
  isPanelOnShow,
  newestPanelOf,
  openPanelTab,
  openPanelTabBeside,
  openPanelTabWith,
  panelIdsOf,
  parsePanelLayout,
  primaryPanelOf,
  replacePanelTab,
  soleFirstPanelOf,
  splitPanelTab,
  dropPanelTab,
  streamPaneAfter,
  type PaneDrop,
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

/** A stream's conversations list, in a pane of its own: `convs:<streamId>`. */
const CONVERSATIONS_PANEL_PREFIX = "convs:"

/** The stream behind a `convs:<id>` panel, or null when it isn't one. */
export function parseConversationsPanel(panelId: string): string | null {
  if (!panelId.startsWith(CONVERSATIONS_PANEL_PREFIX)) return null
  return panelId.slice(CONVERSATIONS_PANEL_PREFIX.length) || null
}

export function createConversationsPanelId(streamId: string): string {
  return `${CONVERSATIONS_PANEL_PREFIX}${streamId}`
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

/** A persona's draft test chat, a pane beside its editor: `test:<personaId>`. */
const PERSONA_TEST_PANEL_PREFIX = "test:"

/** The persona behind a `test:` panel, or null when it isn't one. */
export function parsePersonaTestPanel(panelId: string): string | null {
  if (!panelId.startsWith(PERSONA_TEST_PANEL_PREFIX)) return null
  return panelId.slice(PERSONA_TEST_PANEL_PREFIX.length) || null
}

export function createPersonaTestPanelId(personaId: string): string {
  return `${PERSONA_TEST_PANEL_PREFIX}${personaId}`
}

/** One stream has one overview, whichever filter it shows. */
export function paneIdentity(panelId: string): string {
  const context = parseContextPanel(panelId)
  return context ? createContextPanelId(context.streamId) : panelId
}

/** A pane that lists its stream rather than showing one: where it can't sit
 *  beside that stream (a phone), it is a drawer over it. */
export function presentsAsDrawer(panelId: string): boolean {
  return parseContextPanel(panelId) !== null
}

/** The pane that shows `?m` set from `panelId`: a draft, an overview or a
 *  conversations list shows no messages of its own, so its stream does while
 *  that stream is open. */
export function coverPaneOf(layout: PanelLayout, panelId: string): string {
  const streamId =
    parseComposePanel(panelId) ?? parseContextPanel(panelId)?.streamId ?? parseConversationsPanel(panelId)
  if (!streamId) return panelId
  return panelIdsOf(layout).includes(streamId) ? streamId : panelId
}

/** The panes that belong to a stream's own: its draft, its overview and its conversations. */
function panesOwnedBy(layout: PanelLayout, streamId: string): string[] {
  return panelIdsOf(layout).filter(
    (id) =>
      parseComposePanel(id) === streamId ||
      parseContextPanel(id)?.streamId === streamId ||
      parseConversationsPanel(id) === streamId
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
  /** The pane this consumer belongs to: inside a {@link PaneScope}, that
   *  tab's id; elsewhere, the first section's tab on show. Stream id or draft/conv panel id. */
  panelId: string | null
  /** The whole arrangement: on the stream page, the route's stream pane with `?panel=`'s. */
  layout: PanelLayout
  /** The section this consumer's tab shows in, as laid out on screen; elsewhere the first. */
  section: PanelSection | null
  /** Whether panels show their tab rows: more than one tab open beside the page's own stream, on a page that has tabs. */
  tabbed: boolean
  /** Whether this page lays panels out as tabs beside its route's pane (the stream page, the board, the persona editor). */
  hasTabs: boolean
  /** Whether this consumer's pane sits in the stream page's first column, where the page's stream shows. */
  inFirstColumn: boolean
  /** Whether closing this consumer's pane would close it: the last stream pane of the page stays. */
  canClosePanel: boolean

  /** URL that opens a panel from here (for `<Link>`), as a tab beside this pane. */
  getPanelUrl: (panelId: string) => string
  /** {@link getPanelUrl}, opening the panel floating over the rest. */
  getFocusedPanelUrl: (panelId: string) => string
  /** Imperative twin of {@link getPanelUrl}. */
  openPanel: (panelId: string, options?: OpenPanelOptions) => void
  /** Opens `streamId` as {@link openPanel} does, at `messageId`, and works in it. `closeOwn`
   *  closes this consumer's pane in the same step, for a drawer over that stream. */
  openAtMessage: (streamId: string, messageId: string, closeOwn: boolean) => void
  /** URL that shows `panelId` in this panel's own tab instead (breadcrumbs). */
  getNavigateUrl: (panelId: string) => string
  /** URL that brings an open tab to the front and works in it. Switching tabs is not a step of
   *  its own in history, so its link replaces. */
  getTabUrl: (panelId: string) => string
  /** Close this consumer's panel tab. */
  closePanel: () => void
  closeTab: (panelId: string) => void
  /** Whether {@link closeTab} would close `panelId`. */
  canCloseTab: (panelId: string) => boolean
  /** Reopen the tab closed most recently and not open since, as a tab of the section worked in. */
  reopenTab: () => string | null
  /** Whether {@link reopenTab} has a tab to reopen. */
  canReopenTab: () => boolean
  /** Move a tab out of its section into a new one beside or below it. */
  splitTab: (panelId: string, direction: SplitDirection) => void
  /** Float a tab over the rest of the page, or put the floating one back with null. */
  focusTab: (panelId: string | null) => void
  /** Put a dragged tab or stream where it was dropped, and work in it there. */
  dropTab: (panelId: string, drop: PaneDrop) => void
  /** The ways this consumer's tab can split off as it is laid out now. */
  splits: readonly SplitDirection[]
  /** Record the pane the user is working in. A stream pane becomes the route's stream. */
  setCurrentPane: (panelId: string) => void
  /** {@link setCurrentPane} without touching the URL, for a caller navigating there itself. */
  markCurrentPane: (panelId: string) => void
  /** Whether `?m` is this panel's: it belongs to the pane that was in front
   *  when it was set, so a pane beside it doesn't look for it too. */
  ownsCover: boolean
}

interface PanelOps {
  layout: PanelLayout
  urlFor: (edit: (layout: PanelLayout) => PanelLayout, dropDeepLink?: boolean, focus?: string | null) => string
  /** Commits `edit`, working in `focus` when given, with `?m=deepLink` when given. */
  open: (
    edit: (layout: PanelLayout) => PanelLayout,
    replace: boolean,
    focus?: string | null,
    deepLink?: string | null
  ) => void
  /** Whether this page shows tabs beside its route's pane; no other page has panes. */
  tabbed: boolean
  /** A phone, which shows one pane at a time and no tab rows. */
  phone: boolean
  /** Opening from `scopeId`'s tab, or beside the route's stream when null. */
  contextual: (layout: PanelLayout, panelId: string, scopeId: string | null) => PanelLayout
  closeTab: (panelId: string) => void
  canCloseTab: (panelId: string) => boolean
  reopenTab: (scopeId: string | null) => string | null
  canReopenTab: () => boolean
  splitTab: (panelId: string, direction: SplitDirection) => void
  focusTab: (panelId: string | null) => void
  dropTab: (panelId: string, drop: PaneDrop) => void
  setCurrentPane: (panelId: string) => void
  markCurrentPane: (panelId: string) => void
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

/** The `?m=` one tab opened at must not send another tab looking for it. */
function dropDeepLink(params: URLSearchParams) {
  params.delete("m")
}

function setLayoutParam(params: URLSearchParams, layout: PanelLayout, path: string | null, keepPath = false) {
  const value = formatPanelLayout(canonicalPanelLayout(layout, path, keepPath))
  if (value) params.set(PANEL_PARAM, value)
  else params.delete(PANEL_PARAM)
}

/** The deep link stays with the tab it was opened in while that tab stays on show. */
function withLayout(
  params: URLSearchParams,
  layout: PanelLayout,
  path: string | null,
  coverOwner: string | null,
  keepPath = false
): URLSearchParams {
  const next = new URLSearchParams(params)
  if (coverOwner !== null && !isPanelOnShow(layout, coverOwner)) dropDeepLink(next)
  setLayoutParam(next, layout, path, keepPath)
  return next
}

function hrefOf(pathname: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

const NO_SPLITS: readonly SplitDirection[] = []

const STREAM_ROUTE = "/w/:workspaceId/s/:streamId"

const BOARD_ROUTE = "/w/:workspaceId/board"

/** The board, as the pane its route pins in the first column. */
export const BOARD_PANE = "page:board"

const PERSONA_ROUTE = "/w/:workspaceId/settings/personas/:personaId"

/** The persona editor, as the pane its route pins in the first column. */
export const PERSONA_PANE = "page:persona"

/** `layout` without a persona's test chat, except `keep`'s: one sits beside its own persona's editor only. */
function withoutForeignPersonaTests(layout: PanelLayout, keep: string | null): PanelLayout {
  return panelIdsOf(layout)
    .filter((id) => id !== keep && parsePersonaTestPanel(id) !== null)
    .reduce(closePanelTab, layout)
}

const MAX_CLOSED_TABS = 20

const PANE_SWITCH_STATE = { paneSwitch: true }

/** Whether a navigation only moved the route to another open pane, leaving every pane's URL state as it was. */
export function isPaneSwitch(state: unknown): boolean {
  return (state as typeof PANE_SWITCH_STATE | null)?.paneSwitch === true
}

function buildValue(
  ops: PanelOps,
  scopeId: string | null,
  scopeSection: PanelSection | null,
  splits: readonly SplitDirection[] = NO_SPLITS,
  shownTabs: number = panelIdsOf(ops.layout).length
): PanelContextValue {
  const { layout } = ops
  const own = scopeId ?? primaryPanelOf(layout)
  const sole = ops.tabbed ? soleFirstPanelOf(layout) : null
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
    tabbed: ops.tabbed && !ops.phone && own !== sole && shownTabs - (sole === null ? 0 : 1) > 1,
    hasTabs: ops.tabbed,
    inFirstColumn: ops.tabbed && own !== null && firstColumnHolds(layout, own),
    canClosePanel: own !== null && ops.canCloseTab(own),
    getPanelUrl: (panelId) => ops.urlFor((current) => ops.contextual(current, panelId, scopeId)),
    getFocusedPanelUrl: (panelId) =>
      ops.urlFor((current) => focusPanelTab(ops.contextual(current, panelId, scopeId), panelId)),
    openPanel: (panelId, options) =>
      options?.replace
        ? ops.open((current) => supersede(current, panelId), true)
        : ops.open((current) => ops.contextual(current, panelId, scopeId), false),
    openAtMessage: (streamId, messageId, closeOwn) =>
      ops.open(
        (current) => {
          const opened = ops.contextual(current, streamId, scopeId)
          return closeOwn && own ? closePanelTab(opened, own) : opened
        },
        false,
        streamId,
        messageId
      ),
    getNavigateUrl: (panelId) => ops.urlFor((current) => supersede(current, panelId)),
    // A switch from the owner's row covers it, even in a section folded on screen whose URL layout doesn't change.
    getTabUrl: (panelId) =>
      ops.urlFor(
        (current) => activatePanelTab(current, panelId),
        scopeId !== null && scopeId === ops.coverOwner && panelId !== scopeId,
        panelId
      ),
    closePanel: () => {
      if (own) ops.closeTab(own)
    },
    closeTab: ops.closeTab,
    canCloseTab: ops.canCloseTab,
    reopenTab: () => ops.reopenTab(scopeId),
    canReopenTab: ops.canReopenTab,
    splitTab: ops.splitTab,
    focusTab: ops.focusTab,
    dropTab: ops.dropTab,
    splits,
    setCurrentPane: ops.setCurrentPane,
    markCurrentPane: ops.markCurrentPane,
    ownsCover: own !== null && own === ops.coverOwner,
  }
}

/** Where a phone's reload or Back lands: the route's stream when `?panel=` writes it, else the newest pane, as links written before did. */
function phoneLandingOf(layout: PanelLayout, panelValue: string | null, path: string | null): string | null {
  if (layout.focused !== undefined) return layout.focused
  if (path !== null && panelIdsOf(parsePanelLayout(panelValue)).includes(path)) return path
  return newestPanelOf(layout)
}

interface PaneState {
  layout: PanelLayout
  path: string | null
  deepLink: string | null
  /** The pane the user is working in: it stays in front of a folded section. */
  front: string | null
  /** The pane `?m` belongs to. */
  coverOwner: string | null
}

function followPanes(
  state: PaneState,
  layout: PanelLayout,
  path: string | null,
  deepLink: string | null,
  restored: boolean,
  /** Where a phone lands on this URL; undefined off a phone. */
  phoneLanding: string | null | undefined
): PaneState {
  const moved = state.layout !== layout
  const focused = layout.focused !== state.layout.focused ? layout.focused : undefined
  const followed = moved ? followCurrentPanel(state.layout, layout, state.front) : state.front
  // Back and Forward restore the pane the route named; a phone lands where a reload of the URL does. Otherwise a
  // tab just opened is worked in, else a route moved to another stream is, unless a phone's route moved only
  // because the pane in front is no stream.
  const opened = panelIdsOf(layout).length > panelIdsOf(state.layout).length && !restored
  const named = path !== null && path !== state.path && !opened && (phoneLanding === undefined || phoneLanding === path)
  const front = focused ?? (restored && phoneLanding !== undefined ? phoneLanding : null) ?? (named ? path : followed)
  // Whoever sets `?m` owns it; clearing it hands nothing on, and otherwise it
  // stays with the pane it was set in. Back and Forward set nothing: the pane it
  // was set in is still the one following it.
  const set = !restored && deepLink !== null && deepLink !== state.deepLink
  let coverOwner = state.coverOwner
  if (set && front !== null) coverOwner = coverPaneOf(layout, front)
  else if (moved && coverOwner !== null) coverOwner = followPanel(state.layout, layout, coverOwner)
  return { layout, path, deepLink, front, coverOwner }
}

interface PanelProviderProps {
  children: ReactNode
}

interface Target {
  pathname: string
  path: string | null
  /** A phone is working in the stream `path` names, which `?panel=` then writes out. */
  keepsPath: boolean
}

export function PanelProvider({ children }: PanelProviderProps) {
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const restored = useNavigationType() === "POP"
  // A page whose route pins a pane in the first column shows tabs beside it: the stream page, whose route
  // names the stream pane worked in, and the board and the persona editor, which stay put. No other page has panes.
  const router = useContext(UNSAFE_DataRouterContext)?.router ?? null
  const match = useMatch(STREAM_ROUTE)
  const workspaceId = match?.params.workspaceId
  const path = match?.params.streamId ?? null
  const board = useMatch(BOARD_ROUTE)
  const personaId = useMatch(PERSONA_ROUTE)?.params.personaId
  const personaTest = personaId ? createPersonaTestPanelId(personaId) : null
  let pagePane: string | null = null
  if (board) pagePane = BOARD_PANE
  else if (personaTest) pagePane = PERSONA_PANE
  const routePane = path ?? pagePane
  const tabbed = routePane !== null

  const panelValue = searchParams.get(PANEL_PARAM)
  const layout = useMemo(
    () => fullPanelLayout(routePane, withoutForeignPersonaTests(parsePanelLayout(panelValue), personaTest)),
    [routePane, panelValue, personaTest]
  )

  const deepLink = searchParams.get("m")

  // The panes follow the arrangement in the same render, so a pane just opened
  // is in front on its first paint: a phone shows it, and a narrow window folding
  // it in with others brings it forward. Starting from the newest panel keeps a
  // reload showing what the URL's last open showed.
  const phone = useIsMobile()
  const [paneState, setPaneState] = useState<PaneState>(() => {
    // The route names the pane worked in, and a reloaded `?m` goes to the newest pane, as links already written
    // expect. A phone, which shows one pane, lands as {@link phoneLandingOf} says, and so does its `?m`.
    const newest = layout.focused ?? newestPanelOf(layout)
    const front = phone
      ? phoneLandingOf(layout, panelValue, path)
      : (layout.focused ?? (path === null ? newest : followPanel(layout, layout, path)))
    const owner = phone ? front : newest
    return { layout, path, deepLink, front, coverOwner: owner === null ? null : coverPaneOf(layout, owner) }
  })
  let panes = paneState
  if (panes.layout !== layout || panes.deepLink !== deepLink) {
    panes = followPanes(
      panes,
      layout,
      path,
      deepLink,
      restored,
      phone ? phoneLandingOf(layout, panelValue, path) : undefined
    )
    setPaneState(panes)
  }
  const { coverOwner, front } = panes
  const setFront = useCallback(
    (panelId: string) => setPaneState((state) => (state.front === panelId ? state : { ...state, front: panelId })),
    []
  )

  // Where the page lands with `next`: the stream pane worked in after it (a tab just opened, or the one
  // taking the current pane's place), else the one taking the route's place when it closes.
  const targetOf = useCallback(
    (next: PanelLayout, focus: string | null = null): Target | null => {
      if (path === null) return { pathname: location.pathname, path: pagePane, keepsPath: false }
      const current = focus ?? followCurrentPanel(layout, next, front)
      const after = streamPaneAfter(layout, next, path, front)
      const focusable = current !== null && isServerStreamId(current) && panelIdsOf(next).includes(current)
      const route = phone
        ? phonePanelRoute(next, current, after)
        : { path: focusable ? current : after, keepPath: false }
      if (route.path === null) return null
      return {
        pathname: route.path === path ? location.pathname : `/w/${workspaceId}/s/${route.path}`,
        path: route.path,
        keepsPath: route.keepPath,
      }
    },
    [path, pagePane, layout, front, location.pathname, workspaceId, phone]
  )

  // Every stream pane of `next` can be the route's and show the same panes, so closing pops onto any of them.
  const landingsOf = useCallback(
    (next: PanelLayout, to: Target, params: URLSearchParams): [CoverLanding, ...CoverLanding[]] => {
      const landing = (pathname: string, path: string | null, keepPath: boolean) => {
        const landed = new URLSearchParams(params)
        setLayoutParam(landed, next, path, keepPath)
        return { pathname, params: landed }
      }
      const others = path === null ? [] : panelIdsOf(next).filter((id) => id !== to.path && isServerStreamId(id))
      return [
        landing(to.pathname, to.path, to.keepsPath),
        ...others.map((id) =>
          landing(`/w/${workspaceId}/s/${id}`, id, phone && phonePanelRoute(next, id, id).keepPath)
        ),
      ]
    },
    [path, workspaceId, phone]
  )

  const setCurrentPane = useCallback(
    (panelId: string) => {
      setFront(panelId)
      // The router commits a navigation in a transition, so a click can land while this render still shows
      // the layout before it; rewriting from that would undo the open, drop or move that just happened. This
      // move commits at once for the same reason: typing straight after it would starve its transition, and
      // anything done to the panes meanwhile would act on the route before it.
      const live = router?.state.location ?? location
      const livePath = matchPath(STREAM_ROUTE, live.pathname)?.params.streamId ?? null
      const liveParams = new URLSearchParams(live.search)
      const liveLayout = fullPanelLayout(livePath, parsePanelLayout(liveParams.get(PANEL_PARAM)))
      if (livePath === null || !panelIdsOf(liveLayout).includes(panelId)) return
      // A phone also writes which pane it is in front of the others, so a reload or Back lands on it.
      if (!phone && (panelId === livePath || !isServerStreamId(panelId))) return
      const shown = phone ? activatePanelTab(liveLayout, panelId) : liveLayout
      const route = phone ? phonePanelRoute(shown, panelId, livePath) : { path: panelId, keepPath: false }
      const to = route.path ?? livePath
      const params = withLayout(liveParams, shown, to, coverOwner, route.keepPath)
      const href = hrefOf(`/w/${workspaceId}/s/${to}`, params)
      if (href === hrefOf(live.pathname, liveParams)) return
      navigate(href, { replace: true, flushSync: true, state: PANE_SWITCH_STATE })
    },
    [setFront, router, location, coverOwner, navigate, workspaceId, phone]
  )

  const contextual = useCallback(
    (current: PanelLayout, panelId: string, scopeId: string | null) =>
      openPanelTabBeside(current, scopeId ?? routePane, panelId),
    [routePane]
  )

  const urlFor = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, dropsDeepLink = false, focus: string | null = null) => {
      const next = edit(layout)
      const to = targetOf(next, focus)
      if (to === null) return `${location.pathname}${location.search}`
      const params = withLayout(searchParams, next, to.path, coverOwner, to.keepsPath)
      if (dropsDeepLink) dropDeepLink(params)
      return hrefOf(to.pathname, params)
    },
    [searchParams, location.pathname, location.search, layout, coverOwner, targetOf]
  )

  // Opening a panel PUSHES: on mobile it takes over the whole screen, so back has
  // to close it rather than leave the page. `<Link to={getPanelUrl(...)}>` (branch
  // rows, thread anchors) already pushed; this makes the imperative path match.
  const open = useCallback(
    (
      edit: (layout: PanelLayout) => PanelLayout,
      replace: boolean,
      focus: string | null = null,
      deepLink: string | null = null
    ) => {
      const next = edit(layout)
      const to = targetOf(next, focus)
      if (to === null) return
      if (focus !== null) setFront(focus)
      const params = withLayout(searchParams, next, to.path, coverOwner, to.keepsPath)
      if (deepLink !== null) params.set("m", deepLink)
      navigate(hrefOf(to.pathname, params), { replace })
    },
    [layout, targetOf, setFront, searchParams, coverOwner, navigate]
  )

  const closedTabs = useRef<string[]>([])
  const { closeTo } = useCoverHistory(PANEL_COVER)
  const closing = useCallback(
    (panelId: string) =>
      isPagePane(panelId)
        ? layout
        : panesOwnedBy(layout, panelId).reduce(closePanelTab, closePanelTab(layout, panelId)),
    [layout]
  )
  const canCloseTab = useCallback(
    (panelId: string) => {
      const next = closing(panelId)
      return next !== layout && targetOf(next) !== null
    },
    [closing, layout, targetOf]
  )
  const closeTab = useCallback(
    (panelId: string) => {
      // A stream's draft and overview go with the stream: they are that stream's.
      const next = closing(panelId)
      if (next === layout) return
      const to = targetOf(next)
      if (to === null) return
      // A draft's tab is gone with its draft, and a compose tab's draft is back
      // inline, so only real panels are remembered for reopening.
      if (!isDraftPanel(panelId) && !isComposePanel(panelId)) {
        closedTabs.current = [...closedTabs.current.filter((id) => id !== panelId), panelId].slice(-MAX_CLOSED_TABS)
      }
      const params = new URLSearchParams(searchParams)
      if (panelId === coverOwner) dropDeepLink(params)
      closeTo(landingsOf(next, to, params))
    },
    [closeTo, closing, targetOf, landingsOf, searchParams, layout, coverOwner]
  )

  const findReopenable = useCallback(() => {
    const shown = new Set(panelIdsOf(layout).map(paneIdentity))
    return [...closedTabs.current]
      .reverse()
      .find((id) => !shown.has(paneIdentity(id)) && (parsePersonaTestPanel(id) === null || id === personaTest))
  }, [layout, personaTest])
  const canReopenTab = useCallback(() => findReopenable() !== undefined, [findReopenable])

  const reopenTab = useCallback(
    (scopeId: string | null) => {
      const panelId = findReopenable()
      if (!panelId) return null
      closedTabs.current = closedTabs.current.filter((id) => id !== panelId)
      const from = scopeId ?? routePane
      // The first column reopens beside itself rather than over its stream.
      const beside = from !== null && firstColumnHolds(layout, from)
      open(
        (current) => (beside ? openPanelTabBeside(current, from, panelId) : openPanelTabWith(current, from, panelId)),
        false,
        panelId
      )
      return panelId
    },
    [findReopenable, open, routePane, layout]
  )

  // Splitting rearranges what is already open, so it is not a step of its own in history.
  const splitTab = useCallback(
    (panelId: string, direction: SplitDirection) =>
      open((current) => splitPanelTab(current, panelId, direction), true, panelId),
    [open]
  )

  // Moving an open tab rearranges, like a split; a stream dropped in opens, so Back closes it.
  const dropTab = useCallback(
    (panelId: string, drop: PaneDrop) => {
      // A target closed mid-drag leaves nothing to drop beside, and nothing for Back to undo.
      if (dropPanelTab(layout, panelId, drop) === layout) return
      open((current) => dropPanelTab(current, panelId, drop), panelIdsOf(layout).includes(panelId), panelId)
    },
    [open, layout]
  )

  // Focusing is a step of its own in history, so Back puts the tab back; putting
  // it back by hand pops that step rather than adding one.
  const focusTab = useCallback(
    (panelId: string | null) => {
      if (panelId !== null) {
        if (isPagePane(panelId)) return
        // A second press can land before the router commits the first, which already pushed this step.
        if (parsePanelLayout(new URLSearchParams(window.location.search).get(PANEL_PARAM)).focused === panelId) return
        open((current) => focusPanelTab(current, panelId), false)
        return
      }
      const next = focusPanelTab(layout, null)
      if (next === layout) return
      const to = targetOf(next)
      if (to === null) return
      closeTo(landingsOf(next, to, searchParams))
    },
    [open, closeTo, layout, searchParams, targetOf, landingsOf]
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
      phone,
      contextual,
      closeTab,
      canCloseTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      dropTab,
      setCurrentPane,
      markCurrentPane: setFront,
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
      phone,
      contextual,
      closeTab,
      canCloseTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      dropTab,
      setCurrentPane,
      setFront,
      coverOwner,
    ]
  )
  const value = useMemo(() => buildValue(ops, null, null), [ops])

  return (
    <PanelOpsContext.Provider value={ops}>
      <PanelContext.Provider value={value}>
        <CurrentPaneContext.Provider value={front}>{children}</CurrentPaneContext.Provider>
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

/** The pane the user is working in; null only on a page with no pane open. */
export function useCurrentPane(): string | null {
  return useContext(CurrentPaneContext)
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

interface PhonePanes {
  /** The panes a phone steps through, in order: one section, less the drawers. */
  order: readonly string[]
  current: string | null
}

const PhonePanesContext = createContext<PhonePanes | null>(null)

/** Provided where a phone stacks its panes; null on every other surface. */
export const PhonePanesProvider = PhonePanesContext.Provider

export function usePhonePanes(): PhonePanes | null {
  return useContext(PhonePanesContext)
}

export function usePanel(): PanelContextValue {
  const context = useContext(PanelContext)
  if (!context) {
    throw new Error("usePanel must be used within a PanelProvider")
  }
  return context
}
