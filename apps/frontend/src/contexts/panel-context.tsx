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
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { PANEL_COVER } from "@/lib/covers"
import { isPagePane, isServerStreamId } from "@/lib/stream-ids"
import { isPinnedPagePane, pagePaneAt, pagePathOf } from "@/lib/page-panes"
import { flashPane } from "@/lib/pane-flash"
import {
  PANEL_PARAM,
  SECTION_SEPARATOR,
  activatePanelTab,
  canonicalPanelLayout,
  closePanelTab,
  focusPanelTab,
  followCurrentPanel,
  firstColumnHolds,
  phonePanelRoute,
  followPanel,
  formatPanelLayout,
  readablePanelParam,
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
  splitPanelTab,
  dropPanelTab,
  routePaneAfter,
  isRoutePane,
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

/** The aside open on a stream, in a pane beside it. Which aside lives in the
 *  aside store, never the URL: a reload or a shared link finds none and drops the pane. */
const ASIDE_PANEL_PREFIX = "aside:"

/** The host stream behind an `aside:<id>` panel, or null when it isn't one. */
export function parseAsidePanel(panelId: string): string | null {
  if (!panelId.startsWith(ASIDE_PANEL_PREFIX)) return null
  return panelId.slice(ASIDE_PANEL_PREFIX.length) || null
}

export function createAsidePanelId(hostStreamId: string): string {
  return `${ASIDE_PANEL_PREFIX}${hostStreamId}`
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

/** The pane that shows `?m` set from `panelId`: a draft, an aside, an overview
 *  or a conversations list shows no messages of its own stream, so that stream
 *  does while it is open. */
export function coverPaneOf(layout: PanelLayout, panelId: string): string {
  const streamId = streamOwning(panelId)
  if (!streamId) return panelId
  return panelIdsOf(layout).includes(streamId) ? streamId : panelId
}

/** The stream whose own pane `panelId` is: its draft, aside, overview or conversations list. */
function streamOwning(panelId: string): string | null {
  return (
    parseComposePanel(panelId) ??
    parseAsidePanel(panelId) ??
    parseContextPanel(panelId)?.streamId ??
    parseConversationsPanel(panelId)
  )
}

/** The panes that belong to a stream's own: its draft, its aside, its overview and its conversations. */
function panesOwnedBy(layout: PanelLayout, streamId: string): string[] {
  return panelIdsOf(layout).filter((id) => streamOwning(id) === streamId)
}

/**
 * A phone's open: `panelId` takes the place of the pane it is opened from, or of that pane's stream for one of
 * the stream's own, which close with it. One already open is brought forward instead.
 */
function showInPlaceOf(layout: PanelLayout, from: string, panelId: string): PanelLayout {
  if (panelIdsOf(layout).includes(panelId)) return activatePanelTab(layout, panelId)
  const owner = coverPaneOf(layout, from)
  if (!panelIdsOf(layout).includes(owner)) return openPanelTabBeside(layout, from, panelId)
  return panesOwnedBy(layout, owner).reduce(closePanelTab, replacePanelTab(layout, owner, panelId))
}

export interface OpenPanelOptions {
  /** Overwrite the current history entry instead of adding one. Only for a panel
   *  that SUPERSEDES the open one — a draft thread promoted to its real stream —
   *  where going back would land on an id that no longer exists. The new id
   *  takes the superseded one's tab. */
  replace?: boolean
  /** Open beside this pane rather than the consumer's own, where it is open. */
  beside?: string
  /** Open as a tab of its own even on a phone, where a pane otherwise takes the place of the one it is opened from. */
  newTab?: boolean
}

interface PanelContextValue {
  /** The pane this consumer belongs to: inside a {@link PaneScope}, that
   *  tab's id; elsewhere, the first section's tab on show. Stream id or draft/conv panel id. */
  panelId: string | null
  /** The whole arrangement: on the stream page, the route's stream pane with `?panel=`'s. */
  layout: PanelLayout
  /** The section this consumer's tab shows in, as laid out on screen; elsewhere the first. */
  section: PanelSection | null
  /** Whether this consumer's section shows a tab row: it holds more than one tab, on a page that has tabs. */
  tabbed: boolean
  /** How many sections are on show: as the grid lays them out inside it, as the URL holds them elsewhere. */
  shownPanes: number
  /** Whether this page lays panels out as tabs beside its route's pane (a stream's, a workspace page's, the persona editor's). */
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
  /** Closes each of `panelIds` that can close, in order, as one step in history; the panes a page keeps stay. */
  closeTabs: (panelIds: readonly string[]) => void
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
  /** {@link dropTab} for the stream or page a dropped link names; a link naming neither does nothing. */
  dropLink: (href: string, drop: PaneDrop) => void
  /** The ways this consumer's tab can split off as it is laid out now. */
  splits: readonly SplitDirection[]
  /** Record the pane the user is working in. A stream pane becomes the route's stream. */
  setCurrentPane: (panelId: string) => void
  /** {@link setCurrentPane} without touching the URL, for a caller navigating there itself. */
  markCurrentPane: (panelId: string) => void
  /** Whether `?m` is this panel's: it belongs to the pane that was in front
   *  when it was set, so a pane beside it doesn't look for it too. */
  ownsCover: boolean
  /** This consumer's page pane's own query, without the panes'. */
  pageSearch: string
  /** Follows a link inside this consumer's pane: in place, or into its tab. False where the router has to. */
  navigateIn: (to: { pathname: string; search: string }, replace: boolean) => boolean
}

interface PanelOps {
  layout: PanelLayout
  urlFor: (edit: (layout: PanelLayout) => PanelLayout, dropDeepLink?: boolean, focus?: string | null) => string
  /** Commits `edit`, working in `focus` when given, with `?m=deepLink` when given. */
  open: (
    edit: (layout: PanelLayout) => PanelLayout,
    replace: boolean,
    focus?: string | null,
    deepLink?: string | null,
    focusQuery?: string
  ) => void
  /** The query a page pane shows: the URL's for the route's page, the one it last had for another. */
  pageQuery: (panelId: string) => string
  /** Follows a link inside pane `own`; false where the router has to. */
  navigatePane: (own: string, to: { pathname: string; search: string }, replace: boolean) => boolean
  /** Whether this page shows tabs beside its route's pane; no other page has panes. */
  tabbed: boolean
  /** A phone, which shows one pane at a time and no tab rows. */
  phone: boolean
  /** Opening from `scopeId`'s tab, or from the route's stream when null (a phone's pane in front); `asTab` opens a tab of its own even on a phone. */
  contextual: (layout: PanelLayout, panelId: string, scopeId: string | null, asTab?: boolean) => PanelLayout
  closeTab: (panelId: string) => void
  closeTabs: (panelIds: readonly string[]) => void
  canCloseTab: (panelId: string) => boolean
  reopenTab: (scopeId: string | null) => string | null
  canReopenTab: () => boolean
  splitTab: (panelId: string, direction: SplitDirection) => void
  focusTab: (panelId: string | null) => void
  dropTab: (panelId: string, drop: PaneDrop) => void
  dropLink: (href: string, drop: PaneDrop) => void
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
const DEEP_LINK_PARAM = "m"

function dropDeepLink(params: URLSearchParams) {
  params.delete(DEEP_LINK_PARAM)
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
  return query ? `${pathname}?${readablePanelParam(query)}` : pathname
}

const NO_SPLITS: readonly SplitDirection[] = []

const STREAM_ROUTE = "/w/:workspaceId/s/:streamId"

const PERSONA_ROUTE = "/w/:workspaceId/settings/personas/:personaId"

/** The persona editor, as the pane its route pins in the first column. */
export const PERSONA_PANE = "page:persona"

/** `layout` without a persona's test chat, except `keep`'s: one sits beside its own persona's editor only. */
function withoutForeignPersonaTests(layout: PanelLayout, keep: string | null): PanelLayout {
  return panelIdsOf(layout)
    .filter((id) => id !== keep && parsePersonaTestPanel(id) !== null)
    .reduce(closePanelTab, layout)
}

/** `layout` without `panelId` and the panes that are its stream's own: its draft, aside, overview and conversations. */
function closing(layout: PanelLayout, panelId: string): PanelLayout {
  if (isPinnedPagePane(panelId)) return layout
  return panesOwnedBy(layout, panelId).reduce(closePanelTab, closePanelTab(layout, panelId))
}

const MAX_CLOSED_TABS = 20

const PANE_SWITCH_STATE = { paneSwitch: true }

/** Whether a navigation only moved the route to another open pane, leaving every pane's URL state as it was. */
export function isPaneSwitch(state: unknown): boolean {
  return (state as typeof PANE_SWITCH_STATE | null)?.paneSwitch === true
}

function sectionCount(layout: PanelLayout): number {
  return layout.columns.reduce((count, column) => count + column.length, 0)
}

function buildValue(
  ops: PanelOps,
  scopeId: string | null,
  scopeSection: PanelSection | null,
  splits: readonly SplitDirection[] = NO_SPLITS,
  shownPanes: number = sectionCount(ops.layout)
): PanelContextValue {
  const { layout } = ops
  const own = scopeId ?? primaryPanelOf(layout)
  // A phone works in whatever it opens; elsewhere a tab already open is brought forward and worked in.
  const focusOnOpen = (panelId: string) => (ops.phone || panelIdsOf(layout).includes(panelId) ? panelId : null)
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
    tabbed: ops.tabbed && !ops.phone && (scopeSection?.ids.length ?? 0) > 1,
    shownPanes,
    hasTabs: ops.tabbed,
    inFirstColumn: ops.tabbed && own !== null && firstColumnHolds(layout, own),
    canClosePanel: own !== null && ops.canCloseTab(own),
    getPanelUrl: (panelId) =>
      ops.urlFor((current) => ops.contextual(current, panelId, scopeId), false, focusOnOpen(panelId)),
    getFocusedPanelUrl: (panelId) =>
      ops.urlFor((current) => focusPanelTab(ops.contextual(current, panelId, scopeId), panelId)),
    openPanel: (panelId, options) =>
      options?.replace
        ? ops.open((current) => supersede(current, panelId), true)
        : ops.open(
            (current) =>
              ops.contextual(
                current,
                panelId,
                options?.beside !== undefined && panelIdsOf(current).includes(options.beside)
                  ? options.beside
                  : scopeId,
                options?.beside !== undefined || options?.newTab === true
              ),
            false,
            focusOnOpen(panelId)
          ),
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
    closeTabs: ops.closeTabs,
    canCloseTab: ops.canCloseTab,
    reopenTab: () => ops.reopenTab(scopeId),
    canReopenTab: ops.canReopenTab,
    splitTab: ops.splitTab,
    focusTab: ops.focusTab,
    dropTab: ops.dropTab,
    dropLink: ops.dropLink,
    splits,
    setCurrentPane: ops.setCurrentPane,
    markCurrentPane: ops.markCurrentPane,
    ownsCover: own !== null && own === ops.coverOwner,
    pageSearch: own === null ? "" : ops.pageQuery(own),
    navigateIn: (to, replace) => own !== null && ops.navigatePane(own, to, replace),
  }
}

/** Where a phone's reload or Back lands: the route's pane when `?panel=` writes it, else the newest pane, as links written before did. */
function phoneLandingOf(layout: PanelLayout, panelValue: string | null, routePane: string | null): string | null {
  if (layout.focused !== undefined) return layout.focused.at(-1)!
  if (routePane !== null && writesRoutePane(panelValue, routePane)) return routePane
  return newestPanelOf(layout)
}

/** The parser drops a pinned page pane, so one is written only as the first column, in front of the others. */
function writesRoutePane(panelValue: string | null, routePane: string): boolean {
  if (isPinnedPagePane(routePane)) return panelValue?.split(SECTION_SEPARATOR)[0] === routePane
  return panelIdsOf(parsePanelLayout(panelValue)).includes(routePane)
}

/** The pane `pathname` names: a stream's, a workspace page's, or the persona editor's. */
function routePaneAt(pathname: string): string | null {
  const streamId = matchPath(STREAM_ROUTE, pathname)?.params.streamId
  if (streamId) return streamId
  return pagePaneAt(pathname) ?? (matchPath(PERSONA_ROUTE, pathname) ? PERSONA_PANE : null)
}

/** The route that names `panelId`. */
function routePathOf(workspaceId: string | undefined, panelId: string): string {
  const page = pagePathOf(panelId)
  return page === null ? `/w/${workspaceId}/s/${panelId}` : `/w/${workspaceId}${page}`
}

/** The params that say where the panes go and what they show, rather than what a page shows. */
const PANE_PARAMS = [PANEL_PARAM, DEEP_LINK_PARAM]

/** A page's own query: the URL's, without the panes'. */
function pageQueryOf(params: URLSearchParams): string {
  const own = new URLSearchParams(params)
  for (const key of PANE_PARAMS) own.delete(key)
  return own.toString()
}

/** A link to a stream's message and nothing else. */
function isPermalink(params: URLSearchParams): boolean {
  return params.has(DEEP_LINK_PARAM) && pageQueryOf(params) === ""
}

/** `query` with the panes' params `params` carries. */
function withPaneParams(query: string, params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(query)
  for (const key of PANE_PARAMS) {
    const value = params.get(key)
    if (value !== null) next.set(key, value)
  }
  return next
}

/**
 * The query the route starts from when it moves from `from` to `to`. A page
 * takes its own query along and finds it again when the route comes back, so
 * one stream's route moving to another keeps everything, and any move to or
 * from a page keeps only the panes' params.
 */
function routeParamsOf(
  from: string | null,
  params: URLSearchParams,
  to: string | null,
  pageQuery: (panelId: string) => string
): URLSearchParams {
  if (to === from || to === null || from === null) return new URLSearchParams(params)
  if (pagePathOf(from) === null && pagePathOf(to) === null) return new URLSearchParams(params)
  return withPaneParams(pagePathOf(to) === null ? "" : pageQuery(to), params)
}

/** The query each page pane shows: the route's own from the URL, the others' kept here since they left it. */
interface PageQueries {
  workspaceId: string | undefined
  route: string | null
  query: string
  kept: ReadonlyMap<string, string>
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
  // A tab that just started floating: focused, opened from inside the group, or brought forward in it.
  const focused = layout.focused?.find((id) => !state.layout.focused?.includes(id))
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
  // A route that names a pane shows tabs beside it: a stream's or a workspace page's, which panes can move the
  // route between, and the persona editor's, which stays put. No other page has panes.
  const router = useContext(UNSAFE_DataRouterContext)?.router ?? null
  const workspaceId = useMatch("/w/:workspaceId/*")?.params.workspaceId
  const routePane = routePaneAt(location.pathname)
  const personaId = useMatch(PERSONA_ROUTE)?.params.personaId
  const personaTest = personaId ? createPersonaTestPanelId(personaId) : null
  const tabbed = routePane !== null

  const panelValue = searchParams.get(PANEL_PARAM)
  const layout = useMemo(
    () => fullPanelLayout(routePane, withoutForeignPersonaTests(parsePanelLayout(panelValue), personaTest)),
    [routePane, panelValue, personaTest]
  )

  const deepLink = searchParams.get(DEEP_LINK_PARAM)

  // The panes follow the arrangement in the same render, so a pane just opened
  // is in front on its first paint: a phone shows it, and a narrow window folding
  // it in with others brings it forward. Starting from the newest panel keeps a
  // reload showing what the URL's last open showed.
  const phone = useIsMobileOrCoarse()
  const [paneState, setPaneState] = useState<PaneState>(() => {
    // The route names the pane worked in, and a reloaded `?m` goes to the newest pane, as links already written
    // expect. A phone, which shows one pane, lands as {@link phoneLandingOf} says, and so does its `?m`.
    const newest = layout.focused?.at(-1) ?? newestPanelOf(layout)
    let front = layout.focused?.at(-1) ?? newest
    if (phone) front = phoneLandingOf(layout, panelValue, routePane)
    else if (layout.focused === undefined && routePane !== null && !isPinnedPagePane(routePane))
      front = followPanel(layout, layout, routePane)
    const owner = phone ? front : newest
    return {
      layout,
      path: routePane,
      deepLink,
      front,
      coverOwner: owner === null ? null : coverPaneOf(layout, owner),
    }
  })
  let panes = paneState
  if (panes.layout !== layout || panes.deepLink !== deepLink) {
    panes = followPanes(
      panes,
      layout,
      routePane,
      deepLink,
      restored,
      phone ? phoneLandingOf(layout, panelValue, routePane) : undefined
    )
    setPaneState(panes)
  }
  const { coverOwner, front } = panes
  const setFront = useCallback(
    (panelId: string) => setPaneState((state) => (state.front === panelId ? state : { ...state, front: panelId })),
    []
  )

  // A page pane the route leaves keeps the query it had there.
  const routeQuery = routePane !== null && pagePathOf(routePane) !== null ? pageQueryOf(searchParams) : ""
  const [pageQueries, setPageQueries] = useState<PageQueries>({
    workspaceId,
    route: routePane,
    query: routeQuery,
    kept: new Map(),
  })
  let queries = pageQueries
  if (queries.workspaceId !== workspaceId) {
    queries = { workspaceId, route: routePane, query: routeQuery, kept: new Map() }
    setPageQueries(queries)
  } else if (queries.route !== routePane || queries.query !== routeQuery) {
    const left = queries.route
    const kept =
      left !== null && left !== routePane && pagePathOf(left) !== null
        ? new Map(queries.kept).set(left, queries.query)
        : queries.kept
    queries = { workspaceId, route: routePane, query: routeQuery, kept }
    setPageQueries(queries)
  }
  const { kept } = queries
  const pageQuery = useCallback(
    (panelId: string) => (panelId === routePane ? routeQuery : (kept.get(panelId) ?? "")),
    [routePane, routeQuery, kept]
  )
  const keepPageQuery = useCallback(
    (panelId: string, query: string) =>
      setPageQueries((state) => ({ ...state, kept: new Map(state.kept).set(panelId, query) })),
    []
  )
  // A query given for `to` is the one a link there names, so it wins even where the route stays put.
  const routeParams = useCallback(
    (to: string | null, query?: string) =>
      query !== undefined && to !== null
        ? withPaneParams(query, searchParams)
        : routeParamsOf(routePane, searchParams, to, pageQuery),
    [routePane, searchParams, pageQuery]
  )

  // Where the page lands with `next`: the pane worked in after it (a stream tab just opened, or the one
  // taking the current pane's place), else the one taking the route's place when it closes. A page's route
  // stays put while it is open, and the persona editor's always does.
  const targetOf = useCallback(
    (next: PanelLayout, focus: string | null = null): Target | null => {
      const current = focus ?? followCurrentPanel(layout, next, front)
      if (routePane === null || isPinnedPagePane(routePane))
        return { pathname: location.pathname, path: routePane, keepsPath: phone && current === routePane }
      // The pane just navigated into wins over `front`: the click that pressed it hasn't re-rendered yet.
      const after = routePaneAfter(layout, next, routePane, focus ?? front)
      const follows =
        !isPagePane(routePane) && current !== null && isServerStreamId(current) && panelIdsOf(next).includes(current)
      const route = phone ? phonePanelRoute(next, current, after) : { path: follows ? current : after, keepPath: false }
      if (route.path === null) return null
      return {
        pathname: route.path === routePane ? location.pathname : routePathOf(workspaceId, route.path),
        path: route.path,
        keepsPath: route.keepPath,
      }
    },
    [routePane, layout, front, location.pathname, workspaceId, phone]
  )

  // Every route pane of `next` can be the route and show the same panes, so closing pops onto any of them.
  const landingsOf = useCallback(
    (next: PanelLayout, to: Target, params: URLSearchParams): [CoverLanding, ...CoverLanding[]] => {
      const landing = (pathname: string, path: string | null, keepPath: boolean) => {
        const landed = routeParamsOf(routePane, params, path, pageQuery)
        setLayoutParam(landed, next, path, keepPath)
        return { pathname, params: landed }
      }
      const movable = routePane !== null && !isPinnedPagePane(routePane)
      const others = movable ? panelIdsOf(next).filter((id) => id !== to.path && isRoutePane(id)) : []
      return [
        landing(to.pathname, to.path, to.keepsPath),
        ...others.map((id) =>
          landing(routePathOf(workspaceId, id), id, phone && phonePanelRoute(next, id, id).keepPath)
        ),
      ]
    },
    [routePane, pageQuery, workspaceId, phone]
  )

  const setCurrentPane = useCallback(
    (panelId: string) => {
      setFront(panelId)
      // The router commits a navigation in a transition, so a click can land while this render still shows
      // the layout before it; rewriting from that would undo the open, drop or move that just happened. This
      // move commits at once for the same reason: typing straight after it would starve its transition, and
      // anything done to the panes meanwhile would act on the route before it.
      const live = router?.state.location ?? location
      const livePane = routePaneAt(live.pathname)
      const liveParams = new URLSearchParams(live.search)
      const liveLayout = fullPanelLayout(livePane, parsePanelLayout(liveParams.get(PANEL_PARAM)))
      if (livePane === null || !panelIdsOf(liveLayout).includes(panelId)) return
      // A desktop route follows the stream worked in, from a stream; a phone also writes which pane it is in
      // front of the others, so a reload or Back lands on it.
      if (!phone && (panelId === livePane || !isServerStreamId(panelId) || isPagePane(livePane))) return
      const shown = phone ? activatePanelTab(liveLayout, panelId) : liveLayout
      let route: { path: string | null; keepPath: boolean } = { path: livePane, keepPath: panelId === livePane }
      if (!isPinnedPagePane(livePane))
        route = phone ? phonePanelRoute(shown, panelId, livePane) : { path: panelId, keepPath: false }
      const to = route.path ?? livePane
      const base = routeParamsOf(livePane, liveParams, to, pageQuery)
      const params = withLayout(base, shown, to, coverOwner, route.keepPath)
      const href = hrefOf(to === livePane ? live.pathname : routePathOf(workspaceId, to), params)
      if (href === hrefOf(live.pathname, liveParams)) return
      navigate(href, { replace: true, flushSync: true, state: PANE_SWITCH_STATE })
    },
    [setFront, router, location, coverOwner, navigate, workspaceId, phone, pageQuery]
  )

  // A phone shows one pane, so what opens from it takes its place and Back brings it back. A stream's own panes
  // (draft, aside, overview, conversations) still open beside it. So does what opens from a page, which stays
  // mounted under it for Back to land where it was scrolled, and from an aside, whose sheet shows its threads.
  const contextual = useCallback(
    (current: PanelLayout, panelId: string, scopeId: string | null, asTab = false) => {
      const from = scopeId ?? (phone ? front : null) ?? routePane
      if (
        !phone ||
        asTab ||
        from === null ||
        isPagePane(from) ||
        parseAsidePanel(from) !== null ||
        streamOwning(panelId) !== null
      )
        return openPanelTabBeside(current, from, panelId)
      return showInPlaceOf(current, from, panelId)
    },
    [routePane, phone, front]
  )

  const urlFor = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, dropsDeepLink = false, focus: string | null = null) => {
      const next = edit(layout)
      const to = targetOf(next, focus)
      if (to === null) return `${location.pathname}${location.search}`
      const params = withLayout(routeParams(to.path), next, to.path, coverOwner, to.keepsPath)
      if (dropsDeepLink) dropDeepLink(params)
      return hrefOf(to.pathname, params)
    },
    [routeParams, location.pathname, location.search, layout, coverOwner, targetOf]
  )

  // Opening a panel PUSHES: on mobile it takes over the whole screen, so back has
  // to close it rather than leave the page. `<Link to={getPanelUrl(...)}>` (branch
  // rows, thread anchors) already pushed; this makes the imperative path match.
  const open = useCallback(
    (
      edit: (layout: PanelLayout) => PanelLayout,
      replace: boolean,
      focus: string | null = null,
      deepLink: string | null = null,
      /** The query of the link that opens `focus`, when the route goes there. */
      focusQuery?: string
    ) => {
      const next = edit(layout)
      const to = targetOf(next, focus)
      if (to === null) return
      if (focus !== null) setFront(focus)
      const base = routeParams(to.path, to.path === focus ? focusQuery : undefined)
      const params = withLayout(base, next, to.path, coverOwner, to.keepsPath)
      if (deepLink !== null) params.set(DEEP_LINK_PARAM, deepLink)
      const href = hrefOf(to.pathname, params)
      // Opening what is already on show adds no entry for Back to step through, and shows the open registered.
      if (href === hrefOf(location.pathname, searchParams)) {
        if (focus !== null) flashPane(focus)
        return
      }
      navigate(href, { replace })
    },
    [layout, targetOf, setFront, routeParams, searchParams, coverOwner, navigate, location.pathname]
  )

  // The pane a link names, with its query: a stream or a page of this workspace. Null for a URL that says where
  // every pane goes, or one only the router can follow.
  const linkedPane = useCallback(
    (to: { pathname: string; search: string }) => {
      const params = new URLSearchParams(to.search)
      if (params.has(PANEL_PARAM) || matchPath("/w/:workspaceId/*", to.pathname)?.params.workspaceId !== workspaceId)
        return null
      const target = routePaneAt(to.pathname)
      return target !== null && isRoutePane(target) ? { target, params } : null
    },
    [workspaceId]
  )

  // Opens a linked pane where `edit` puts it: a page keeps the link's query, a stream jumps to its `?m`.
  const openLinked = useCallback(
    (edit: (layout: PanelLayout) => PanelLayout, replace: boolean, target: string, params: URLSearchParams) => {
      const page = pagePathOf(target) !== null
      if (page) keepPageQuery(target, params.toString())
      open(edit, replace, target, page ? null : params.get(DEEP_LINK_PARAM), params.toString())
    },
    [keepPageQuery, open]
  )

  // A link followed inside a pane: the same page with another query changes it in place, another page or a
  // stream takes its tab (a phone brings one already open forward instead), and a stream's permalink to itself
  // jumps there. A stream pane leaves its own query changes and replaces (covers, promotions) to the router, as
  // it does anything else.
  const navigatePane = useCallback(
    (own: string, to: { pathname: string; search: string }, replace: boolean): boolean => {
      const link = linkedPane(to)
      if (link === null) return false
      const { target, params } = link
      const page = pagePathOf(own) !== null
      // A stream's link to itself, nothing more, has nowhere to go; one clearing the URL's query still goes there.
      if (
        !page &&
        target === own &&
        params.toString() === "" &&
        [...searchParams.keys()].every((key) => key === PANEL_PARAM)
      ) {
        flashPane(own)
        return true
      }
      // Elsewhere than a phone, a link to a stream open in another pane brings that pane forward, and one from an
      // aside to its stream opens it beside the aside, rather than the page going to that stream alone.
      if (!page && !phone && !replace && target !== own && pagePathOf(target) === null) {
        const shown = panelIdsOf(layout).includes(target)
        if (!shown && parseAsidePanel(own) !== target) return false
        // Moving to a pane already on show changes only which pane is worked in, which is no step in history.
        if (
          shown &&
          !params.has(DEEP_LINK_PARAM) &&
          formatPanelLayout(activatePanelTab(layout, target)) === formatPanelLayout(layout)
        ) {
          setCurrentPane(target)
          flashPane(target)
          return true
        }
        openLinked(
          (current) => (shown ? activatePanelTab(current, target) : openPanelTabBeside(current, own, target)),
          false,
          target,
          params
        )
        return true
      }
      if (!page && (!phone || replace || (target === own && !isPermalink(params)))) return false
      if (page && target === own && own !== routePane) {
        keepPageQuery(own, params.toString())
        return true
      }
      if (page && target === own) {
        navigate(hrefOf(location.pathname, withPaneParams(to.search, searchParams)), { replace })
        return true
      }
      const edit = (current: PanelLayout) => {
        if (target === own) return current
        return phone ? showInPlaceOf(current, own, target) : replacePanelTab(current, own, target)
      }
      openLinked(edit, replace, target, params)
      return true
    },
    [
      linkedPane,
      routePane,
      keepPageQuery,
      searchParams,
      navigate,
      location.pathname,
      openLinked,
      phone,
      layout,
      setCurrentPane,
    ]
  )

  const closedTabs = useRef<string[]>([])
  const { closeTo } = useCoverHistory(PANEL_COVER)
  const canCloseTab = useCallback(
    (panelId: string) => {
      const next = closing(layout, panelId)
      return next !== layout && targetOf(next) !== null
    },
    [layout, targetOf]
  )
  const closeTabs = useCallback(
    (panelIds: readonly string[]) => {
      // The route's pane goes last, so a close that must leave one route pane leaves the page's own.
      const ordered = [...panelIds.filter((id) => id !== routePane), ...panelIds.filter((id) => id === routePane)]
      let next = layout
      const closed: string[] = []
      for (const panelId of ordered) {
        const after = closing(next, panelId)
        if (after === next || targetOf(after) === null) continue
        next = after
        closed.push(panelId)
      }
      if (closed.length === 0) return
      const to = targetOf(next)!
      // A draft's tab is gone with its draft, a compose tab's draft is back
      // inline, and a closed aside is reopened from its anchor row, so only real
      // panels are remembered for reopening.
      const remembered = closed.filter((id) => !isDraftPanel(id) && !isComposePanel(id) && parseAsidePanel(id) === null)
      closedTabs.current = [...closedTabs.current.filter((id) => !remembered.includes(id)), ...remembered].slice(
        -MAX_CLOSED_TABS
      )
      const params = new URLSearchParams(searchParams)
      if (coverOwner !== null && closed.includes(coverOwner)) dropDeepLink(params)
      closeTo(landingsOf(next, to, params))
    },
    [closeTo, routePane, targetOf, landingsOf, searchParams, layout, coverOwner]
  )
  const closeTab = useCallback((panelId: string) => closeTabs([panelId]), [closeTabs])

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

  const dropLink = useCallback(
    (href: string, drop: PaneDrop) => {
      let url: URL
      try {
        url = new URL(href)
      } catch {
        return
      }
      const link = url.origin === window.location.origin ? linkedPane(url) : null
      if (link === null || dropPanelTab(layout, link.target, drop) === layout) return
      openLinked(
        (current) => dropPanelTab(current, link.target, drop),
        panelIdsOf(layout).includes(link.target),
        link.target,
        link.params
      )
    },
    [linkedPane, openLinked, layout]
  )

  // Focusing is a step of its own in history, so Back puts the tab back; putting
  // it back by hand pops that step rather than adding one.
  const focusTab = useCallback(
    (panelId: string | null) => {
      if (panelId !== null) {
        if (isPinnedPagePane(panelId)) return
        // A second press can land before the router commits the first, which already pushed this step.
        if (parsePanelLayout(new URLSearchParams(window.location.search).get(PANEL_PARAM)).focused?.includes(panelId))
          return
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
      closeTabs,
      canCloseTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      dropTab,
      dropLink,
      setCurrentPane,
      markCurrentPane: setFront,
      coverOwner,
      pageQuery,
      navigatePane,
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
      closeTabs,
      canCloseTab,
      reopenTab,
      canReopenTab,
      splitTab,
      focusTab,
      dropTab,
      dropLink,
      setCurrentPane,
      setFront,
      coverOwner,
      pageQuery,
      navigatePane,
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
  // The grid may fold sections the URL holds; a drawer or the aside sheet sits outside it and counts the URL.
  const displayed = useContext(DisplayedPanelLayoutContext)
  const shownPanes = sectionCount(displayed ?? ops.layout)
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
        shownPanes
      ),
    [ops, panelId, ids, active, directions, shownPanes]
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
