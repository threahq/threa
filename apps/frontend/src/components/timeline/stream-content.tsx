import { matchesDeepLinkTarget } from "@/lib/stream-links"
import { useMemo, useEffect, useLayoutEffect, useCallback, useRef, useState } from "react"
import { useLocation, useNavigationType, useSearchParams } from "react-router-dom"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { MessageSquare, ArrowDown, ArrowUp, X, Move, Loader2, Check, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import {
  useEvents,
  useThreadAnchorEvent,
  useStreamSocket,
  useTimelineScroll,
  useScrollBehavior,
  useStreamBootstrap,
  useWorkspaceUserId,
  useAutoMarkAsRead,
  useAutoReadAttention,
  useLastSeenEvent,
  useUnreadCounts,
  useUnreadDivider,
  isDividerReadPast,
  useIsMobile,
  useNewMessageIndicator,
  useAgentActivity,
  type MessageAgentActivity,
  useSteerAgentSession,
  useStopAgentSession,
  useEditLastMessageTrigger,
  useKeyboardShortcuts,
  useEffectiveArchived,
  streamKeys,
  workspaceKeys,
} from "@/hooks"
import {
  useSocket,
  useCoordinatedLoading,
  usePreferencesOptional,
  usePublishAgentActivitySummary,
  type AgentActivitySummaryEntry,
} from "@/contexts"
import { useMessageService } from "@/contexts"
import { orderStreamEvents, useStreamEvents } from "@/stores/stream-store"
import {
  useWorkspaceStreams,
  useWorkspaceStreamMemberships,
  useWorkspaceStreamReadStates,
} from "@/stores/workspace-store"
import { resolveFrontierEventId, resolveFrontierSequence } from "@/lib/read-frontier"
import { useReadCommitQueue } from "@/sync/read-commit-queue"
import { effectiveConversationTitle } from "@/lib/conversations/title"
import { useUser } from "@/auth"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { ErrorView } from "@/components/error-view"
import {
  StreamTypes,
  Visibilities,
  type Stream,
  type StreamEvent,
  type StreamMember,
  type WorkspaceBootstrap,
  type StreamBootstrap,
  type ConversationWithStaleness,
  type DelegationStatusChangedEventPayload,
  type BotAccessStatusChangedEventPayload,
  type CallEndedEventPayload,
  type UnreadOpenPosition,
  type AgentSessionStartedPayload,
} from "@threa/types"
import {
  EventList,
  TimelineItemContent,
  groupTimelineItems,
  annotateAuthorGroups,
  annotateConversationRows,
  annotateConversationRevivals,
  injectGapItems,
  injectDayDividers,
  itemDayStartMs,
  findFirstMessageId,
  collectCancelledFollowUpIds,
  collectDelegationStatusPatches,
  collectBotAccessStatusPatches,
  collectCallEndedPatches,
  findMessageItemIndex,
  findEventItemIndex,
  findTimelineTargetIndex,
  getTimelineItemKey,
  filterVisibleItems,
  collectDividerAnchorIds,
  OLDER_SKELETON_ITEMS,
  type TimelineItem,
  type TimelineItemRenderContext,
  type BatchTimelineState,
} from "./event-list"
import { ConversationOverlayPanel } from "./conversation-overlay/conversation-overlay"
import { useConversationOverlay } from "./conversation-overlay/use-conversation-overlay"
import { buildMessageConversationMap } from "./conversation-overlay/model"
import type { ConversationOverlayContext } from "./conversation-overlay/model"
import { MessageConversationProvider } from "./conversation-overlay/message-conversation-context"
import { useConversationMembershipHeal } from "./conversation-overlay/use-conversation-membership-heal"
import { useConversations, useReassignMessagesToConversation } from "@/hooks/use-conversations"
import { conversationColor } from "./conversation-overlay/model"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MessageInput } from "./message-input"
import { StreamDateHeader } from "./stream-date-header"
import { JoinChannelBar } from "./join-channel-bar"
import { ThreadParentEvent } from "../thread/thread-parent-event"
import { EditLastMessageContext } from "./edit-last-message-context"
import { QuoteReplyProvider } from "./quote-reply-context"
import { ConversationReplyProvider } from "./conversation-reply-context"
import { SlotsProvider } from "@/components/slots/context"
import { useStreamSlots } from "@/hooks/use-stream-slots"
import { TextSelectionQuote } from "./text-selection-quote"
import { StreamSearchBar } from "./stream-search-bar"
import { useStreamSearch } from "@/hooks/use-stream-search"
import { useSearchHighlight } from "@/hooks/use-search-highlight"
import { stripMarkdownToInline } from "@/lib/markdown"
import { localStartOfDayMs } from "@/lib/dates"
import { getPerfCapture } from "@/lib/perf/capture"
import { addStartBatchSelectListener, type BatchSelectIntent } from "@/lib/batch-selection-events"
import { addMarkReadUpToHereListener, addMarkUnreadListener } from "@/lib/mark-read-events"
import { clearTimelineAnchor, loadTimelineAnchor, saveTimelineAnchor } from "@/lib/timeline-anchor-storage"
import { ReadFrontierContext, type ReadFrontier } from "./read-frontier-context"
import { useReadMessageIds } from "@/hooks/use-unread-counts"

/** Membership events; suppressed in threads (see displayEvents memo). */
const THREAD_HIDDEN_EVENT_TYPES = new Set<StreamEvent["eventType"]>(["member_joined", "member_added", "member_left"])

/**
 * Opt-in deep-link scroll tracing. Off by default (zero console noise in
 * production). Enable from the browser console with
 * `window.__threaDeepLinkDebug = true`, then reproduce a deep-link (`?m=`)
 * navigation — every jump result, skeleton-hold transition, scroll bail
 * reason, and convergence decision is logged so a remaining "never scrolls
 * into view" miss is diagnosable without another instrumentation round-trip.
 */
function deepLinkDebug(...args: unknown[]) {
  if (typeof window !== "undefined" && (window as { __threaDeepLinkDebug?: boolean }).__threaDeepLinkDebug) {
    console.debug("[deeplink]", ...args)
  }
}

/**
 * Per-tick terminal policy for the post-jump scroll driver.
 *
 * The driver re-attempts `scrollToMessage` every frame after a deep-link
 * jump swaps the event window, because the Virtuoso scroller attaches — and
 * the target row becomes placeable — a few frames *after* `events` updates
 * and the `holdForDeepLink` skeleton releases. The previous one-shot
 * `requestAnimationFrame` fired into a not-yet-mounted scroller, bailed with
 * no retry, and the deep-link silently never landed. This function decides
 * when the loop must stop regardless of whether the target is placeable yet:
 *
 *  - `superseded`  the pending target changed (new nav / stream switch /
 *                  jump failure already cleared it) — stop, don't touch it.
 *  - `user-abort`  a genuine wheel/touch/key gesture landed — the user's
 *                  scroll wins; stop and clear.
 *  - `deadline`    the bound elapsed without the target ever becoming
 *                  placeable — stop and clear so it can't spin forever.
 *  - `active`      keep going: caller attempts `scrollToMessage` this tick
 *                  and, only if it engaged its own resilient refine loop,
 *                  clears the target; otherwise it reschedules next frame.
 */
export type DeepLinkScrollTick = "superseded" | "user-abort" | "deadline" | "active"

export function classifyDeepLinkScrollTick(args: {
  pendingTarget: string | null
  target: string
  userInteractedAt: number
  elapsedMs: number
  deadlineMs: number
}): DeepLinkScrollTick {
  if (args.pendingTarget !== args.target) return "superseded"
  if (args.userInteractedAt > 0) return "user-abort"
  if (args.elapsedMs >= args.deadlineMs) return "deadline"
  return "active"
}

/**
 * Whether the `?m=` highlight fade-out countdown may start.
 *
 * The highlight param is stripped from the URL a few seconds after a deep-link
 * lands, fading the highlight ring and returning the URL to its canonical form.
 * The countdown must NOT start at mount. On a cold push-notification open the
 * jump window (auth + workspace bootstrap + the events-around fetch) can take
 * longer than the fade delay to load. If the param clears before <Virtuoso>
 * mounts, the mount loses its `highlightMessageId` anchor
 * (`effectiveInitialTopMostItemIndex` falls back to the hook's `undefined`) and
 * the list mounts at index 0 — the *top* of the loaded window — leaving the
 * user "dumped way up high" instead of centered on the linked message.
 *
 * Gate the countdown on the deep-link having actually landed (the target is in
 * the loaded window) or conclusively failed (`deepLinkGaveUp`), so a slow load
 * keeps the param — and thus the mount anchor — alive until the message is
 * really there.
 */
export function shouldStartHighlightClear(args: {
  highlightMessageId: string | null | undefined
  deepLinkTargetLoaded: boolean
  deepLinkGaveUp: boolean
}): boolean {
  if (!args.highlightMessageId) return false
  return args.deepLinkTargetLoaded || args.deepLinkGaveUp
}

/**
 * Max time the deep-link (?m=) mount hold may keep the skeleton up while the
 * jump window is fetched. The hold exists so a fast fetch mounts the list
 * already anchored on the target (no tail-paint-then-yank), and the push
 * prefetch usually has the target in IDB already — so within this bound the
 * hold is invisible. Past it, a skeleton is strictly worse than showing the
 * cached timeline: release, paint the window we have, and let the jump swap
 * anchor/highlight the target when it lands.
 */
export const DEEP_LINK_HOLD_MAX_MS = 600

/**
 * Gap between the viewport top and a top-aligned scroll target (the unread
 * divider row): clears the sticky date header and leaves a sliver of context
 * above so the unread run reads from the top. Shared by the jump-to-first-
 * unread pill and the marker-open scroll so both land identically.
 */
const UNREAD_MARKER_TOP_GAP_PX = 56

/**
 * Consecutive 60ms refine ticks the scrollToMessage target must hold its
 * aligned position before `onFirstSettle` fires — long enough that virtua's
 * measurement reflow has genuinely converged, short enough (~180ms) that the
 * anchor restore's skeleton hold is imperceptible on top of the load itself.
 */
const SCROLL_SETTLE_STABLE_TICKS = 3

/**
 * Whether the timeline should keep showing the skeleton while a deep-link
 * (?m=) target is fetched into the window. Holds only while there is real
 * cached content that would otherwise paint at the wrong anchor, and never
 * past `DEEP_LINK_HOLD_MAX_MS` (`holdExpired`), never after the target loaded,
 * and never after the jump conclusively failed.
 */
export function shouldHoldForDeepLink(args: {
  highlightMessageId: string | null | undefined
  deepLinkTargetLoaded: boolean
  deepLinkGaveUp: boolean
  holdExpired: boolean
  isLoading: boolean
  isConfirmedEmpty: boolean
  hasEvents: boolean
}): boolean {
  if (!args.highlightMessageId || args.deepLinkTargetLoaded || args.deepLinkGaveUp || args.holdExpired) {
    return false
  }
  return !args.isLoading && !args.isConfirmedEmpty && args.hasEvents
}

/**
 * Whether the deep-link / search highlight effect may claim a navigation and
 * act on it this render. The event window must have hydrated first: on a cold
 * open `isLoading` can read false while `events` is still empty (the IDB
 * live-query hasn't resolved). Claiming the navigation then — stamping the
 * once-per-`location.key` guard — with nothing to act on (no window to scroll
 * within, none to jump from) would block the retry once events arrive, leaving
 * an out-of-window target stranded behind `holdForDeepLink`. Gating on
 * `hasEvents` keeps the effect re-armed until there is a window to act on.
 */
export function canActOnDeepLinkNavigation<T extends string>(args: {
  highlightMessageId: T | null | undefined
  isLoading: boolean
  isDraft: boolean
  hasEvents: boolean
}): args is { highlightMessageId: T; isLoading: boolean; isDraft: boolean; hasEvents: boolean } {
  if (!args.highlightMessageId || args.isLoading || args.isDraft) return false
  return args.hasEvents
}

/**
 * Remap a thread watermark that points at a suppressed membership event to the
 * nearest PRECEDING rendered event (null when none precedes it — "nothing read
 * yet", an equivalent read position since suppressed events aren't readable
 * content). A fresh thread member's watermark is seeded on their member_added
 * event by the backend, but threads hide membership events from the rendered
 * window — so the auto-read frontier (`useLastSeenEvent`), which resolves the
 * watermark's index in `displayEvents`, would see an unresolvable pointer and
 * give up: auto-read never fires, leaving the thread permanently unread (the
 * ghost-unread-thread bug). A watermark outside
 * the loaded window entirely is returned as-is: read progress is unknowable
 * there, and the consumers' existing suppression semantics must keep applying.
 */
export function remapSuppressedWatermark(
  lastReadEventId: string | null | undefined,
  events: StreamEvent[],
  displayEvents: StreamEvent[]
): string | null | undefined {
  if (!lastReadEventId) return lastReadEventId
  const displayIds = new Set(displayEvents.map((e) => e.id))
  if (displayIds.has(lastReadEventId)) return lastReadEventId
  const idx = events.findIndex((e) => e.id === lastReadEventId)
  if (idx < 0) return lastReadEventId
  for (let i = idx - 1; i >= 0; i--) {
    if (displayIds.has(events[i].id)) return events[i].id
  }
  return null
}

/** Lead distance (px) from either edge of the scroll range at which the next
 *  page is prefetched, so it lands before a fast scroll reaches the boundary. */
export const EDGE_PREFETCH_PX = 1500

/**
 * Decide whether the scroll position is close enough to either edge of the
 * loaded window to prefetch the next page. Pure px math over the owned
 * scroller's native metrics — `prefetchPx` is the lead distance; a larger value
 * starts the fetch sooner.
 */
export function computeScrollEdges(args: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  prefetchPx: number
}): { reachedStart: boolean; reachedEnd: boolean } {
  const { scrollTop, scrollHeight, clientHeight, prefetchPx } = args
  return {
    reachedStart: scrollTop <= prefetchPx,
    reachedEnd: scrollHeight - scrollTop - clientHeight <= prefetchPx,
  }
}

/**
 * Whether to prefetch older history given the reached-start signal.
 *
 * The jump-prone case is being parked at the live tail of a *scrollable*
 * viewport: the loaded window can sit entirely inside the top overscan, so
 * `reachedStart` is satisfied with zero user scrolling, and prefetching then
 * prepends variable-height history above a scrolled anchor — jumping the scroll
 * on load and cascading as each jump re-satisfies the trigger. So block older
 * prefetch only while `followingLiveTail && scrollerScrollable`.
 *
 * When the whole window fits the viewport (`scrollerScrollable` false), the user
 * cannot scroll off the tail to unlock pagination, and prepending is bottom-
 * pinned and jump-free — so allow it; it fills history until the viewport
 * scrolls, then the scrollable gate takes over. Once the user scrolls up off the
 * tail (`followingLiveTail` false), prefetch leads normally.
 */
export function shouldPrefetchOlderHistory(args: {
  followingLiveTail: boolean
  scrollerScrollable: boolean
  hasOlderEvents: boolean
  isFetchingOlder: boolean
}): boolean {
  if (!args.hasOlderEvents || args.isFetchingOlder) return false
  return !(args.followingLiveTail && args.scrollerScrollable)
}

export function shouldRunEdgePagination(args: {
  scrollRefineActive: boolean
  isJumpMode: boolean
  userInteractedAt: number
}): boolean {
  if (args.scrollRefineActive) return false
  if (args.isJumpMode && args.userInteractedAt <= 0) return false
  return true
}

/** How long an older-page fetch must be in flight before skeleton rows render,
 *  so a fast response never flashes them. */
export const OLDER_SKELETON_APPEAR_DELAY_MS = 150

/** Grace period after the fetch settles for the prepend to land (IDB live-query
 *  propagation runs a couple of renders behind the query). Past it the tracker
 *  clears so a failed or empty page can't leave skeletons hanging. */
export const OLDER_SKELETON_SETTLE_GRACE_MS = 1000

/**
 * Whether skeleton placeholder rows render at the head of the timeline while
 * an older page is in flight.
 *
 * `trackedOldestEventId` is the oldest rendered event id captured when the
 * fetch started (null = no fetch tracked, which also covers top-of-history:
 * with `hasOlderEvents` false no fetch ever starts, so nothing is tracked).
 * Comparing it against the CURRENT oldest id — instead of `isFetchingOlder`,
 * which flips false a render or two before the IDB live query re-emits with
 * the new page — makes removal land in the same render as the prepend: the
 * skeletons leave and the real rows arrive in one items-array swap, one
 * `shift` computation, with no intermediate frame where the list is N rows
 * shorter (INV-21).
 */
export function shouldShowOlderSkeletons(args: {
  trackedOldestEventId: string | null
  currentOldestEventId: string | null
  appearDelayElapsed: boolean
}): boolean {
  if (args.trackedOldestEventId === null || !args.appearDelayElapsed) return false
  return args.currentOldestEventId === args.trackedOldestEventId
}

/**
 * Resolve a date jump against the currently loaded window: return the message
 * id to scroll to directly, or `null` when the caller must fetch a fresh window
 * around the date.
 *
 * The trap this guards is `events.find(day >= target)`: when the target day is
 * older than everything loaded — the user is parked at the live tail and jumps
 * weeks back — *every* loaded message satisfies `day >= target`, so the first
 * match is the oldest loaded row, not the day's first message. The jump then
 * looks like it just nudges the scroll up a little instead of relocating to the
 * date, and no fetch ever happens.
 *
 * The in-window scroll is correct only when the loaded window straddles the
 * target day: either a loaded message sits strictly before it (so the first
 * on-or-after match is the true anchor with nothing earlier missing), or the
 * stream has no older history left to fetch (the window already starts at the
 * beginning). Otherwise the earliest on-or-after-target message may live below
 * the loaded window, so we return `null` and the caller fetches.
 */
export function resolveDateJumpAnchor(args: {
  events: Array<Pick<StreamEvent, "eventType" | "createdAt" | "payload">>
  targetDayMs: number
  hasOlderEvents: boolean
}): string | null {
  const { events, targetDayMs, hasOlderEvents } = args
  let sawEarlierMessage = false
  for (const event of events) {
    if (event.eventType !== "message_created" && event.eventType !== "companion_response") continue
    if (localStartOfDayMs(new Date(event.createdAt)) >= targetDayMs) {
      if (!sawEarlierMessage && hasOlderEvents) return null
      return (event.payload as { messageId?: string })?.messageId ?? null
    }
    sawEarlierMessage = true
  }
  return null
}

/**
 * The floating chrome (date pill, jump-to-latest, unread banner) hides when
 * the visible strip between the scroller top and the floating composer drops
 * under this height. With the keyboard up and a tall reply drafted the strip
 * is barely two message rows, and center-anchored pills covered most of what
 * remained. Chrome returns as soon as the strip regrows.
 */
export const CHROME_MIN_STRIP_PX = 160

export function isChromeStripCollapsed(scrollerClientHeightPx: number, composerHeightPx: number): boolean {
  return scrollerClientHeightPx - composerHeightPx < CHROME_MIN_STRIP_PX
}

export function isTypingChromeHidden(stripCollapsed: boolean, mobileComposerTyping: boolean): boolean {
  return stripCollapsed || mobileComposerTyping
}

/**
 * Atomic stream landing (INV-70): the ONE decision about where the viewport
 * starts when a stream opens. Exactly one verdict per stream open, priority:
 *
 *   deep-link › user-gesture › anchor restore › unread marker › tail
 *
 * "wait" leaves the decision open while inputs hydrate (window loading or
 * unpopulated — `isLoading` alone misses the cold-boot grace window where IDB
 * is still resolving — or the preference/read-state a marker landing needs).
 * Everything else consumes the once-per-stream decision. The single landing
 * effect executes the verdict; positional landings (restore, marker) take the
 * cold-load settle over — hold the mask, position behind it, reveal once the
 * target holds — so the first painted frame is AT the landing, never a tail
 * flash followed by a jump.
 *
 * Semantics folded in from the previously-separate deciders:
 *  - Deep links / jump mode own the scroll outright, even mid-load (the
 *    PR #1099 yank pattern), as does any user gesture.
 *  - Restore yields to PUSH navigation: choosing a stream is a fresh open
 *    that lands at the tail and auto-reads; restore is for continuations —
 *    reload, cold relaunch (POP or the boot path's REPLACE redirects,
 *    including ExactRestore's `panelPopsToClose` PUSH hop), back/forward.
 *  - A stale anchor (row no longer in the initial window) falls through to
 *    the marker/tail branches instead of silently racing them.
 *  - "latest" preference (or nothing unread) falls to the tail, which the
 *    cold-load settle is already pinning behind the mask — the executor does
 *    nothing for it.
 */
export type StreamLanding =
  | { kind: "deep-link" }
  | { kind: "owned" }
  | { kind: "restore"; targetId: string; offsetPx: number }
  | { kind: "marker"; dividerEventId: string }
  | { kind: "tail" }

export function resolveStreamLanding(args: {
  hasDeepLink: boolean
  isJumpMode: boolean
  userInteractedAt: number
  isLoading: boolean
  /** The event window has rows (cold-boot grace-window guard, see #1873). */
  hasItems: boolean
  isPushNavigation: boolean
  anchor: { targetId: string; offsetPx: number } | null
  anchorInWindow: boolean
  unreadOpenPosition: UnreadOpenPosition | null
  readStateResolved: boolean
  dividerEventId: string | undefined
}): "wait" | StreamLanding {
  if (args.hasDeepLink || args.isJumpMode) return { kind: "deep-link" }
  if (args.userInteractedAt > 0) return { kind: "owned" }
  if (args.isLoading || !args.hasItems) return "wait"
  if (!args.isPushNavigation && args.anchor !== null && args.anchorInWindow) {
    return { kind: "restore", targetId: args.anchor.targetId, offsetPx: args.anchor.offsetPx }
  }
  if (args.unreadOpenPosition === null) return "wait"
  if (args.unreadOpenPosition === "marker") {
    if (!args.readStateResolved) return "wait"
    if (args.dividerEventId) return { kind: "marker", dividerEventId: args.dividerEventId }
  }
  return { kind: "tail" }
}

/** The topmost timeline row intersecting the scroller viewport, with its
 *  offset from the viewport top (negative when partially scrolled off). */
function snapshotTopVisibleRow(el: HTMLElement): { id: string; offsetPx: number } | null {
  const sr = el.getBoundingClientRect()
  let best: { id: string; top: number } | null = null
  for (const row of el.querySelectorAll<HTMLElement>("[data-message-id], [data-event-id]")) {
    const rr = row.getBoundingClientRect()
    if (rr.bottom <= sr.top + 1 || rr.top >= sr.bottom) continue
    const id = row.dataset.messageId ?? row.dataset.eventId
    if (!id) continue
    if (!best || rr.top < best.top) best = { id, top: rr.top }
  }
  return best ? { id: best.id, offsetPx: Math.round(best.top - sr.top) } : null
}

/**
 * Every full-window derivation between the raw event window and the rows virtua
 * renders — grouping/annotation/injection, the message meta map, the filter and
 * divider passes, and the zero-height patch collectors — times into one
 * `timeline.derive` name, so the samples for one emission sum to the chain's
 * cost. It is the control on the bounded-read win: if the read cost falls and
 * this rises by as much, the cost moved rather than shrank.
 */
function timeDerive<T>(compute: () => T): T {
  const stopDerive = getPerfCapture().time("timeline.derive")
  try {
    return compute()
  } finally {
    stopDerive()
  }
}

const EMPTY_ACTIVITY_SUMMARY: AgentActivitySummaryEntry[] = []

/** One running session collapsed from the per-message activity map. */
export interface DedupedRunningSession {
  sessionId: string
  personaName: string
  stepCount: number
}

/**
 * Collapse the per-message agent-activity map to one entry per session. The map
 * aliases a thread session under two keys (trigger + parent message), so first
 * occurrence wins for personaName/stepCount.
 */
export function dedupeRunningSessions(
  agentActivity: Map<string, MessageAgentActivity> | undefined
): DedupedRunningSession[] {
  if (!agentActivity || agentActivity.size === 0) return []
  const bySession = new Map<string, DedupedRunningSession>()
  for (const activity of agentActivity.values()) {
    if (bySession.has(activity.sessionId)) continue
    bySession.set(activity.sessionId, {
      sessionId: activity.sessionId,
      personaName: activity.personaName,
      stepCount: activity.stepCount,
    })
  }
  return Array.from(bySession.values())
}

/**
 * Order the running sessions into the header chip's summary: most recently
 * started first. Ordering keys off each session's `started` event when the
 * timeline holds it (its own stream); channel-view sessions known only from
 * socket carry no start time and sort last, so the chip's "most recent" click
 * target favours a session whose lifecycle this stream actually owns.
 */
export function buildAgentActivitySummary(
  agentActivity: Map<string, MessageAgentActivity> | undefined,
  events: StreamEvent[]
): AgentActivitySummaryEntry[] {
  const sessions = dedupeRunningSessions(agentActivity)
  if (sessions.length === 0) return EMPTY_ACTIVITY_SUMMARY
  const startedAtBySession = new Map<string, string>()
  for (const event of events) {
    if (event.eventType === "agent_session:started") {
      const payload = event.payload as AgentSessionStartedPayload
      startedAtBySession.set(payload.sessionId, payload.startedAt)
    }
  }
  const list = sessions.map(({ sessionId, personaName, stepCount }) => ({ sessionId, personaName, stepCount }))
  list.sort((a, b) =>
    (startedAtBySession.get(b.sessionId) ?? "").localeCompare(startedAtBySession.get(a.sessionId) ?? "")
  )
  return list
}

interface StreamContentProps {
  workspaceId: string
  streamId: string
  highlightMessageId?: string | null
  isDraft?: boolean
  /** Pre-fetched stream data from parent - avoids duplicate bootstrap call */
  stream?: Stream
  /** Auto-focus the message input when mounted */
  autoFocus?: boolean
}

export function StreamContent({
  workspaceId,
  streamId,
  highlightMessageId,
  isDraft = false,
  stream: streamFromProps,
  autoFocus,
}: StreamContentProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigationType = useNavigationType()
  const socket = useSocket()
  const messageService = useMessageService()
  // Tracks the location key we've already handled for a highlight jump. Using
  // the key (not the message id) lets re-clicking the same message link
  // re-trigger the scroll — react-router generates a fresh key on every
  // navigation even when the URL is identical, which it auto-replaces.
  const jumpTriggeredKeyRef = useRef<string | null>(null)
  // Set when a deep-link (?m=) jump can never resolve (target deleted / no
  // access / fetch failed). Releases the deep-link mount hold so the timeline
  // falls back to the loaded window instead of holding the skeleton forever.
  const [deepLinkGaveUp, setDeepLinkGaveUp] = useState(false)
  // Set when the deep-link mount hold has been up for DEEP_LINK_HOLD_MAX_MS
  // without the target landing — releases the skeleton in favor of the cached
  // window while the jump keeps working. Re-armed with deepLinkGaveUp.
  const [deepLinkHoldExpired, setDeepLinkHoldExpired] = useState(false)
  const user = useUser()
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [mobileComposerTyping, setMobileComposerTyping] = useState(false)
  // True while an out-of-window search navigation is fetching its event window —
  // drives the search bar's spinner so a tap that needs a round-trip is visibly
  // loading instead of appearing dead. Versioned so a superseding navigation's
  // completion doesn't clear a newer one's spinner.
  const [isSearchNavigating, setIsSearchNavigating] = useState(false)
  const searchNavVersionRef = useRef(0)
  // Target of the most recent out-of-window search navigation — lets close
  // distinguish the search's own pendingScrollTarget from a deep-link's.
  const searchNavTargetRef = useRef<string | null>(null)
  // Lifecycle of that navigation: "fetching" until jumpToEvent resolves,
  // "swapped" once the window changed (the post-jump driver owns the landing
  // from there), "idle" otherwise. Abandoning paths cancel a "fetching"
  // navigation outright but let a "swapped" one finish landing — killing it
  // mid-way would strand the swapped window unanchored at an arbitrary
  // position. The phase alone can go stale (a foreign jump superseding the
  // search nav doesn't reset it), so cancels also pass the generation the
  // search's own jump claimed (searchNavGenRef) — an ownership-checked
  // cancel no-ops when the in-flight jump isn't search's.
  const searchNavPhaseRef = useRef<"idle" | "fetching" | "swapped">("idle")
  const searchNavGenRef = useRef(0)
  const [batchMode, setBatchMode] = useState(false)
  // What the current batch selection is for. `moveToThread` (default) drags the
  // selection onto a target message; `splitConversation` reassigns the selection's
  // conversation membership via the footer target picker (no drag, no drop target).
  const [batchIntent, setBatchIntent] = useState<BatchSelectIntent>("moveToThread")
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(() => new Set())
  const [hoveredBatchTargetId, setHoveredBatchTargetId] = useState<string | null>(null)
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number } | null>(null)
  // Single source of truth for the move flow: opens the dialog immediately on
  // drop with the real message count from selection (no need to wait for the
  // server). `leaseKey` stays null while validate is in flight, then gets
  // patched in on success — that transition is what flips the inline footer
  // status from "Verifying…" to "Verified" with the check pop-in.
  const [moveAttempt, setMoveAttempt] = useState<{
    targetMessageId: string
    messageIds: string[]
    leaseKey: string | null
  } | null>(null)
  const [isMoveConfirming, setIsMoveConfirming] = useState(false)
  // Cancellation guard: when the user dismisses the dialog while validation
  // is still in flight, we increment this token. The async handler reads the
  // ref at resolution time and bails out if the token has moved on. Cheaper
  // than threading AbortSignal through the api client just for one path.
  const moveAttemptTokenRef = useRef(0)
  const suppressNextBatchClickRef = useRef(false)
  const suppressNextBatchClickTimerRef = useRef<number | null>(null)
  const batchPointerRef = useRef<{
    id: number
    messageId: string
    x: number
    y: number
    dragging: boolean
    wasSelected: boolean
  } | null>(null)

  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbMemberships = useWorkspaceStreamMemberships(workspaceId)
  const idbReadStates = useWorkspaceStreamReadStates(workspaceId)
  const idbStream = useMemo(() => idbStreams.find((candidate) => candidate.id === streamId), [idbStreams, streamId])

  // Resolve current workspace-scoped user ID. The hook deduplicates with SentMessageEvent instances.
  const currentWorkspaceUserId = useWorkspaceUserId(workspaceId)
  const idbMembership = useMemo(
    () =>
      currentWorkspaceUserId
        ? idbMemberships.find(
            (membership) => membership.streamId === streamId && membership.memberId === currentWorkspaceUserId
          )
        : undefined,
    [currentWorkspaceUserId, idbMemberships, streamId]
  )
  const { data: bootstrap } = useStreamBootstrap(workspaceId, streamId, {
    enabled: !isDraft && (!idbStream || !idbMembership),
  })
  const membership = idbMembership ?? bootstrap?.membership
  // Read frontier: stream_read_state is the sole source. A present row wins —
  // a null watermark is an explicit unread-to-zero.
  const idbReadState = useMemo(
    () => idbReadStates.find((candidate) => candidate.streamId === streamId),
    [idbReadStates, streamId]
  )
  // The per-stream bootstrap carries the viewer's frontier; IDB catches up a
  // tick after the query resolves, so consult the in-memory payload for first
  // paint. A confirmed-absent row (null) resolves as never-read (frontier
  // before the first message).
  const bootstrapReadState = useMemo(() => {
    const rs = bootstrap?.readState
    if (rs) return rs
    if (rs === null) return { lastReadEventId: null, lastReadSequence: null, lastReadAt: null }
    return undefined
  }, [bootstrap?.readState])
  const lastReadEventId = resolveFrontierEventId(idbReadState ?? bootstrapReadState)
  const frontierSequence = resolveFrontierSequence(idbReadState ?? bootstrapReadState)

  const stream = streamFromProps ?? idbStream ?? bootstrap?.stream
  const isThread = stream?.type === StreamTypes.THREAD
  const isSystem = stream?.type === StreamTypes.SYSTEM
  // Archived state is root-inherited (INV-62); the shared hook owns the
  // two-source resolution (root row in the stream cache, else the per-stream
  // bootstrap's cold-load verdict).
  const rootStreamId = isThread ? (stream?.rootStreamId ?? null) : null
  // The root row is resolved here, from the warm workspace-stream cache this
  // component already reads, rather than left to the hook: a self-resolving
  // read reports the root absent on the mount's first render, so a stale
  // bootstrap verdict would flash the archived notice over the composer.
  const rootFromCache = useMemo(
    () => (rootStreamId ? (idbStreams.find((candidate) => candidate.id === rootStreamId) ?? null) : null),
    [idbStreams, rootStreamId]
  )
  const { rootArchived, isArchived } = useEffectiveArchived({
    stream,
    rootStreamId,
    rootStream: rootFromCache,
    fallbackRootArchived: bootstrap?.rootArchivedAt,
  })

  // Conversation overlay (channels/DMs): URL-derived so a refresh or shared
  // link restores the same view (INV-59). The stream header owns the toggle;
  // this component reads the param, fetches conversations while active, and
  // threads the overlay context into the timeline rows.
  const supportsConversationOverlay =
    !isDraft && (stream?.type === StreamTypes.CHANNEL || stream?.type === StreamTypes.DM)
  const conversationOverlayActive = supportsConversationOverlay && searchParams.get("convOverlay") === "on"
  const { context: conversationOverlay, inViewConversations } = useConversationOverlay({
    workspaceId,
    streamId,
    enabled: conversationOverlayActive,
  })
  // Always-on membership for the per-message "Show in conversation" action — it
  // should open the conversation panel without the user first painting the
  // overlay. A conversation spans its root + the root's threads (one root), so a
  // THREAD view resolves membership from the ROOT's conversation list (where the
  // thread's replies live as secondary members and the opener as primary), not
  // the thread's own list (which has none). A channel/DM uses its own list. The
  // query key matches the overlay's when both are live, so they dedupe.
  const conversationMembershipStreamId = isThread ? rootStreamId : streamId
  const conversationMembershipEnabled =
    !isDraft && !!conversationMembershipStreamId && (isThread || supportsConversationOverlay)
  const { conversations: streamConversations, refetch: refetchStreamConversations } = useConversations(
    workspaceId,
    conversationMembershipStreamId ?? "",
    { enabled: conversationMembershipEnabled }
  )
  const conversationIdByMessageId = useMemo(
    () => buildMessageConversationMap(streamConversations),
    [streamConversations]
  )
  const closeConversationOverlay = useCallback(() => {
    setSearchParams(
      (prev) => {
        prev.delete("convOverlay")
        return prev
      },
      { replace: true }
    )
  }, [setSearchParams])
  // Move-to-thread batch mode suspends the whole overlay (legend, rails, chips,
  // correction swatch) — batch turns every row into a selection toggle, and the
  // overlay's swatch would compete for the same clicks. Split-conversation batch
  // mode KEEPS the overlay on: the coloring is what tells the user which topic
  // each message currently belongs to while they pick what to move. The overlay
  // row hides its own correction swatch while a selection is active (the swatch
  // renders outside the row's `inert` slot, so it needs its own gate — see
  // `ConversationOverlayRow.selectionActive`). The URL param is kept, so the
  // overlay returns when move-to-thread batch mode ends.
  const activeConversationOverlay = batchMode && batchIntent === "moveToThread" ? undefined : conversationOverlay
  const parentStreamId = stream?.parentStreamId
  // The thread's anchor: a message (`msg_…`) or a card (`event_…`), located in the
  // parent timeline by its canonical id. `matchesDeepLinkTarget` is exactly this
  // lookup (payload.messageId for messages, event id for cards).
  // Legacy IDB rows (cached before anchor unification) carry only
  // `parentMessageId`; read it off the cached row so an offline-first startup
  // resolves the anchor before the next online bootstrap rewrites the row.
  const anchorId = stream ? (stream.parentAnchorId ?? idbStream?.parentMessageId ?? null) : null
  const parentCachedEvents = useStreamEvents(parentStreamId ?? undefined)
  const cachedAnchorEvent = useMemo(() => {
    if (!isThread || !parentStreamId || !anchorId || !parentCachedEvents) return null
    return parentCachedEvents.find((event) => matchesDeepLinkTarget(event, anchorId))
  }, [isThread, parentStreamId, anchorId, parentCachedEvents])

  // Fetch parent stream bootstrap (for threads to get the anchor item)
  // Only fetch when we have a valid parentStreamId
  const { data: parentBootstrap } = useStreamBootstrap(workspaceId, parentStreamId!, {
    enabled: !isDraft && isThread && !!parentStreamId && !!anchorId && !cachedAnchorEvent,
  })

  const localAnchorEvent = useMemo(() => {
    if (!isThread || !parentStreamId || !anchorId) return null
    if (cachedAnchorEvent) return cachedAnchorEvent as unknown as StreamEvent
    return parentBootstrap?.events.find((event) => matchesDeepLinkTarget(event, anchorId)) ?? null
  }, [cachedAnchorEvent, isThread, parentStreamId, anchorId, parentBootstrap?.events])
  const { event: anchorEvent } = useThreadAnchorEvent(
    workspaceId,
    isThread ? parentStreamId : null,
    anchorId,
    localAnchorEvent
  )

  // Subscribe to stream room FIRST (subscribe-then-bootstrap pattern)
  useStreamSocket(workspaceId, streamId, { enabled: !isDraft })

  const {
    events,
    holes,
    isLoading,
    isConfirmedEmpty,
    error,
    fetchOlderEvents,
    hasOlderEvents,
    isFetchingOlder,
    fetchNewerEvents,
    hasNewerEvents,
    isFetchingNewer,
    jumpToEvent,
    jumpToEventByDate,
    exitJumpMode,
    cancelPendingJump,
    currentJumpGeneration,
    isJumpMode,
  } = useEvents(workspaceId, streamId, { enabled: !isDraft, loadAll: isThread })

  // The viewer's newest message in this stream — drives the "Show in
  // conversation" membership heal below.
  const ownLatestMessageId = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.eventType !== "message_created" || event.actorId !== currentWorkspaceUserId) continue
      return (event.payload as { messageId?: string })?.messageId ?? null
    }
    return null
  }, [events, currentWorkspaceUserId])
  useConversationMembershipHeal({
    enabled: conversationMembershipEnabled,
    latestOwnMessageId: ownLatestMessageId,
    conversationIdByMessageId,
    refetch: refetchStreamConversations,
  })

  // Slot read model (Amendment A3): the canonical map lives in `db.slots`, fed
  // by the sync layer — bootstrap/page/anchor carriers are written there, never
  // merged in render. Read the current stream's rows plus, for a thread, the
  // parent stream's rows (the one parent anchor's pointers live there). Current
  // wins a collision because the provider primarily renders current-stream
  // events; parent rows are fallback for the anchor.
  const currentSlots = useStreamSlots(streamId)
  const parentSlots = useStreamSlots(isThread ? parentStreamId : null)
  const mergedSlots = useMemo(() => ({ ...parentSlots, ...currentSlots }), [parentSlots, currentSlots])

  // For drafts, query pending/failed events directly from IDB so optimistic
  // messages are visible while offline or waiting for queue processing.
  const draftPendingEvents = useStreamEvents(isDraft ? streamId : undefined)
  const hasDraftPendingEvents = isDraft && draftPendingEvents && draftPendingEvents.length > 0

  const editLastMessageCtx = useEditLastMessageTrigger(events, currentWorkspaceUserId)

  // Track live agent session progress for all stream types (step/message counts on session cards).
  // In channels, session cards are hidden (responses go to threads) and inline activity shows on trigger messages instead.
  const isChannel = stream?.type === StreamTypes.CHANNEL
  const agentActivity = useAgentActivity(events, socket, workspaceId, currentWorkspaceUserId, streamId)

  // Publish a running-session summary up to the header chip. No-ops for a
  // thread-panel StreamContent (mounted outside the open stream's provider).
  const publishAgentActivitySummary = usePublishAgentActivitySummary()
  const agentActivitySummary = useMemo(() => buildAgentActivitySummary(agentActivity, events), [agentActivity, events])
  useEffect(() => {
    publishAgentActivitySummary(agentActivitySummary)
  }, [agentActivitySummary, publishAgentActivitySummary])
  useEffect(() => () => publishAgentActivitySummary(EMPTY_ACTIVITY_SUMMARY), [publishAgentActivitySummary])

  // E2E streams search decrypted bodies client-side (the server only holds
  // ciphertext); pass the flag + viewer id so the hook can resolve the session.
  const streamSearch = useStreamSearch({
    workspaceId,
    streamId,
    e2eEnabled: stream?.e2eEnabled === true,
    userId: currentWorkspaceUserId,
  })
  const clearSearch = streamSearch.clear
  const openOrFocusSearch = useCallback(() => {
    if (isSearchOpen) {
      streamSearch.focus()
    } else {
      setIsSearchOpen(true)
    }
  }, [isSearchOpen, streamSearch])

  useKeyboardShortcuts(
    {
      searchInStream: openOrFocusSearch,
    },
    !isThread && !isDraft
  )

  // Header search button dispatches a custom event so it can share the same open/focus path.
  useEffect(() => {
    if (isThread || isDraft) return

    document.addEventListener("threa:open-stream-search", openOrFocusSearch)
    return () => {
      document.removeEventListener("threa:open-stream-search", openOrFocusSearch)
    }
  }, [isDraft, isThread, openOrFocusSearch])

  const handleSearchClose = useCallback(() => {
    setIsSearchOpen(false)
    // Closing abandons a still-fetching navigation. Without this the jump
    // resolves up to seconds later and swaps/scrolls the window under a user
    // who has moved on. A "swapped" navigation is past the point of no return
    // — keep its pendingScrollTarget so the post-jump driver finishes landing
    // instead of stranding the swapped window unanchored.
    if (searchNavPhaseRef.current === "fetching") {
      cancelPendingJump(searchNavGenRef.current)
      if (pendingScrollTarget.current && pendingScrollTarget.current === searchNavTargetRef.current) {
        pendingScrollTarget.current = null
      }
    }
    searchNavPhaseRef.current = "idle"
    searchNavVersionRef.current++
    setIsSearchNavigating(false)
    clearSearch()
  }, [clearSearch, cancelPendingJump])

  // Escape closes search when focus is outside the search input.
  useEffect(() => {
    if (!isSearchOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable

      if (event.key === "Escape" && !isInput) {
        handleSearchClose()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isSearchOpen, handleSearchClose])

  // Compute timeline items in StreamContent so the virtualizer can use count + keys.
  // After grouping commands/sessions, annotate consecutive same-author message runs
  // with `groupContinuation` so MessageEvent can collapse the repeated header row.
  // Membership events are suppressed in threads: thread participation is implicit
  // (replying joins you, the parent author is auto-added), so "X was added to the
  // conversation" reads as noise next to the author who clearly is here.
  const displayEvents = useMemo(() => {
    if (!isThread) return events
    return orderStreamEvents(
      events.filter((event) => !THREAD_HIDDEN_EVENT_TYPES.has(event.eventType)),
      (a, b) => {
        const timeDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        if (timeDelta !== 0) return timeDelta
        return a.id.localeCompare(b.id)
      }
    )
  }, [events, isThread])

  // See remapSuppressedWatermark: a fresh thread member's watermark sits on a
  // membership event that threads hide from the rendered window; the auto-read
  // frontier (useLastSeenEvent) needs it remapped to a rendered position.
  const frontierLastReadEventId = useMemo(
    () => (isThread ? remapSuppressedWatermark(lastReadEventId, events, displayEvents) : lastReadEventId),
    [isThread, lastReadEventId, events, displayEvents]
  )
  const frontierLastReadSequence = useMemo(() => {
    if (frontierLastReadEventId === lastReadEventId) return frontierSequence
    if (frontierLastReadEventId == null) return frontierLastReadEventId
    const remapped = displayEvents.find((event) => event.id === frontierLastReadEventId)
    return remapped ? BigInt(remapped.sequence) : undefined
  }, [displayEvents, frontierLastReadEventId, frontierSequence, lastReadEventId])

  // Conversation lookup for the always-on provenance chips (mechanism A below).
  const conversationsById = useMemo(() => {
    const map = new Map<string, ConversationWithStaleness>()
    for (const conversation of streamConversations) map.set(conversation.id, conversation)
    return map
  }, [streamConversations])
  // Gap placeholders are injected AFTER grouping/annotation so a hole in the
  // broadcast chain (INV-61) renders as its own in-place loading row — see
  // useEvents' contiguity gate for how holes are detected and backfilled.
  const conversationOverlayModel = conversationOverlay?.model
  const timelineItems = useMemo(
    () =>
      timeDerive(() => {
        let items = annotateAuthorGroups(groupTimelineItems(displayEvents, currentWorkspaceUserId ?? undefined))
        if (conversationOverlayModel && conversationOverlayModel.conversations.length > 0) {
          items = annotateConversationRows(items, conversationOverlayModel)
        }
        // On-message provenance chips (board-view-design.md mechanism A): a late
        // reply that revives a scattered topic gets a "↪ continues X · 3h ago" chip
        // linking to the conversation panel. Always-on for the flat channel/DM
        // timeline (never threads — thread replies are contiguous by construction,
        // so nothing reads as a revival there).
        if (supportsConversationOverlay) {
          items = annotateConversationRevivals(items, conversationIdByMessageId, conversationsById)
        }
        return injectGapItems(items, holes)
      }),
    [
      displayEvents,
      currentWorkspaceUserId,
      holes,
      conversationOverlayModel,
      supportsConversationOverlay,
      conversationIdByMessageId,
      conversationsById,
    ]
  )

  // `order` is the position in the rendered timeline. Non-thread streams
  // happen to sort by sequence already, but threads re-sort by
  // (createdAt, id) — once moved messages land in a thread, their sequence
  // (assigned in the destination's event log) can diverge from their visual
  // position. Validating "target precedes selection" against `order` keeps
  // batch UI consistent with what the user sees.
  const messageEventMeta = useMemo(
    () =>
      timeDerive(() => {
        const meta = new Map<string, { order: number; content: string }>()
        let order = 0
        for (const event of displayEvents) {
          if (event.eventType !== "message_created") continue
          const payload = event.payload as { messageId?: string; contentMarkdown?: string; deletedAt?: string }
          if (!payload.messageId || payload.deletedAt) continue
          meta.set(payload.messageId, { order: order++, content: payload.contentMarkdown ?? "" })
        }
        return meta
      }),
    [displayEvents]
  )

  const selectedOrderFloor = useMemo(() => {
    let min: number | null = null
    for (const messageId of selectedMessageIds) {
      const order = messageEventMeta.get(messageId)?.order
      if (order === undefined) continue
      min = min === null || order < min ? order : min
    }
    return min
  }, [messageEventMeta, selectedMessageIds])

  const invalidBatchTargetIds = useMemo(() => {
    const invalid = new Set<string>()
    if (!batchMode || !dragGhost || selectedOrderFloor === null) return invalid
    for (const [messageId, meta] of messageEventMeta) {
      if (selectedMessageIds.has(messageId) || meta.order >= selectedOrderFloor) {
        invalid.add(messageId)
      }
    }
    return invalid
  }, [batchMode, dragGhost, messageEventMeta, selectedMessageIds, selectedOrderFloor])

  const isValidBatchTarget = useCallback(
    (messageId: string | null) => {
      if (!messageId || selectedOrderFloor === null) return false
      const meta = messageEventMeta.get(messageId)
      return !!meta && !selectedMessageIds.has(messageId) && meta.order < selectedOrderFloor
    },
    [messageEventMeta, selectedMessageIds, selectedOrderFloor]
  )

  const startBatchSelect = useCallback(
    (intent: BatchSelectIntent, preselectedMessageId?: string) => {
      setBatchMode(true)
      setBatchIntent(intent)
      setSelectedMessageIds(preselectedMessageId ? new Set([preselectedMessageId]) : new Set())
      setHoveredBatchTargetId(null)
      setDragGhost(null)
      // Selection and search share the same flush-top strip; keep one open at a
      // time so they can't stack. Search bar's own listeners handle the reverse.
      handleSearchClose()
    },
    [handleSearchClose]
  )

  const toggleBatchMessage = useCallback((messageId: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return next
    })
  }, [])

  const cancelBatchMode = useCallback(() => {
    setBatchMode(false)
    setSelectedMessageIds(new Set())
    setHoveredBatchTargetId(null)
    setDragGhost(null)
    // Bump the cancellation token so any in-flight validate becomes a no-op
    // before clearing the attempt — otherwise its setMoveAttempt could race
    // back in after we've moved on.
    moveAttemptTokenRef.current += 1
    setMoveAttempt(null)
    batchPointerRef.current = null
    suppressNextBatchClickRef.current = false
    if (suppressNextBatchClickTimerRef.current !== null) {
      window.clearTimeout(suppressNextBatchClickTimerRef.current)
      suppressNextBatchClickTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return addStartBatchSelectListener((detail) => {
      if (detail.streamId !== streamId) return
      startBatchSelect(detail.intent, detail.preselectedMessageId)
    })
  }, [startBatchSelect, streamId])

  useEffect(() => {
    cancelBatchMode()
    suppressNextBatchClickRef.current = false
  }, [streamId, cancelBatchMode])

  const batchState = useMemo<BatchTimelineState | undefined>(
    () => ({
      enabled: batchMode,
      dragSelect: batchIntent === "moveToThread",
      selectedMessageIds,
      invalidTargetIds: invalidBatchTargetIds,
      hoveredTargetId: hoveredBatchTargetId,
      onToggleMessage: toggleBatchMessage,
    }),
    [batchMode, batchIntent, selectedMessageIds, invalidBatchTargetIds, hoveredBatchTargetId, toggleBatchMessage]
  )

  const findMessageIdFromPoint = useCallback((x: number, y: number) => {
    const element = document.elementFromPoint(x, y)
    return element?.closest<HTMLElement>("[data-message-id]")?.dataset.messageId ?? null
  }, [])

  const dropBatchOnTarget = useCallback(
    async (targetMessageId: string) => {
      const messageIds = Array.from(selectedMessageIds)
      if (messageIds.length === 0 || moveAttempt) return
      // Open the dialog immediately with the client-side count so the question
      // is on screen the moment the user releases — validation runs in the
      // background and patches in the lease when it returns.
      const token = ++moveAttemptTokenRef.current
      setMoveAttempt({ targetMessageId, messageIds, leaseKey: null })
      try {
        const validation = await messageService.validateMoveToThread(workspaceId, {
          sourceStreamId: streamId,
          targetMessageId,
          messageIds,
        })
        if (moveAttemptTokenRef.current !== token) return
        setMoveAttempt((prev) => (prev ? { ...prev, leaseKey: validation.leaseKey } : null))
      } catch (error) {
        if (moveAttemptTokenRef.current !== token) return
        console.error("validateMoveToThread failed", { error, streamId, targetMessageId, messageIds })
        toast.error(error instanceof Error ? error.message : "Could not validate this move")
        setMoveAttempt(null)
      }
    },
    [messageService, moveAttempt, selectedMessageIds, streamId, workspaceId]
  )

  const confirmPendingMove = useCallback(async () => {
    if (!moveAttempt?.leaseKey || isMoveConfirming) return
    const { targetMessageId, messageIds, leaseKey } = moveAttempt
    setIsMoveConfirming(true)
    try {
      await messageService.moveToThread(workspaceId, {
        sourceStreamId: streamId,
        targetMessageId,
        messageIds,
        leaseKey,
      })
      cancelBatchMode()
    } catch (error) {
      console.error("moveToThread failed", { error, streamId, moveAttempt })
      toast.error(error instanceof Error ? error.message : "Could not move messages")
    } finally {
      setIsMoveConfirming(false)
    }
  }, [cancelBatchMode, isMoveConfirming, messageService, moveAttempt, streamId, workspaceId])

  const closePendingMove = useCallback(() => {
    if (isMoveConfirming) return
    // Bump the token so any in-flight validation no-ops on resolve.
    moveAttemptTokenRef.current += 1
    setMoveAttempt(null)
  }, [isMoveConfirming])

  // Split-conversation batch action: reassign the current selection to another
  // conversation (`targetConversationId`) or a new one (null). Membership-only —
  // no confirm dialog, unlike move-to-thread, since it's reversible by moving the
  // messages back. Exits batch mode on success; the overlay recolors from cache.
  //
  // `streamId`, not `rootStreamId`: split is only reachable while the conversation
  // overlay is active, which is CHANNEL/DM-only (`supportsConversationOverlay`) —
  // never a thread — so `streamId` here IS the conversation root, matches the
  // overlay's `useConversations` cache key, and is the stream the selected rows
  // actually live in (the backend requires `message.streamId === streamId`).
  const reassignMessages = useReassignMessagesToConversation(workspaceId, streamId)
  const [isSplitting, setIsSplitting] = useState(false)
  const runSplit = useCallback(
    (targetConversationId: string | null) => {
      const messageIds = Array.from(selectedMessageIds)
      if (messageIds.length === 0 || isSplitting) return
      setIsSplitting(true)
      reassignMessages.mutate(
        { messageIds, targetConversationId },
        {
          onSuccess: () => cancelBatchMode(),
          onError: (error) =>
            toast.error(error instanceof Error ? error.message : "Couldn't move the selected messages"),
          onSettled: () => setIsSplitting(false),
        }
      )
    },
    [cancelBatchMode, isSplitting, reassignMessages, selectedMessageIds]
  )

  // Phase derived from the single source of truth. Drives the inline status
  // row in the footer and the disabled/aria-busy state of the Move button.
  let movePhase: MovePhase
  if (isMoveConfirming) {
    movePhase = "moving"
  } else if (moveAttempt?.leaseKey) {
    movePhase = "validated"
  } else {
    movePhase = "validating"
  }
  const moveDialogOpen = !!moveAttempt
  const moveMessageCount = moveAttempt?.messageIds.length ?? 0
  const moveMessageCountLabel = `${moveMessageCount} selected message${moveMessageCount === 1 ? "" : "s"}`

  // The drag-onto-a-target gesture belongs to move-to-thread only. Split mode
  // attaches nothing here: each row toggles via its own `onClick`, so native
  // touch scrolling stays intact (see BatchTimelineState.dragSelect).
  const batchPointerHandlers =
    batchMode && batchIntent === "moveToThread"
      ? {
          onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
            const target = event.target as HTMLElement
            if (target.closest("[data-batch-control]")) return
            const messageId = target.closest<HTMLElement>("[data-message-id]")?.dataset.messageId
            if (!messageId) return
            event.preventDefault()
            batchPointerRef.current = {
              id: event.pointerId,
              messageId,
              x: event.clientX,
              y: event.clientY,
              dragging: false,
              wasSelected: selectedMessageIds.has(messageId),
            }
            if (!selectedMessageIds.has(messageId)) {
              setSelectedMessageIds((prev) => new Set(prev).add(messageId))
            }
          },
          onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
            const pointer = batchPointerRef.current
            if (!pointer || pointer.id !== event.pointerId) return
            const distance = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y)
            if (!pointer.dragging && distance < 6) return
            event.preventDefault()
            if (!pointer.dragging && !selectedMessageIds.has(pointer.messageId)) {
              setSelectedMessageIds((prev) => new Set(prev).add(pointer.messageId))
            }
            pointer.dragging = true
            setDragGhost({ x: event.clientX, y: event.clientY })
            const targetId = findMessageIdFromPoint(event.clientX, event.clientY)
            const validTargetId = isValidBatchTarget(targetId) ? targetId : null
            setHoveredBatchTargetId((previous) => {
              if (previous !== validTargetId && validTargetId && "vibrate" in navigator) {
                navigator.vibrate?.(10)
              }
              return validTargetId
            })
          },
          onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
            const pointer = batchPointerRef.current
            if (!pointer || pointer.id !== event.pointerId) return
            event.preventDefault()
            suppressNextBatchClickRef.current = true
            if (suppressNextBatchClickTimerRef.current !== null) {
              window.clearTimeout(suppressNextBatchClickTimerRef.current)
            }
            suppressNextBatchClickTimerRef.current = window.setTimeout(() => {
              suppressNextBatchClickRef.current = false
              suppressNextBatchClickTimerRef.current = null
            }, 350)
            const targetId = hoveredBatchTargetId
            const wasDragging = pointer.dragging
            batchPointerRef.current = null
            setDragGhost(null)
            setHoveredBatchTargetId(null)
            if (!wasDragging) {
              setSelectedMessageIds((prev) => {
                const next = new Set(prev)
                if (pointer.wasSelected) {
                  next.delete(pointer.messageId)
                } else {
                  next.add(pointer.messageId)
                }
                return next
              })
              return
            }
            if (wasDragging && targetId && isValidBatchTarget(targetId)) {
              void dropBatchOnTarget(targetId)
            }
          },
          onPointerCancel: () => {
            batchPointerRef.current = null
            setDragGhost(null)
            setHoveredBatchTargetId(null)
            suppressNextBatchClickRef.current = false
            if (suppressNextBatchClickTimerRef.current !== null) {
              window.clearTimeout(suppressNextBatchClickTimerRef.current)
              suppressNextBatchClickTimerRef.current = null
            }
          },
          onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
            if (!suppressNextBatchClickRef.current) return
            suppressNextBatchClickRef.current = false
            event.preventDefault()
            event.stopPropagation()
          },
        }
      : {}

  // For drafts with pending events, compute timeline items from those events. Drafts
  // are a single-author transcript already, but running the same pipeline keeps the
  // rendering branch identical whether an event is committed or pending.
  const draftTimelineItems = useMemo(
    () => (hasDraftPendingEvents ? annotateAuthorGroups(groupTimelineItems(draftPendingEvents!, user?.id)) : []),
    [hasDraftPendingEvents, draftPendingEvents, user?.id]
  )

  // Use virtualized scroll for non-thread views, plain scroll for threads
  const useVirtualized = !isThread

  // A fast scroll can reach the top of the loaded window before the older
  // page lands; without placeholders that space is plain blank and reads as
  // broken. Track each older fetch from its start: capture the oldest
  // rendered event id, show skeletons once the fetch outlives the appear
  // delay, and hide them the moment the oldest id changes — i.e. in the same
  // render the prepend lands (see shouldShowOlderSkeletons). Virtualized
  // streams only: threads load all history up front and render their own
  // inline loading row. Deep-link jumps (jumpToEvent) never set
  // isFetchingOlder, so a programmatic jump's window fetch can't trigger this.
  const oldestEventId = events.length > 0 ? events[0].id : null
  const oldestEventIdRef = useRef(oldestEventId)
  oldestEventIdRef.current = oldestEventId
  const [olderSkeletonTrackedId, setOlderSkeletonTrackedId] = useState<string | null>(null)
  const [olderSkeletonReady, setOlderSkeletonReady] = useState(false)

  // Arm the tracker whenever a fetch is in flight and nothing is tracked.
  // Gated on the tracker being empty (not just the isFetchingOlder rising
  // edge) so it self-re-arms when a prepend lands mid-fetch: with
  // back-to-back pages, fetch N+1 can start before fetch N's rows have
  // propagated out of IDB, so a rising-edge capture would record the stale
  // pre-page-N head — page N landing would then retire the tracker and leave
  // fetch N+1 with no skeleton coverage. Instead the landed cleanup below
  // clears the tracker and this effect immediately re-arms it against the
  // new head while the fetch is still in flight.
  useEffect(() => {
    if (!isFetchingOlder || !useVirtualized || olderSkeletonTrackedId !== null) return
    setOlderSkeletonTrackedId(oldestEventIdRef.current)
  }, [isFetchingOlder, useVirtualized, olderSkeletonTrackedId])

  // Appear delay: commit to skeletons only once the fetch has been in flight
  // long enough that they won't flash for a fast response.
  useEffect(() => {
    if (olderSkeletonTrackedId === null) {
      setOlderSkeletonReady(false)
      return
    }
    const timer = window.setTimeout(() => setOlderSkeletonReady(true), OLDER_SKELETON_APPEAR_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [olderSkeletonTrackedId])

  // The prepend landed (or the stream switched): visibility already dropped in
  // that same render via shouldShowOlderSkeletons; this just retires the
  // tracker so the next fetch starts clean.
  const olderPrependLanded = olderSkeletonTrackedId !== null && oldestEventId !== olderSkeletonTrackedId
  useEffect(() => {
    if (olderPrependLanded) setOlderSkeletonTrackedId(null)
  }, [olderPrependLanded])

  // Fetch settled without a prepend (failed request, or the final page was
  // empty): give the IDB live query a grace window, then clear so skeletons
  // can't hang. A new fetch re-arms via the rising-edge effect above.
  useEffect(() => {
    if (olderSkeletonTrackedId === null || isFetchingOlder) return
    const timer = window.setTimeout(() => setOlderSkeletonTrackedId(null), OLDER_SKELETON_SETTLE_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [olderSkeletonTrackedId, isFetchingOlder])

  const showOlderSkeletons =
    useVirtualized &&
    shouldShowOlderSkeletons({
      trackedOldestEventId: olderSkeletonTrackedId,
      currentOldestEventId: oldestEventId,
      appearDelayElapsed: olderSkeletonReady,
    })

  // Filter out zero-height items (reactions, hidden session cards) for the virtualizer.
  // Without this, items that render as empty wrappers get measured as 0px, causing
  // subsequent items to overlap at the same Y position.
  //
  // Skeleton rows are prepended here — inside the array the shift computation
  // reads — so adding them changes the first item's key and useTimelineScroll
  // passes `shift` to virtua for that render, holding the viewport exactly
  // like a real older-page prepend (INV-21).
  const visibleItems = useMemo(
    () =>
      timeDerive(() => {
        const filtered = useVirtualized ? filterVisibleItems(timelineItems, isChannel) : timelineItems
        // Day dividers go on the post-filter list so a boundary lands above the
        // first *visible* row of a day (INV-42), then skeletons prepend above all.
        const base = injectDayDividers(filtered)
        return showOlderSkeletons ? [...OLDER_SKELETON_ITEMS, ...base] : base
      }),
    [timelineItems, useVirtualized, isChannel, showOlderSkeletons]
  )

  const visibleItemCount = visibleItems.length
  useEffect(() => {
    getPerfCapture().mark("timeline.windowItems", visibleItemCount)
  }, [visibleItemCount])

  // Collected from the PRE-filter `timelineItems`: the zero-height
  // `agent:follow_up_cancelled` events are dropped by `filterVisibleItems`, so
  // reading `visibleItems` would never see a cancellation and a scheduled card
  // could never flip on the virtualized path. Passed into TimelineMessageList's
  // render context so every viewer's card reflects the cancel (survives reload).
  const cancelledFollowUpIds = useMemo(
    () => timeDerive(() => collectCancelledFollowUpIds(timelineItems)),
    [timelineItems]
  )
  // Same full-window read for delegation status patches (they're zero-height,
  // filtered out of `visibleItems`): the card must see claim/progress/terminal
  // patches to render the authoritative live status on the virtualized path.
  const delegationStatusPatches = useMemo(
    () => timeDerive(() => collectDelegationStatusPatches(timelineItems)),
    [timelineItems]
  )
  // Same full-window read for bot-access request status patches (zero-height,
  // filtered out of `visibleItems`): the card must see the approve/deny
  // resolution to render the authoritative terminal state on the virtualized path.
  const botAccessStatusPatches = useMemo(
    () => timeDerive(() => collectBotAccessStatusPatches(timelineItems)),
    [timelineItems]
  )
  // Same full-window read for `call_ended` patches (zero-height, filtered out of
  // `visibleItems`): the call card must see the end summary to render its ended
  // face on the virtualized path (roadmap 1.4).
  const callEndedPatches = useMemo(() => timeDerive(() => collectCallEndedPatches(timelineItems)), [timelineItems])

  const dividerAnchorIds = useMemo(() => timeDerive(() => collectDividerAnchorIds(visibleItems)), [visibleItems])

  // Mirror of `visibleItems` for the long-lived scrollToMessage retry loop:
  // its closure is created once per scroll but runs for up to ~1.2s, during
  // which the event window can shift. Reading the ref keeps each retry tick
  // resolving the target index against the array Virtuoso currently holds.
  const visibleItemsRef = useRef(visibleItems)
  visibleItemsRef.current = visibleItems

  // Latch deep-link mode per stream. `?m=` is auto-cleared from the URL after
  // 3s (see effect above), which would otherwise flip skipInitialScroll
  // true->false mid-view and re-arm auto-follow, yanking the user off the
  // deep-linked message and snapping to the bottom. The latch only resets on
  // streamId change, so a fresh deep-link into the same stream still re-arms
  // (false is never written back within a stream once highlightMessageId was seen).
  const deepLinkLatchRef = useRef<{ streamId: string; latched: boolean }>({ streamId, latched: false })
  if (deepLinkLatchRef.current.streamId !== streamId) {
    deepLinkLatchRef.current = { streamId, latched: false }
  }
  if (highlightMessageId) {
    deepLinkLatchRef.current.latched = true
  }
  const skipInitialScroll = deepLinkLatchRef.current.latched

  // Genuine-user-gesture timestamp (wheel/touch/key/pointer on the scroller),
  // stamped by the effect below. The scroll hook reads it so a scroll away from
  // the bottom only stops auto-follow when the *user* did it — content growth
  // (new message, link preview, virtua measuring) must not disarm follow.
  const userInteractedAtRef = useRef(0)
  // Clear the stamp in RENDER on a stream switch, not in the stream-reset effect
  // below. StreamContent stays mounted across streams, and the open-at-marker
  // decision is a layout effect — which runs before passive effects in the same
  // commit — so a passive reset let it read the PREVIOUS stream's stamp and
  // consume the once-per-stream decision as "the user already scrolled". Any
  // pointerdown on the old timeline (clicking a message) then silently disabled
  // open-at-marker for the next stream opened.
  const gestureStampStreamRef = useRef(streamId)
  if (gestureStampStreamRef.current !== streamId) {
    gestureStampStreamRef.current = streamId
    userInteractedAtRef.current = 0
  }

  // True until the landing decision (INV-70) for this stream open is
  // consumed. The scroll hook defers a converged settle's mask reveal while
  // this is up — otherwise the settle (pure DOM-height convergence, ~a few
  // frames) races the decision's async inputs (read-state hydration) and
  // reveals the tail before a positional landing can take the mask over.
  const landingPendingRef = useRef(true)

  // Stamped on every programmatic scroll write (landing positioning, refine
  // loop, detached-hold re-pins, jump-to-latest, plus the scroll hook's own
  // pins). The read-frontier sweep in useLastSeenEvent refuses to link scans
  // across a stamp, so programmatic jumps stay read gaps while user flings
  // sweep — see SWEEP_LINK_MS.
  const programmaticScrollAtRef = useRef(0)

  const {
    listRef,
    scrollerRef: virtualScrollerRef,
    registerScroller: registerVirtualScroller,
    scrollerEl: virtualScrollerEl,
    contentRef: virtualContentRef,
    shift,
    isScrolledFarFromBottom: virtualIsScrolledFar,
    isInitialSettling: virtualIsInitialSettling,
    scrollToBottom: virtualScrollToBottom,
    disableAutoScroll: virtualDisableAutoScroll,
    isFollowingTailRef,
    handleScroll: handleVirtualScroll,
    resetShiftBaseline,
    holdSettleForRestore,
    revealSettle,
    releaseDeferredReveal,
  } = useTimelineScroll({
    itemCount: useVirtualized ? visibleItems.length : 0,
    getFirstKey: () => (useVirtualized && visibleItems.length > 0 ? getTimelineItemKey(visibleItems[0]) : null),
    resetKey: streamId,
    skipInitialScroll,
    isJumpMode,
    userInteractedAtRef,
    landingPendingRef,
    programmaticScrollAtRef,
  })

  // Scroll container element, owned by useTimelineScroll. Attached to the
  // scrollable div in the list below; read here for search highlight and
  // deep-link scroll.
  const virtuosoScrollerRef = virtualScrollerRef

  // --- Plain scroll for threads (they load all events) ---
  const {
    scrollContainerRef: plainScrollRef,
    handleScroll: plainHandleScroll,
    isScrolledFarFromBottom: plainIsScrolledFar,
    scrollToBottom: plainScrollToBottom,
    disableAutoScroll: plainDisableAutoScroll,
  } = useScrollBehavior({
    isLoading,
    itemCount: !useVirtualized ? displayEvents.length : 0,
    onScrollNearTop: !useVirtualized && hasOlderEvents ? fetchOlderEvents : undefined,
    onScrollNearBottom: !useVirtualized && hasNewerEvents ? fetchNewerEvents : undefined,
    isFetchingOlder,
    isFetchingNewer,
    resetKey: streamId,
    // Only treat the user as "at the bottom" when they are essentially flush.
    // A small scroll-up to reference older messages while typing should not be
    // snapped back when the composer grows.
    bottomThreshold: 4,
  })

  // Unified API regardless of scroll mode
  const scrollContainerRef = useVirtualized ? virtuosoScrollerRef : plainScrollRef
  // Content box for the plain (thread) scroller — its height tracks scrollHeight,
  // so observing it (not the fixed h-full scroller) catches embed/image growth.
  const plainContentRef = useRef<HTMLDivElement>(null)
  const isScrolledFarFromBottom = useVirtualized ? virtualIsScrolledFar : plainIsScrolledFar
  const scrollToBottom = useVirtualized ? virtualScrollToBottom : plainScrollToBottom
  const disableAutoScroll = useVirtualized ? virtualDisableAutoScroll : plainDisableAutoScroll

  // Correct the bottom anchor on the composer's *first* measurement, before
  // paint. The list first scrolled to LAST against the approximate persisted
  // footer height; when the real composer differs (cold boot with a restored
  // draft, density/zoom change) the footer spacer resizes, so we re-pin
  // synchronously in the same frame the list reveals — no visible jump.
  //
  // Runtime composer changes are also re-pinned here for plain scroll and for
  // draft scrollers: their spacing is applied via padding-bottom on the scroll
  // container itself, so the timeline's content ResizeObserver does not see it.
  // The virtualized timeline still relies on its footer-spacer ResizeObserver,
  // but calling scrollToBottom again is harmless because it self-guards on the
  // follow flag.
  //
  // Called through refs so the handler identity stays stable: the scroll-to-bottom
  // helpers are rebuilt as timeline state changes, and a changing prop would
  // re-render the memoized MessageInput on every new message (the exact churn
  // that memo exists to prevent).
  const virtualScrollToBottomRef = useRef(virtualScrollToBottom)
  virtualScrollToBottomRef.current = virtualScrollToBottom
  const plainScrollToBottomRef = useRef(plainScrollToBottom)
  plainScrollToBottomRef.current = plainScrollToBottom
  const draftScrollRef = useRef<HTMLDivElement | null>(null)
  // Scopes text-selection quoting to the stream's own message list. Without it,
  // this unscoped instance would also match the shared `MessageItem` rows a
  // conversation side panel (PanelHost) renders beside the timeline — those now
  // carry `data-message-id`/`.message-content`, so an unscoped detector would
  // fire a second "Quote" button and route the quote to the wrong composer.
  const quoteScopeRef = useRef<HTMLDivElement>(null)
  // Space-aware chrome: hide the floating pills (date header, jump-to-latest,
  // unread banner) while the strip above the composer is too short for them to
  // overlay without covering what little content remains — the mobile keyboard
  // plus a tall draft leaves ~2 rows visible. Recomputed on scroller resizes
  // (keyboard open/close) and on composer height changes (via
  // handleComposerHeightChange below, since the floating composer doesn't
  // resize the scroller).
  const [chromeCollapsed, setChromeCollapsed] = useState(false)
  const recomputeChromeCollapsedRef = useRef<() => void>(() => {})
  useEffect(() => {
    const el = useVirtualized ? virtualScrollerEl : plainScrollRef.current
    if (!el) return
    const recompute = () => {
      const raw = Number.parseFloat(getComputedStyle(el).getPropertyValue("--composer-height"))
      setChromeCollapsed(isChromeStripCollapsed(el.clientHeight, Number.isFinite(raw) ? raw : 0))
    }
    recomputeChromeCollapsedRef.current = recompute
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => {
      recomputeChromeCollapsedRef.current = () => {}
      ro.disconnect()
    }
    // isLoading: the plain (thread) scroller mounts behind the loading
    // skeleton, and only a state dep re-runs this effect once it exists.
  }, [useVirtualized, virtualScrollerEl, plainScrollRef, isLoading, streamId])

  const typingChromeHidden = isTypingChromeHidden(chromeCollapsed, mobileComposerTyping)

  const handleComposerHeightChange = useCallback(
    (_px: number, opts: { initial: boolean }) => {
      // Composer growth doesn't resize the scroller (the composer floats), so
      // the space-aware chrome re-checks here rather than via ResizeObserver.
      recomputeChromeCollapsedRef.current()
      if (skipInitialScroll || isJumpMode) return
      const rePin = () => {
        const draftScroller = draftScrollRef.current
        if (draftScroller) {
          // Drafts: only snap if the user is already parked at the bottom.
          if (opts.initial || draftScroller.scrollTop + draftScroller.clientHeight >= draftScroller.scrollHeight - 10) {
            draftScroller.scrollTop = draftScroller.scrollHeight
          }
          return
        }
        // Main timeline: force on initial correction (cold-load anchor fix),
        // but respect the follow flag for runtime composer growth so a user
        // scrolled up to read history isn't yanked back to the tail. The
        // initial force also yields to a positioned reader: a scrollToMessage
        // refine loop in flight (anchor restore, unread-marker open, deep
        // link) or an already-landed detached position owns the viewport — a
        // late-mounting composer must not stomp it back to the tail.
        if (opts.initial && (scrollAbortRef.current || (!isFollowingTailRef.current && detachedHoldRef.current))) {
          return
        }
        if (useVirtualized) {
          virtualScrollToBottomRef.current({ force: opts.initial })
        } else {
          plainScrollToBottomRef.current({ force: opts.initial })
        }
      }
      if (opts.initial) {
        rePin()
      } else {
        requestAnimationFrame(rePin)
      }
    },
    [isJumpMode, skipInitialScroll, useVirtualized]
  )

  // Scroll to a specific timeline row — addressed by message id or event id
  // (any row `findTimelineTargetIndex` resolves, including session/command
  // group cards) — and keep re-scrolling until the target element is actually
  // visible in the scroller viewport. Items rendered with estimated heights —
  // and link previews / long-message toggles that resolve later — drift the
  // target after the first scroll; this loop keeps correcting for a bounded
  // window rather than stopping at the first frame that looks right.
  // User input (wheel / touch / key) aborts the loop immediately so manual
  // scrolling always wins. `align: "center"` (default) centers the target
  // (deep links); `align: "start"` pins its top near the viewport top (the
  // unread marker open).
  //
  // This is the *only* thing that scrolls a highlighted row into view, on both
  // scroll modes: the plain thread scroller renders every row, so it just takes
  // the DOM branch and never reaches virtua. A second, ungated
  // `scrollIntoView({behavior:"smooth"})` on the row itself used to race this
  // loop — it re-fired every time virtua remounted the row, dragging a reader
  // who had scrolled away back to the match.
  //
  // Implementation notes: Virtuoso's scrollToIndex expects the 0-based
  // index within the current data array (NOT firstItemIndex + idx). Once
  // the item is rendered in the DOM we use native scrollTo on the scroller
  // to position it precisely — this sidesteps Virtuoso's internal offset
  // estimation which tends to overshoot with unmeasured items.
  const scrollRetryTimerRef = useRef<number | null>(null)
  const scrollAbortRef = useRef<(() => void) | null>(null)
  // Rolling detached-viewport snapshot: the topmost visible row and its offset
  // from the viewport top, valid while the reader is parked off the tail.
  // Refreshed by the debounced scroll snapshot (the anchor-persist effect), by
  // the older-fetch arm, and by every programmatic scroll's first settle — so
  // it always describes the position the reader currently owns. The detached
  // viewport guard below re-pins this row when content resizes out from under
  // a parked reader (virtua size-estimate corrections, prepends, late media) —
  // every one of those otherwise slides the viewport through the content.
  const detachedHoldRef = useRef<{ id: string; offsetPx: number; takenAt: number } | null>(null)
  // Sticky "user grabbed the scroller" stamp for the *current* scroll intent.
  // Reset to 0 whenever a new intent is established (deep-link nav, search
  // jump, stream switch) and set by long-lived input listeners on the
  // scroller (attached by useTimelineScroll's gesture-stamp effect). The
  // refine loop reads this so
  // a manual scroll always wins — including a gesture that began in the rAF
  // gap before scrollToMessage attached its own abort listeners. That gap is
  // exactly the "I scroll up to read context, then get yanked back to the
  // linked message" deep-link bug.
  const scrollToMessage = useCallback(
    (
      targetId: string,
      opts?: {
        align?: "center" | "start"
        topOffsetPx?: number
        /** Fires exactly once, the first time the target has held its aligned
         *  position for a few ticks — or the loop ends without ever landing
         *  (user abort, timeout, superseded). The anchor restore holds the
         *  cold-load skeleton up until this, so the first revealed frame is
         *  already at the restored position instead of a tail flash. */
        onFirstSettle?: () => void
      }
    ) => {
      const align = opts?.align ?? "center"
      const engagedAt = performance.now()
      let settleNotified = false
      let stableTicks = 0
      let everLanded = false
      const notifySettled = () => {
        if (settleNotified) return
        settleNotified = true
        // A genuine landing (or a user takeover) is the reader's new owned
        // position: refresh the detached-viewport snapshot so the guard
        // protects the landed spot instead of a stale pre-jump one. A timeout
        // that never landed must NOT overwrite it — the caller-seeded target
        // stays, and the guard keeps pulling toward it on later reflows.
        const scrollerNow = scrollContainerRef.current
        const userTookOver = userInteractedAtRef.current > engagedAt
        if (scrollerNow && !isFollowingTailRef.current && (everLanded || userTookOver)) {
          const snap = snapshotTopVisibleRow(scrollerNow)
          detachedHoldRef.current = snap ? { ...snap, takenAt: performance.now() } : null
        }
        opts?.onFirstSettle?.()
      }
      // For "start": px between the viewport top and the target's top. The
      // unread-marker default leaves a small context gap; an anchor restore
      // passes the exact (possibly negative) offset the reader detached at.
      const topOffsetPx = opts?.topOffsetPx ?? UNREAD_MARKER_TOP_GAP_PX
      if (findTimelineTargetIndex(visibleItems, targetId) < 0) {
        deepLinkDebug("scrollToMessage bail: target not a timeline item yet", targetId)
        return false
      }
      // The user already took manual control for this scroll intent (e.g.
      // started scrolling while jumpToEvent was loading the window). Don't
      // start a retry loop that would fight them back to the target — the
      // mount anchor already placed it close enough.
      if (userInteractedAtRef.current > 0) {
        deepLinkDebug("scrollToMessage bail: user already interacting", targetId)
        return false
      }

      // Cancel any previous retry loop
      if (scrollRetryTimerRef.current !== null) {
        window.clearTimeout(scrollRetryTimerRef.current)
        scrollRetryTimerRef.current = null
      }
      scrollAbortRef.current?.()
      scrollAbortRef.current = null

      // Disable auto-scroll so followOutput doesn't snap back to bottom
      // while we're trying to scroll the target into view.
      disableAutoScroll()

      const scroller = scrollContainerRef.current
      if (!scroller) {
        deepLinkDebug("scrollToMessage bail: scroller not attached yet", targetId)
        return false
      }

      // Abort the retry loop the moment the user takes over
      let aborted = false
      const abort = () => {
        aborted = true
        notifySettled()
        if (scrollRetryTimerRef.current !== null) {
          window.clearTimeout(scrollRetryTimerRef.current)
          scrollRetryTimerRef.current = null
        }
        scroller.removeEventListener("wheel", abort)
        scroller.removeEventListener("touchmove", abort)
        scroller.removeEventListener("keydown", abort)
        scrollAbortRef.current = null
      }
      scrollAbortRef.current = abort
      scroller.addEventListener("wheel", abort, { passive: true })
      scroller.addEventListener("touchmove", abort, { passive: true })
      scroller.addEventListener("keydown", abort)

      const started = performance.now()
      // The loop watches for the whole window rather than stopping the moment
      // the target first looks settled: a link preview card resolving above the
      // target lands ~800ms after the window renders and shoves the target down
      // under a reader already looking at it. Any real input aborts within one
      // tick (the listeners above plus the shared gesture stamp, which also
      // covers a scrollbar drag), so watching costs the user nothing.
      const MAX_MS = 1200

      const attempt = () => {
        if (aborted) return
        // A manual scroll landed after this loop began (caught by the
        // long-lived scroller listeners even for a gesture that started
        // before this loop's own abort listeners attached). Hand control
        // back instead of re-centering on the target.
        if (userInteractedAtRef.current > 0) {
          abort()
          return
        }

        // Message rows carry both attributes; non-message rows (session cards,
        // command groups, retitles) only data-event-id — one query serves any
        // row the unread divider can anchor on.
        const escaped = CSS.escape(targetId)
        const el = scroller.querySelector<HTMLElement>(`[data-message-id="${escaped}"], [data-event-id="${escaped}"]`)

        if (el) {
          // Target is rendered — scroll via DOM so we get pixel-precise positioning
          const sr = scroller.getBoundingClientRect()
          const er = el.getBoundingClientRect()
          const scCenter = (sr.top + sr.bottom) / 2
          // "start" pins the target's top at topOffsetPx below the viewport
          // top (the unread marker open, an anchor restore). "center" is the
          // deep-link behavior, unchanged.
          const desiredTop = sr.top + topOffsetPx
          const delta = align === "start" ? er.top - desiredTop : (er.top + er.bottom) / 2 - scCenter
          if (Math.abs(delta) > 2) {
            programmaticScrollAtRef.current = performance.now()
            scroller.scrollTop += delta
            stableTicks = 0
          } else {
            everLanded = true
            if (++stableTicks >= SCROLL_SETTLE_STABLE_TICKS) {
              // Landed and holding — the loop keeps watching for late reflows
              // (link previews), but the position is presentable now.
              notifySettled()
            }
          }
        } else {
          stableTicks = 0
          // Target is virtualized out — ask Virtuoso to render it (0-based
          // index). Re-resolve against the live timeline every tick: the
          // window can shift under this loop, and a stale/out-of-range index
          // makes react-virtuoso's offset-tree binary search dereference an
          // undefined node, throwing "Cannot read properties of undefined
          // (reading 'index')" which crashes the whole route.
          const liveIdx = findTimelineTargetIndex(visibleItemsRef.current, targetId)
          // liveIdx < 0 means the target is transiently out of the window
          // (e.g. a jump-window swap mid-flight). Skip this tick rather than
          // scroll to a wrong index; a later tick retries once it reappears,
          // and MAX_MS still bounds the loop if it never does.
          if (liveIdx >= 0) {
            try {
              programmaticScrollAtRef.current = performance.now()
              listRef.current?.scrollToIndex(
                liveIdx,
                align === "start" ? { align: "start", offset: -topOffsetPx } : { align: "center" }
              )
            } catch {
              // virtua can still throw internally on a freshly mounted,
              // not-yet-measured list. Non-fatal: the next tick retries once
              // sizes are populated, or the DOM path takes over once the row
              // renders.
            }
          }
        }

        const elapsed = performance.now() - started
        if (elapsed < MAX_MS) {
          scrollRetryTimerRef.current = window.setTimeout(attempt, 60)
        } else {
          abort()
        }
      }
      deepLinkDebug("scrollToMessage: refine loop engaged", targetId)
      attempt()
      return true
    },
    [visibleItems, listRef, disableAutoScroll, scrollContainerRef]
  )

  useEffect(() => {
    return () => {
      scrollAbortRef.current?.()
    }
  }, [])

  // Set when a jump (deep-link `?m=`, out-of-window search, or date picker) has
  // loaded a new event window and the target still needs to be scrolled into
  // view. Stays set until scrollToMessage engages its own resilient refine loop
  // — see the convergent driver below for why a one-shot attempt isn't enough.
  const pendingScrollTarget = useRef<string | null>(null)
  const pendingScrollRafRef = useRef(0)
  // Date jumps learn the anchor after the window fetch has already scheduled
  // state updates, so a ref write alone can miss the effect's dependency tick.
  const [pendingScrollRequestVersion, setPendingScrollRequestVersion] = useState(0)

  // When a search result is selected, navigate to that message.
  // If the message is already in the loaded events, just scroll to it in the DOM —
  // don't call jumpToEvent which loads a new event window and disrupts scroll position.
  // Only use jumpToEvent for messages outside the current window (older history).
  const handleSearchNavigate = useCallback(
    (messageId: string) => {
      // Fresh, explicit scroll intent — clear any prior manual-control stamp
      // so the refine loop is allowed to run for this jump.
      userInteractedAtRef.current = 0
      const isInCurrentEvents = events.some((e) => matchesDeepLinkTarget(e, messageId))

      if (isInCurrentEvents) {
        // A previous out-of-window navigation may still be pending; this newer
        // navigation supersedes it — otherwise its window swap or landing
        // arrives later, under a user who is already at this match.
        if (searchNavPhaseRef.current === "fetching") cancelPendingJump(searchNavGenRef.current)
        if (pendingScrollTarget.current && pendingScrollTarget.current === searchNavTargetRef.current) {
          pendingScrollTarget.current = null
        }
        searchNavPhaseRef.current = "idle"
        searchNavVersionRef.current++
        setIsSearchNavigating(false)
        // Message is loaded — scroll to it (handles both in-DOM and virtualized-out items)
        scrollToMessage(messageId)
        return
      }

      // Message not in current window — load events around it, then scroll after load
      disableAutoScroll()
      pendingScrollTarget.current = messageId
      searchNavTargetRef.current = messageId
      searchNavPhaseRef.current = "fetching"
      const version = ++searchNavVersionRef.current
      setIsSearchNavigating(true)
      // On success the spinner stays up until the post-jump driver engages the
      // scroll (or gives up) — the fetch is the smaller half of the wait; the
      // window swap + scroll placement is the rest of it.
      const navPromise = jumpToEvent(messageId)
      // jumpToEvent claims its generation synchronously — capture it as the
      // ownership token for phase-gated cancels.
      searchNavGenRef.current = currentJumpGeneration()
      navPromise
        .then((result) => {
          if (searchNavVersionRef.current !== version) return
          if (result === "superseded") {
            // A date jump or deep link took over mid-flight; it owns the
            // window and the spinner semantics now.
            searchNavPhaseRef.current = "idle"
            setIsSearchNavigating(false)
            return
          }
          if (!result) {
            searchNavPhaseRef.current = "idle"
            setIsSearchNavigating(false)
            if (pendingScrollTarget.current === messageId) pendingScrollTarget.current = null
            toast.error("Couldn't load that search result")
            return
          }
          searchNavPhaseRef.current = "swapped"
        })
        .catch(() => {
          if (searchNavVersionRef.current !== version) return
          searchNavPhaseRef.current = "idle"
          setIsSearchNavigating(false)
          if (pendingScrollTarget.current === messageId) pendingScrollTarget.current = null
          toast.error("Couldn't load that search result")
        })
    },
    [events, jumpToEvent, cancelPendingJump, currentJumpGeneration, disableAutoScroll, scrollToMessage]
  )

  // Jump to a calendar date from the floating date header. Scrolls to the first
  // message on or after the local day: in-window targets scroll directly (no
  // round-trip, no jump mode); older targets load a window then scroll to the
  // server-resolved anchor via the existing pendingScrollTarget driver.
  const handleJumpToDate = useCallback(
    async (date: Date) => {
      userInteractedAtRef.current = 0
      const targetDayMs = localStartOfDayMs(date)
      disableAutoScroll()
      const inWindowMessageId = resolveDateJumpAnchor({ events, targetDayMs, hasOlderEvents })
      if (inWindowMessageId) {
        // Explicit navigation: abandon whatever jump is in flight — a
        // late-resolving one would swap the window under this scroll.
        cancelPendingJump()
        pendingScrollTarget.current = null
        searchNavPhaseRef.current = "idle"
        searchNavVersionRef.current++
        setIsSearchNavigating(false)
        scrollToMessage(inWindowMessageId)
        return
      }
      resetShiftBaseline()
      const anchorId = await jumpToEventByDate(new Date(targetDayMs).toISOString())
      // A newer jump (another date pick, a search navigation) superseded this
      // one mid-flight — it owns the window and pendingScrollTarget now.
      if (anchorId === "superseded") return
      if (anchorId) {
        pendingScrollTarget.current = anchorId
        setPendingScrollRequestVersion((version) => version + 1)
      } else {
        pendingScrollTarget.current = null
        toast.info("No messages on or after that date")
      }
    },
    [
      events,
      hasOlderEvents,
      cancelPendingJump,
      disableAutoScroll,
      scrollToMessage,
      jumpToEventByDate,
      resetShiftBaseline,
    ]
  )

  // Highlight search matches in the DOM via CSS Custom Highlight API
  useSearchHighlight(
    scrollContainerRef,
    isSearchOpen ? streamSearch.query : "",
    streamSearch.activeMessageId,
    streamSearch.activeOccurrence
  )
  // Convergent post-jump scroll driver.
  //
  // A post-jump scroll is not a single observable React transition: the window
  // swap updates `events`; deep links may then wait for `holdForDeepLink`; then
  // <Virtuoso> (re)mounts and only *then* attaches its scroller — and the
  // target row may be virtualized out or transiently
  // grouped for the first few frames. The previous one-shot
  // `requestAnimationFrame(scrollToMessage)` + unconditional
  // `pendingScrollTarget = null` frequently fired into a not-yet-mounted
  // scroller, scrollToMessage early-bailed with no retry, and the deep-link
  // silently never landed ("some messages just never scroll into view").
  //
  // Instead, re-attempt every frame until scrollToMessage engages its own
  // resilient refine loop (returns true — it then owns landing + abort), the
  // user takes over, or a hard deadline elapses. The effect re-runs on
  // `events`/`scrollToMessage` changes (covering the React-visible window
  // swap) and the intra-run rAF reschedule covers the scroller-attach gap
  // that produces no React state change.
  useEffect(() => {
    if (!pendingScrollTarget.current || isLoading) return
    const target = pendingScrollTarget.current

    const started = performance.now()
    // Generous bound: a cold push-notification deep-link can spend ~1s in
    // jumpToEvent + the skeleton hold before Virtuoso even mounts. Must
    // outlast that, but still terminate if the target never resolves.
    const DEADLINE_MS = 4000

    const tick = () => {
      pendingScrollRafRef.current = 0
      const phase = classifyDeepLinkScrollTick({
        pendingTarget: pendingScrollTarget.current,
        target,
        userInteractedAt: userInteractedAtRef.current,
        elapsedMs: performance.now() - started,
        deadlineMs: DEADLINE_MS,
      })

      if (phase === "superseded") return
      if (phase === "user-abort") {
        deepLinkDebug("post-jump: user interacted, abandoning", target)
        pendingScrollTarget.current = null
        searchNavPhaseRef.current = "idle"
        setIsSearchNavigating(false)
        return
      }
      if (phase === "deadline") {
        deepLinkDebug("post-jump: deadline exceeded, giving up", target)
        pendingScrollTarget.current = null
        searchNavPhaseRef.current = "idle"
        setIsSearchNavigating(false)
        // The jump window loaded but the target never became placeable (e.g. a
        // mid-flight window swap). Mark the deep-link as conclusively failed so
        // the holdForDeepLink skeleton releases and the gated ?m= clear can
        // fire — without this the skeleton/param would hang now that the clear
        // no longer runs on a blind mount timer.
        setDeepLinkGaveUp(true)
        return
      }

      const inEvents = events.some((e) => matchesDeepLinkTarget(e, target))
      if (inEvents && scrollToMessage(target)) {
        // scrollToMessage engaged its own resilient loop — it owns landing
        // + user-abort from here, so this driver is done.
        deepLinkDebug("post-jump: scrollToMessage engaged", target)
        pendingScrollTarget.current = null
        searchNavPhaseRef.current = "idle"
        setIsSearchNavigating(false)
        return
      }

      // Not placeable yet (scroller not attached, target virtualized out /
      // transiently grouped, or window mid-swap). Retry next frame.
      pendingScrollRafRef.current = requestAnimationFrame(tick)
    }

    pendingScrollRafRef.current = requestAnimationFrame(tick)
    return () => {
      if (pendingScrollRafRef.current) {
        cancelAnimationFrame(pendingScrollRafRef.current)
        pendingScrollRafRef.current = 0
      }
    }
  }, [events, isLoading, scrollToMessage, setDeepLinkGaveUp, pendingScrollRequestVersion])

  // Reset jump and search state when switching streams (component stays mounted).
  // Also abort any in-flight scrollToMessage retry loop so its stale closure
  // (holding an index from the previous stream) doesn't scroll the new stream
  // to the wrong position.
  //
  // Declared BEFORE the highlight deep-link effect below: effects run in
  // declaration order, and a navigation that changes stream and ?m= together
  // must reset first, then start the new stream's deep-link jump — the other
  // order cancels the jump this same commit just started.
  useEffect(() => {
    jumpTriggeredKeyRef.current = null
    scrollAbortRef.current?.()
    if (pendingScrollRafRef.current) {
      cancelAnimationFrame(pendingScrollRafRef.current)
      pendingScrollRafRef.current = 0
    }
    pendingScrollTarget.current = null
    setDeepLinkGaveUp(false)
    setDeepLinkHoldExpired(false)
    exitJumpMode()
    // An in-flight jump for the previous stream must not apply its window to
    // this one — jumpState carries no streamId, so a late resolution would
    // render the old stream's events here.
    cancelPendingJump()
    setIsSearchOpen(false)
    searchNavPhaseRef.current = "idle"
    searchNavVersionRef.current++
    setIsSearchNavigating(false)
    clearSearch()
  }, [streamId, exitJumpMode, cancelPendingJump, clearSearch])

  // Jump to highlighted message if it's not in the current event window.
  // The guard uses location.key so repeat clicks on the same message link
  // (which produce identical URLs and would otherwise not change any state)
  // still re-trigger — react-router stamps each navigation with a fresh key.
  useEffect(() => {
    // Gate on a hydrated window (see canActOnDeepLinkNavigation) BEFORE the
    // once-per-key claim below, so a cold open with `events` still empty doesn't
    // claim the navigation and then block its own retry once events arrive.
    const nav = { highlightMessageId, isLoading, isDraft, hasEvents: events.length > 0 }
    if (!canActOnDeepLinkNavigation(nav)) return
    if (jumpTriggeredKeyRef.current === location.key) return
    const targetMessageId = nav.highlightMessageId
    const navigationKey = location.key
    jumpTriggeredKeyRef.current = navigationKey
    // Fresh navigation: re-arm the mount hold for this target and clear any
    // prior manual-control stamp so the refine loop is allowed to run.
    setDeepLinkGaveUp(false)
    setDeepLinkHoldExpired(false)
    userInteractedAtRef.current = 0

    // Disable auto-scroll so highlight scroll-into-view isn't overridden
    disableAutoScroll()

    // Check if the target is already visible in current events.
    const isVisible = events.some((e) => matchesDeepLinkTarget(e, targetMessageId))

    if (isVisible) {
      deepLinkDebug("highlight: target already in window, scrolling directly", targetMessageId)
      scrollToMessage(targetMessageId)
      return
    }

    // Target is outside the loaded window — fetch a window around it, then scroll.
    deepLinkDebug("highlight: target out of window, jumping", targetMessageId)
    pendingScrollTarget.current = targetMessageId
    jumpToEvent(targetMessageId)
      .then((success) => {
        // A newer navigation may have superseded this request while it was
        // in flight; its stale completion must not clear the new target or
        // release the new mount hold.
        if (jumpTriggeredKeyRef.current !== navigationKey) return
        deepLinkDebug("highlight: jumpToEvent resolved", targetMessageId, "success=", success)
        if (success === "superseded") {
          // Another navigation (search, date, jump-to-latest) took over while
          // this deep link loaded. Release the ?m= hold so the param and
          // highlight don't hang; the superseding action owns the window now.
          if (pendingScrollTarget.current === targetMessageId) pendingScrollTarget.current = null
          setDeepLinkGaveUp(true)
          return
        }
        if (!success) {
          pendingScrollTarget.current = null
          setDeepLinkGaveUp(true)
        }
      })
      .catch(() => {
        if (jumpTriggeredKeyRef.current !== navigationKey) return
        deepLinkDebug("highlight: jumpToEvent rejected", targetMessageId)
        pendingScrollTarget.current = null
        setDeepLinkGaveUp(true)
      })
  }, [highlightMessageId, location.key, isLoading, isDraft, events, jumpToEvent, disableAutoScroll, scrollToMessage])

  // Auto-mark stream as read when viewing. The stream opens at the live bottom;
  // read state advances only through the contiguous run the viewer scrolls
  // through from where they left off (see useLastSeenEvent), so the unread above
  // the fold stays unread until they go up to it (or press Escape). A not-at-tail
  // mark is partial — the badge keeps the remaining unread (markAsRead partial).
  //
  // Hold off arming the read-frontier scan until the cold-load settle has parked
  // the virtualized list at the live bottom. The scan reads row geometry; while
  // the settle is still pinning to the tail across frames, the last row sits
  // below the composer band and is excluded from the visible range, and once the
  // settle converges there's no guaranteed scroll/resize to re-scan — so arming
  // mid-settle can leave the trailing unread row stuck out of the frontier and it
  // never auto-reads (opened-fresh-at-bottom, intermittent). Gating on
  // settle-complete makes the attach scan run once the tail is actually on
  // screen. Only the virtualized timeline settles; the plain thread scroller has
  // no settle phase (`isInitialSettling` would never clear there), so exempt it.
  const settledAtBottom = !useVirtualized || !virtualIsInitialSettling
  const autoMarkEnabled = !isDraft && !isLoading && !isJumpMode && settledAtBottom
  const { lastSeenEventId, atLastRow, tailVisible, unreadAboveViewport } = useLastSeenEvent({
    scrollContainerRef,
    // The virtualized scroller late-mounts via a ref callback, AFTER
    // `autoMarkEnabled` flips true — pass the mounted element so the read-frontier
    // scan re-arms its observers once the scroller exists. The plain thread
    // scroller mounts synchronously with the content, so it has no element to
    // track (the ref is already live when enabled flips).
    scrollContainerEl: useVirtualized ? virtualScrollerEl : null,
    // Observe the scrolling content box (its height tracks scrollHeight) so a
    // settle / embed / image resize re-scans even when the stream is too short
    // to scroll. Both paths pass one — the virtualized list's inner content div
    // and the plain (thread) scroller's content wrapper. Observing the scroller
    // itself wouldn't catch it: a fixed h-full box doesn't change as content grows.
    contentRef: useVirtualized ? virtualContentRef : plainContentRef,
    events: displayEvents,
    streamId,
    lastReadEventId: frontierLastReadEventId,
    lastReadSequence: frontierLastReadSequence,
    enabled: autoMarkEnabled,
    programmaticScrollAtRef,
  })
  useAutoMarkAsRead(workspaceId, streamId, lastSeenEventId, {
    enabled: autoMarkEnabled,
    partial: !atLastRow,
    // Raw watermark, not the thread-remapped frontier seed: the heal's anchor
    // must be the id the server already stores so the advance stays a no-op.
    readPointerEventId: lastReadEventId,
    activityHealEnabled: tailVisible,
  })
  const canAutoRead = useAutoReadAttention()

  const isMobile = useIsMobile()
  const readCommitQueue = useReadCommitQueue()
  const { markAsRead, markUnread, getUnreadCount } = useUnreadCounts(workspaceId)
  const unreadCount = getUnreadCount(streamId)

  // The stream's sparse read overlay — message ids read individually above the
  // watermark (from a conversation-surface read). Threads through the read
  // frontier so the divider, the "new" flash, and per-row gating all treat an
  // overlay-read row as effectively read (docs/sparse-read-overlay-design.md).
  const readOverlay = useReadMessageIds(workspaceId, streamId)

  // Track live-arriving messages from other users for brief "new" indicator.
  const newMessageIds = useNewMessageIndicator(
    events,
    currentWorkspaceUserId ?? undefined,
    streamId,
    lastReadEventId,
    readOverlay,
    // Away arrivals get the divider (blur re-latch below), not the flash.
    canAutoRead
  )

  // Unread divider state — a bookmark line at the first unread message. The
  // stream opens at the bottom (no auto-scroll to unread); the viewer reaches
  // the divider via the "N new" jump button or by scrolling up.
  const { dividerEventId, dismiss: dismissUnreadDivider } = useUnreadDivider({
    events: displayEvents,
    lastReadSequence: frontierSequence ?? null,
    currentUserId: currentWorkspaceUserId ?? undefined,
    streamId,
    isLoading,
    highlightMessageId,
    // The hook never drives the scroll itself. The "marker" open-position
    // preference is a landing variant of resolveStreamLanding (INV-70), whose
    // executor scrolls via the virtua-aware paths instead of the hook's
    // querySelector path (off-screen rows aren't in the DOM when virtualized).
    scrollToUnread: false,
    // `frontierSequence` is `bigint | null` once resolved; it is `undefined`
    // while the read sources are still hydrating OR when the watermark carries
    // no sequence. Gate on that so an unknown read position can't be read as
    // "all unread" and latch a divider on the first message (which would then
    // stick for the session).
    readStateResolved: frontierSequence !== undefined,
    // Skip overlay-read events so the divider anchors on the first *effectively*
    // unread row, not one already read from a conversation surface.
    overlayReadIds: readOverlay,
    // Keep the anchor on a row the list is actually rendering — see
    // collectDividerAnchorIds.
    anchorableEventIds: dividerAnchorIds,
    // Same signal that gates auto-read: while the viewer is away the divider may
    // re-latch forward at the first away-arrival (messages that came in while
    // blurred get the persistent red→grey strip, as if the stream were re-opened).
    isAttentive: canAutoRead,
  })

  // The divider is red while unread still sits at/after it, and turns muted-gray
  // once the read pointer has passed it (read through, or "Mark as read") — a
  // pure read-state signal, not a time-based fade.
  const isDividerDimmed = useMemo(
    () => isDividerReadPast(events, dividerEventId, frontierSequence ?? null),
    [events, dividerEventId, frontierSequence]
  )

  // Read the last loaded event from a ref so the Escape listener below doesn't
  // re-attach on every live message (the events array is a fresh reference each
  // append).
  const lastLoadedEventIdRef = useRef<string | undefined>(undefined)
  lastLoadedEventIdRef.current = events.length > 0 ? events[events.length - 1].id : undefined

  // `markAsRead` is a fresh callback each render (its mutation dep churns), so
  // read it from a ref to keep the document listener below attached once per
  // stream rather than re-subscribing on every live message.
  const markAsReadRef = useRef(markAsRead)
  markAsReadRef.current = markAsRead
  const markUnreadRef = useRef(markUnread)
  markUnreadRef.current = markUnread
  useEffect(() => {
    readCommitQueue.observeReadPointer(streamId, lastReadEventId)
  }, [lastReadEventId, readCommitQueue, streamId])

  // "Escape the unread block": mark the stream fully read, dismiss the
  // persistent unread divider, and resume tailing the live bottom. Shared by
  // the desktop Escape shortcut and the touchable ✕ on the divider / jump bar
  // (the ✕ is the only path on mobile, where the keyboard shortcut is absent).
  const escapeUnread = useCallback(() => {
    const lastLoadedEventId = lastLoadedEventIdRef.current
    if (lastLoadedEventId) markAsReadRef.current(streamId, lastLoadedEventId)
    dismissUnreadDivider()
    // An explicit go-to-bottom supersedes a landing refine loop still in its
    // watch window — the loop only aborts on scroller gestures, and without
    // this its next tick re-centers the marker target, reverting the jump.
    scrollAbortRef.current?.()
    scrollToBottom({ force: true })
  }, [streamId, dismissUnreadDivider, scrollToBottom])

  // Desktop Slack-style Esc-marks-channel-read. Scoped to when the divider is
  // actually shown so it never swallows Escape elsewhere; the composer/editor
  // keep their own Escape via the isInput guard, and search owns Escape while open.
  useEffect(() => {
    if (isMobile || isDraft || !dividerEventId || isSearchOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const target = event.target as HTMLElement | null
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable
      if (isInput) return
      // An open Radix overlay that owns Escape (move dialog, dropdown, the
      // reaction popover) listens in the capture phase and does not stop
      // propagation, so without this our bubble-phase handler would ALSO mark
      // the stream read and jump to the tail on the same keypress. Dialogs and
      // menus match by role; other popovers match the popper wrapper (only in
      // the DOM while open — no forceMount). Hover-only tooltips render in a
      // popper wrapper too but never own Escape, so a tooltip showing on a
      // hovered message must not block the shortcut — skip wrappers whose
      // content is a tooltip.
      const overlayOwnsEscape =
        document.querySelector(
          '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"]'
        ) != null ||
        Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")).some(
          (wrapper) => wrapper.querySelector('[role="tooltip"]') == null
        )
      if (overlayOwnsEscape) return
      escapeUnread()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isMobile, isDraft, dividerEventId, isSearchOpen, escapeUnread])

  // Manual "Mark as read" from a message action. The pointer is partial
  // unless the chosen row is the last loaded one — marking up to a mid-window
  // event must not optimistically zero the badge (the count resolves to the
  // true remainder on the `stream:read` round-trip; see markAsRead partial).
  useEffect(() => {
    return addMarkReadUpToHereListener((detail) => {
      if (detail.streamId !== streamId) return
      markAsReadRef.current(streamId, detail.eventId, {
        partial: detail.eventId !== lastLoadedEventIdRef.current,
      })
    })
  }, [streamId])

  // Manual "Mark as unread" — move the read pointer back so the chosen message
  // and everything after it are unread. The count rises on the stream:read_set
  // round-trip (markUnread reseeds only the pointer optimistically).
  useEffect(() => {
    return addMarkUnreadListener((detail) => {
      if (detail.streamId !== streamId) return
      void readCommitQueue
        .runExplicitUnread(streamId, lastReadEventId, () => markUnreadRef.current(streamId, detail.messageId))
        .catch(() => undefined)
    })
  }, [lastReadEventId, readCommitQueue, streamId])

  const queryClient = useQueryClient()
  const isPublicChannel = stream?.type === StreamTypes.CHANNEL && stream?.visibility === Visibilities.PUBLIC
  const isMember = !!membership
  const membershipResolved = currentWorkspaceUserId !== null || bootstrap !== undefined
  let disabledReason: string | undefined
  if (isSystem) {
    disabledReason = "System notifications are read-only."
  } else if (stream?.archivedAt) {
    disabledReason = "This thread has been sealed in the labyrinth. It can be read but not extended."
  } else if (rootArchived) {
    disabledReason = "The stream this thread belongs to has been archived. It can be read but not extended."
  }

  const handleJoined = useCallback(
    (membership: StreamMember) => {
      queryClient.setQueryData(streamKeys.bootstrap(workspaceId, streamId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        return { ...(old as StreamBootstrap), membership }
      })
      queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), (old: unknown) => {
        if (!old || typeof old !== "object") return old
        const ws = old as WorkspaceBootstrap
        return {
          ...ws,
          streamMemberships: [...ws.streamMemberships, membership],
        }
      })
    },
    [queryClient, workspaceId, streamId]
  )

  const handleJumpToLatest = useCallback(() => {
    // Explicit "go to latest": abandon any pending navigation — a
    // late-resolving jump would otherwise re-enter jump mode and scroll back
    // to the abandoned target, overriding this click.
    cancelPendingJump()
    pendingScrollTarget.current = null
    searchNavPhaseRef.current = "idle"
    searchNavVersionRef.current++
    setIsSearchNavigating(false)
    // A landing refine loop still watching (its 1200ms window) would re-center
    // its target on the next tick and revert this jump — a button click is not
    // a scroller gesture, so the loop's own abort listeners never fire.
    scrollAbortRef.current?.()
    if (isJumpMode) {
      exitJumpMode()
      // The event window is about to be replaced wholesale (jump window →
      // latest window). Clear the prepend baseline so the next render isn't
      // mis-detected as a real prepend.
      resetShiftBaseline()
      requestAnimationFrame(() => {
        scrollToBottom({ force: true })
      })
    } else {
      scrollToBottom({ force: true })
    }
  }, [isJumpMode, exitJumpMode, cancelPendingJump, resetShiftBaseline, scrollToBottom])

  // Jump up to the first unread (the "New" divider) and stop following the tail
  // so a live message doesn't yank the reader back down. Lands the divider near
  // the top with a little context above so the run reads from the top.
  const scrollToFirstUnread = useCallback(() => {
    if (!dividerEventId) return
    disableAutoScroll()
    if (useVirtualized) {
      const idx = findEventItemIndex(visibleItems, dividerEventId)
      if (idx < 0) return
      try {
        programmaticScrollAtRef.current = performance.now()
        listRef.current?.scrollToIndex(idx, { align: "start", offset: -UNREAD_MARKER_TOP_GAP_PX })
      } catch {
        // A not-yet-measured virtua list can throw; the row is already rendered
        // by the time this button is clickable, so this is best-effort.
      }
    } else {
      programmaticScrollAtRef.current = performance.now()
      scrollContainerRef.current
        ?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(dividerEventId)}"]`)
        ?.scrollIntoView({ block: "start" })
    }
  }, [dividerEventId, useVirtualized, visibleItems, listRef, disableAutoScroll, scrollContainerRef])

  // Atomic stream landing (INV-70): the ONE once-per-stream-open decision
  // about where the viewport starts, resolved by resolveStreamLanding and
  // executed by the single landing effect below. New landing behaviors add a
  // StreamLanding variant to the resolver — never a second on-open scroll
  // effect; that stacking is exactly how the restore/marker/settle landers
  // used to fight each other.
  const preferencesCtx = usePreferencesOptional()
  const unreadOpenPosition = preferencesCtx?.preferences?.unreadOpenPosition ?? null
  const landingRef = useRef<{ streamId: string; decided: boolean }>({ streamId, decided: false })
  if (landingRef.current.streamId !== streamId) {
    landingRef.current = { streamId, decided: false }
    landingPendingRef.current = true
    detachedHoldRef.current = null
  }

  // The detached viewport guard's re-pin (see the guard block below for the
  // full contract). Declared here, above the restore effect, so the restore
  // can schedule a final pull after its refine loop ends.
  const applyDetachedHold = useCallback(() => {
    const hold = detachedHoldRef.current
    if (!hold) return
    const el = virtualScrollerEl
    if (!el || isFollowingTailRef.current) return
    if (scrollAbortRef.current) return
    if (userInteractedAtRef.current > hold.takenAt) return
    const escaped = CSS.escape(hold.id)
    const row = el.querySelector<HTMLElement>(`[data-message-id="${escaped}"], [data-event-id="${escaped}"]`)
    if (!row) return
    const delta = row.getBoundingClientRect().top - (el.getBoundingClientRect().top + hold.offsetPx)
    // Position-preserving by definition (re-pins the same row at the same
    // offset), so it does not stamp the programmatic-scroll ref — breaking a
    // user fling's sweep chain over a layout compensation was exactly the
    // false positive the stamp must avoid.
    if (Math.abs(delta) > 1) el.scrollTop += delta
  }, [virtualScrollerEl, isFollowingTailRef, userInteractedAtRef])
  useLayoutEffect(() => {
    // Consumed decisions bail before touching storage or scanning the window:
    // `visibleItems` re-runs this effect on every timeline tick for the life
    // of the stream, and the localStorage read + linear index scan below are
    // not free at that cadence.
    if (landingRef.current.decided) return
    const anchor = useVirtualized ? loadTimelineAnchor(streamId) : null
    const landing = resolveStreamLanding({
      // The per-stream deep-link latch, not the transient ?m= param — a
      // stream entered via deep-link must never land elsewhere, even after
      // ?m= clears.
      hasDeepLink: skipInitialScroll,
      isJumpMode,
      userInteractedAt: userInteractedAtRef.current,
      isLoading,
      hasItems: visibleItems.length > 0,
      // The nav type is per-navigation, so at decision time it still describes
      // how THIS stream was entered even though the decision can resolve a few
      // renders after the switch (waiting out the load). One PUSH is not a
      // stream choice: ExactRestore's second `?panel=` hop (routes/index.tsx)
      // pushes so the Android back gesture can close the restored panel — its
      // `panelPopsToClose` state marks the cold relaunch, which restore is for.
      isPushNavigation:
        navigationType === "PUSH" &&
        (location.state as { panelPopsToClose?: boolean } | null)?.panelPopsToClose !== true,
      anchor,
      anchorInWindow:
        anchor !== null &&
        !isLoading &&
        visibleItems.length > 0 &&
        findTimelineTargetIndex(visibleItems, anchor.targetId) >= 0,
      unreadOpenPosition,
      readStateResolved: frontierSequence !== undefined,
      dividerEventId,
    })
    if (landing === "wait") return
    landingRef.current.decided = true
    landingPendingRef.current = false
    // "tail" is the cold-load settle's own landing (it is already pinning
    // there behind the mask); deep-link and user-owned positions belong to
    // their machinery. Release a reveal the settle may have parked while the
    // decision was pending — nothing else to execute for any of them.
    if (landing.kind === "deep-link" || landing.kind === "owned" || landing.kind === "tail") {
      releaseDeferredReveal()
      return
    }
    // The plain thread scroller renders every row and has no settle mask —
    // a marker landing scrolls directly (restore never resolves for threads:
    // anchors are only ever captured on the virtualized path).
    if (!useVirtualized) {
      if (landing.kind === "marker" && !scrollToMessage(landing.dividerEventId, { align: "start" })) {
        scrollToFirstUnread()
      }
      return
    }
    // Positional landing: ENGAGE FIRST, then take over the cold-load settle.
    // Cancelling the settle before a scrollToMessage that bails synchronously
    // would strand the mask over an unconverged position with nothing left to
    // reveal at the right place — on a bail the settle (running or parked)
    // keeps owning the tail reveal instead. No rAF can interleave these
    // synchronous statements, so an engaged loop can never be pinned over.
    // Reveal is guarded by decision identity: a stream switch before the
    // refine loop ends must not strip the NEXT stream's settle mask.
    const decidedFor = landingRef.current
    const revealIfCurrent = () => {
      if (landingRef.current !== decidedFor) return
      revealSettle()
      // If the refine loop timed out without landing (contended device), the
      // guard still targets the landing — pull once more the next frame,
      // after the loop has released the scroller.
      requestAnimationFrame(applyDetachedHold)
    }
    const target =
      landing.kind === "restore"
        ? { id: landing.targetId, offsetPx: landing.offsetPx }
        : { id: landing.dividerEventId, offsetPx: UNREAD_MARKER_TOP_GAP_PX }
    const engaged =
      landing.kind === "restore"
        ? scrollToMessage(target.id, { align: "start", topOffsetPx: target.offsetPx, onFirstSettle: revealIfCurrent })
        : scrollToMessage(target.id, { align: "start", onFirstSettle: revealIfCurrent })
    if (engaged) {
      holdSettleForRestore()
      // Seed the detached-viewport guard: content resizes between engage and
      // the refine loop's first settle must re-target the landing, not slide
      // the viewport.
      detachedHoldRef.current = { ...target, takenAt: performance.now() }
    } else {
      releaseDeferredReveal()
      if (landing.kind === "marker") scrollToFirstUnread()
    }
  }, [
    useVirtualized,
    streamId,
    navigationType,
    location.state,
    isLoading,
    isJumpMode,
    skipInitialScroll,
    visibleItems,
    unreadOpenPosition,
    frontierSequence,
    dividerEventId,
    scrollToMessage,
    scrollToFirstUnread,
    holdSettleForRestore,
    revealSettle,
    releaseDeferredReveal,
    applyDetachedHold,
  ])

  // Persist the detached reading position for the restore above. While
  // following, the stream's entry is cleared (the tail is the default
  // landing); while detached, each settled scroll — and the page being hidden,
  // which is the last chance before a reload — snapshots the topmost visible
  // row and its offset from the viewport top.
  useEffect(() => {
    if (!useVirtualized) return
    const el = virtualScrollerEl
    if (!el) return
    let timer = 0
    const snapshot = () => {
      timer = 0
      if (isFollowingTailRef.current) {
        clearTimelineAnchor(streamId)
        detachedHoldRef.current = null
        return
      }
      // A scrollToMessage refine loop mid-flight means the current position is
      // transient, not a reading position. The debounce normally covers this
      // (each tick resets it), but pagehide/visibilitychange snapshot
      // SYNCHRONOUSLY — backgrounding the app mid-jump would persist an
      // arbitrary in-between scroll as the saved anchor. Keep the previous
      // anchor instead.
      if (scrollAbortRef.current) return
      const best = snapshotTopVisibleRow(el)
      if (best) {
        saveTimelineAnchor(streamId, { targetId: best.id, offsetPx: best.offsetPx })
        detachedHoldRef.current = { id: best.id, offsetPx: best.offsetPx, takenAt: performance.now() }
      }
    }
    const onScroll = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(snapshot, 250)
    }
    const onPageHide = () => {
      if (timer) window.clearTimeout(timer)
      snapshot()
    }
    // visibilitychange too: mobile OSes routinely discard a backgrounded PWA
    // without ever firing pagehide, and hidden is the documented last event.
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") onPageHide()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("pagehide", onPageHide)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      if (timer) window.clearTimeout(timer)
      el.removeEventListener("scroll", onScroll)
      window.removeEventListener("pagehide", onPageHide)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [useVirtualized, virtualScrollerEl, streamId, isFollowingTailRef])

  // Detached viewport guard. While the reader is parked off the tail, content
  // above them keeps resizing: virtua corrects size estimates as rows measure,
  // older pages prepend (virtua's `shift` diffing mangles the skeleton→rows
  // swap), late media and preview cards settle. Each of those slid the
  // viewport through the content — the "screen creeps after landing" bounce.
  // The guard re-pins the snapshot row to its exact offset:
  //  - pre-paint in the older-prepend landing commit (the known big jump);
  //  - on every content resize (ResizeObserver), catching estimate
  //    corrections and anything else that reshapes the window.
  // It yields to the user (any gesture newer than the snapshot) and to an
  // active scrollToMessage refine loop (which re-anchors its own target and
  // refreshes this snapshot when it settles). While following the tail the
  // bottom pin owns the position and the guard is inert.
  // Refresh the snapshot when an older fetch starts: the prepend can land up
  // to a second later, and the arm-time position is fresher than the last
  // debounced scroll snapshot.
  useEffect(() => {
    if (!isFetchingOlder || !useVirtualized) return
    const el = virtualScrollerEl
    if (!el || isFollowingTailRef.current) return
    const snap = snapshotTopVisibleRow(el)
    if (snap) detachedHoldRef.current = { ...snap, takenAt: performance.now() }
  }, [isFetchingOlder, useVirtualized, virtualScrollerEl, isFollowingTailRef])

  useLayoutEffect(() => {
    if (olderPrependLanded) applyDetachedHold()
  }, [olderPrependLanded, applyDetachedHold])

  useEffect(() => {
    if (!useVirtualized) return
    const content = virtualContentRef.current
    if (!content) return
    const ro = new ResizeObserver(() => applyDetachedHold())
    ro.observe(content)
    return () => ro.disconnect()
    // virtualScrollerEl: the content node remounts with the keyed scroller —
    // re-observe the fresh element after a stream switch.
  }, [useVirtualized, virtualContentRef, virtualScrollerEl, applyDetachedHold])

  const editLastMessageCtxWithScroll = useMemo(
    () => ({ ...editLastMessageCtx, scrollToMessage }),
    [editLastMessageCtx, scrollToMessage]
  )

  // Deep-link (?m=) mount hold. On a push-notification / Activities deep link
  // the latest window loads first; the jump effect then fetches the window
  // around the target and swaps `events` wholesale. A list mounted on the
  // latest window lands at the live tail, so the later window swap +
  // scrollToMessage would visibly yank the viewport over to the target.
  // Holding the skeleton until the target is actually in the loaded window
  // makes the single keyed mount land already-anchored on it (the pre-paint
  // centering jump needs the target row to exist at mount). Uses the
  // raw ?m= id (not the search-active id) so in-stream search is unaffected,
  // and releases when the target loads (deepLinkTargetLoaded), the jump
  // conclusively fails (deepLinkGaveUp), or the hold has been up for
  // DEEP_LINK_HOLD_MAX_MS (deepLinkHoldExpired) — past that bound a skeleton
  // reads worse than painting the cached window and snapping to the target
  // when the jump lands.
  const deepLinkTargetLoaded = useMemo(
    () => !highlightMessageId || events.some((e) => matchesDeepLinkTarget(e, highlightMessageId)),
    [events, highlightMessageId]
  )
  const holdForDeepLink = shouldHoldForDeepLink({
    highlightMessageId,
    deepLinkTargetLoaded,
    deepLinkGaveUp,
    holdExpired: deepLinkHoldExpired,
    isLoading,
    isConfirmedEmpty,
    hasEvents: events.length > 0,
  })

  // Keyed on the target too: a second ?m= navigation arriving while the first
  // hold is still up must get its own full window, not the remainder of the
  // previous target's.
  useEffect(() => {
    if (!holdForDeepLink || !highlightMessageId) return
    const timer = setTimeout(() => setDeepLinkHoldExpired(true), DEEP_LINK_HOLD_MAX_MS)
    return () => clearTimeout(timer)
  }, [holdForDeepLink, highlightMessageId])

  const prevHoldForDeepLinkRef = useRef(holdForDeepLink)
  if (prevHoldForDeepLinkRef.current !== holdForDeepLink) {
    prevHoldForDeepLinkRef.current = holdForDeepLink
    deepLinkDebug("holdForDeepLink ->", holdForDeepLink, "for", highlightMessageId)
  }

  // Strip the `?m=` highlight param a few seconds after the deep-link lands,
  // fading the highlight and restoring the canonical URL. Works for both the
  // main view and panels. The countdown is gated on the deep-link having
  // actually landed (or given up) rather than firing blindly from mount —
  // otherwise a slow cold-boot (push-notification) open clears the param
  // before <Virtuoso> mounts, dropping the mount anchor and dumping the user at
  // the top of the window. See shouldStartHighlightClear.
  const canStartHighlightClear = shouldStartHighlightClear({
    highlightMessageId,
    deepLinkTargetLoaded,
    deepLinkGaveUp,
  })
  useEffect(() => {
    if (!canStartHighlightClear) return
    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          prev.delete("m")
          return prev
        },
        { replace: true }
      )
    }, 3000)
    return () => clearTimeout(timer)
  }, [canStartHighlightClear, setSearchParams])

  // Per-row read-state gating signal: the read pointer's sequence. null while
  // the read state is unresolved or the pointer is outside the loaded window —
  // rows then leave both read-state actions visible (see rowReadState).
  const readFrontierSequence = useMemo<string | null>(() => {
    if (lastReadEventId === undefined) return null
    if (lastReadEventId === null) return "0"
    // Resolve against the unfiltered events so a pointer on a row that's
    // filtered out of the display still yields its sequence (else the gate
    // would wrongly fall back to ungated).
    return events.find((event) => event.id === lastReadEventId)?.sequence ?? null
  }, [events, lastReadEventId])

  const readFrontier = useMemo<ReadFrontier>(
    () => ({ sequence: readFrontierSequence, overlay: readOverlay }),
    [readFrontierSequence, readOverlay]
  )

  // Hard load error with nothing cached to fall back on. Placed after every
  // hook so the hook order stays stable: `error`/`idbStream` can toggle (a
  // failed fetch that later succeeds, or IDB resolving a beat after first
  // paint), and an early return above the hooks would change the hook count
  // between renders and crash the route.
  if (error && !isDraft && events.length === 0 && !idbStream) {
    return (
      <ErrorView
        className="h-full border-0"
        title="Failed to Load Messages"
        description="We couldn't load the messages for this stream. Please refresh the page or try again later."
      />
    )
  }

  const unreadBannerVisible = unreadAboveViewport && unreadCount > 0 && !batchMode && !isSearchOpen

  return (
    <ReadFrontierContext.Provider value={readFrontier}>
      <EditLastMessageContext.Provider value={editLastMessageCtxWithScroll}>
        <QuoteReplyProvider>
          <ConversationReplyProvider>
            <SlotsProvider map={mergedSlots}>
              <MessageConversationProvider conversationIdByMessageId={conversationIdByMessageId}>
                <TextSelectionQuote streamId={streamId} containerRef={quoteScopeRef} />
                <div ref={quoteScopeRef} className="relative h-full">
                  <div className="absolute inset-0 overflow-hidden">
                    {isSearchOpen && (
                      <StreamSearchBar
                        search={streamSearch}
                        isNavigating={isSearchNavigating}
                        onClose={handleSearchClose}
                        onNavigate={handleSearchNavigate}
                      />
                    )}
                    {batchMode &&
                      (batchIntent === "splitConversation" ? (
                        <SplitSelectionBar
                          count={selectedMessageIds.size}
                          workspaceId={workspaceId}
                          conversations={conversationOverlay?.model.conversations ?? streamConversations}
                          colorIndexById={conversationOverlay?.model.colorIndexById}
                          busy={isSplitting}
                          onMoveToExisting={runSplit}
                          onCreateNew={() => runSplit(null)}
                          onCancel={cancelBatchMode}
                        />
                      ) : (
                        <BatchSelectionBar count={selectedMessageIds.size} onCancel={cancelBatchMode} />
                      ))}
                    {activeConversationOverlay && (
                      <ConversationOverlayPanel
                        overlay={activeConversationOverlay}
                        workspaceId={workspaceId}
                        streamId={streamId}
                        inViewConversations={inViewConversations}
                        onClose={closeConversationOverlay}
                        // Split mode keeps the overlay panel mounted while the
                        // SplitSelectionBar occupies the flush-top strip; drop the
                        // panel below it so it doesn't cover the bar's actions.
                        topBarOpen={isSearchOpen || (batchMode && batchIntent === "splitConversation")}
                      />
                    )}
                    {isDraft && (
                      <div
                        ref={draftScrollRef}
                        className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain"
                        style={{ paddingBottom: "var(--composer-height, 0px)" }}
                      >
                        {hasDraftPendingEvents ? (
                          <EventList
                            timelineItems={draftTimelineItems}
                            isLoading={false}
                            workspaceId={workspaceId}
                            streamId={streamId}
                            viewerIsMember={isMember}
                            batch={batchState}
                          />
                        ) : (
                          <Empty className="h-full border-0">
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <MessageSquare />
                              </EmptyMedia>
                              <EmptyTitle>Start a conversation</EmptyTitle>
                              <EmptyDescription>Type a message below to begin this scratchpad.</EmptyDescription>
                            </EmptyHeader>
                          </Empty>
                        )}
                      </div>
                    )}
                    {!isDraft && useVirtualized && (
                      <>
                        <TimelineMessageList
                          visibleItems={visibleItems}
                          cancelledFollowUpIds={cancelledFollowUpIds}
                          delegationStatusPatches={delegationStatusPatches}
                          botAccessStatusPatches={botAccessStatusPatches}
                          callEndedPatches={callEndedPatches}
                          viewerIsMember={isMember}
                          isLoading={isLoading}
                          holdForDeepLink={holdForDeepLink}
                          isConfirmedEmpty={isConfirmedEmpty}
                          listRef={listRef}
                          scrollerRef={virtualScrollerRef}
                          registerScroller={registerVirtualScroller}
                          contentRef={virtualContentRef}
                          scrollAbortRef={scrollAbortRef}
                          isJumpMode={isJumpMode}
                          userInteractedAtRef={userInteractedAtRef}
                          shift={shift}
                          isInitialSettling={virtualIsInitialSettling}
                          onTimelineScroll={handleVirtualScroll}
                          isFollowingTailRef={isFollowingTailRef}
                          hasOlderEvents={hasOlderEvents}
                          hasNewerEvents={hasNewerEvents}
                          fetchOlderEvents={fetchOlderEvents}
                          fetchNewerEvents={fetchNewerEvents}
                          isFetchingOlder={isFetchingOlder}
                          isFetchingNewer={isFetchingNewer}
                          workspaceId={workspaceId}
                          streamId={streamId}
                          highlightMessageId={streamSearch.activeMessageId ?? highlightMessageId}
                          firstUnreadEventId={dividerEventId}
                          isDividerDimmed={isDividerDimmed}
                          agentActivity={agentActivity}
                          hideSessionCards={isChannel}
                          newMessageIds={newMessageIds}
                          isSearchOpen={isSearchOpen}
                          batch={batchState}
                          batchPointerHandlers={batchPointerHandlers}
                          conversationOverlay={activeConversationOverlay}
                          onJumpToDate={handleJumpToDate}
                          floatingChromeHidden={typingChromeHidden}
                        />
                        {/* Overlay loading indicators — absolutely positioned so they
                    don't cause layout shift when prepending older messages. */}
                        <div
                          aria-hidden={!isFetchingOlder}
                          className={cn(
                            "pointer-events-none absolute left-1/2 -translate-x-1/2 z-10 rounded-full bg-background/90 px-3 py-1 shadow-sm border text-xs text-muted-foreground transition-opacity",
                            isSearchOpen ? "top-14" : "top-2",
                            isFetchingOlder ? "opacity-100" : "opacity-0"
                          )}
                        >
                          Loading older messages...
                        </div>
                        <div
                          aria-hidden={!isFetchingNewer}
                          className={cn(
                            "pointer-events-none absolute left-1/2 -translate-x-1/2 z-20 rounded-full bg-background/90 px-3 py-1 shadow-sm border text-xs text-muted-foreground transition-opacity",
                            isFetchingNewer ? "opacity-100" : "opacity-0"
                          )}
                          style={{
                            // Sit above the Jump to latest button (when visible) which itself sits
                            // above the floating composer. chromeCollapsed unmounts that button, so
                            // the clearance drops with it.
                            bottom:
                              (isJumpMode || isScrolledFarFromBottom) && !chromeCollapsed
                                ? "calc(var(--composer-height, 0px) + 3.5rem)"
                                : "calc(var(--composer-height, 0px) + 0.5rem)",
                          }}
                        >
                          Loading newer messages...
                        </div>
                      </>
                    )}
                    {!isDraft && !useVirtualized && (
                      <div
                        ref={plainScrollRef}
                        className={cn(
                          "h-full overflow-y-auto overflow-x-hidden overscroll-y-contain",
                          (isSearchOpen || batchMode) && "pt-11",
                          batchMode && "select-none"
                        )}
                        style={{ paddingBottom: "var(--composer-height, 0px)" }}
                        data-suppress-pull-refresh="true"
                        onScroll={plainHandleScroll}
                        {...batchPointerHandlers}
                      >
                        <div ref={plainContentRef}>
                          {isThread && anchorEvent && parentStreamId && (
                            <ThreadParentEvent
                              event={anchorEvent}
                              workspaceId={workspaceId}
                              streamId={parentStreamId}
                              replyCount={displayEvents.length}
                            />
                          )}
                          {isFetchingOlder && (
                            <div className="flex justify-center py-2">
                              <p className="text-sm text-muted-foreground">Loading older messages...</p>
                            </div>
                          )}
                          <EventList
                            timelineItems={timelineItems}
                            isLoading={isLoading}
                            workspaceId={workspaceId}
                            streamId={streamId}
                            highlightMessageId={streamSearch.activeMessageId ?? highlightMessageId}
                            firstUnreadEventId={dividerEventId}
                            isDividerDimmed={isDividerDimmed}
                            agentActivity={agentActivity}
                            hideSessionCards={isChannel}
                            newMessageIds={newMessageIds}
                            viewerIsMember={isMember}
                            batch={batchState}
                            conversationOverlay={activeConversationOverlay}
                          />
                          {isFetchingNewer && (
                            <div className="flex justify-center py-2">
                              <p className="text-sm text-muted-foreground">Loading newer messages...</p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Jump to latest button — shown when scrolled far from bottom or in jump mode.
              Positioned above the floating composer pill. Hidden when that
              strip is too short or focused mobile typing needs the space. */}
                  {(isJumpMode || isScrolledFarFromBottom) && !typingChromeHidden && (
                    <div
                      className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-10"
                      style={{ bottom: "calc(var(--composer-height, 0px) + 0.5rem)" }}
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        className="pointer-events-auto shadow-lg gap-1.5"
                        onClick={handleJumpToLatest}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                        Jump to latest
                      </Button>
                    </div>
                  )}
                  {/* "N new messages" jump — shown when unread sits above the viewport.
              Jumps up to the "New" divider so the viewer can read from there.
              Hidden while search is open: jumping the timeline would yank it out
              from under the active search-result navigation, and the Escape
              mark-read shortcut is gated on `!isSearchOpen` too. */}
                  {unreadBannerVisible && !chromeCollapsed && (
                    <div
                      // Sits clearly below the floating date pill (top-2, ~30px tall)
                      // so the top-center affordances never overlap.
                      className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5"
                      style={{ top: "3.5rem" }}
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        className="pointer-events-auto shadow-lg gap-1.5"
                        onClick={scrollToFirstUnread}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                        {unreadCount} new message{unreadCount === 1 ? "" : "s"}
                      </Button>
                      {/* Dismiss without scrolling up: mark all loaded read and tail
                  the live bottom — the touchable equivalent of Escape. */}
                      <Button
                        variant="secondary"
                        size="icon"
                        className="pointer-events-auto h-9 w-9 shadow-lg"
                        onClick={escapeUnread}
                        aria-label="Mark all read"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                  {dragGhost && (
                    <div
                      className="pointer-events-none fixed z-50 max-w-[280px] rounded-md border bg-popover/95 px-3 py-2 text-sm shadow-lg"
                      style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
                    >
                      <div className="font-medium">{selectedMessageIds.size} selected</div>
                      <div className="line-clamp-1 text-xs text-muted-foreground">
                        {Array.from(selectedMessageIds)
                          .map((messageId) => {
                            const content = messageEventMeta.get(messageId)?.content
                            return content ? stripMarkdownToInline(content) : null
                          })
                          .filter(Boolean)
                          .slice(0, 1)
                          .join("")}
                      </div>
                    </div>
                  )}
                  <AlertDialog
                    open={moveDialogOpen}
                    onOpenChange={(open) => {
                      if (open) return
                      // Cancel + Esc are allowed during validating (we just bump the
                      // cancellation token and the in-flight request becomes a no-op
                      // on resolve). Only the irreversible commit phase blocks
                      // dismiss — there is no rollback once moveToThread succeeds.
                      if (isMoveConfirming) return
                      closePendingMove()
                    }}
                  >
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Move messages?</AlertDialogTitle>
                        <AlertDialogDescription>{`Move ${moveMessageCountLabel} into this thread?`}</AlertDialogDescription>
                      </AlertDialogHeader>
                      {/* Custom footer: status row (left) + actions (right). Replaces
                  shadcn's AlertDialogFooter, which forces flex-col-reverse on
                  mobile and would invert our vertical stacking. */}
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                        <MoveStatusRow phase={movePhase} />
                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-2">
                          <AlertDialogCancel disabled={movePhase === "moving"}>Cancel</AlertDialogCancel>
                          {/* `preventDefault` keeps the dialog open through the
                      moving phase so the inline status row can transition
                      to "Moving…" — Radix's default Action behavior would
                      auto-close on click. confirmPendingMove closes the
                      dialog itself on success via cancelBatchMode. */}
                          <AlertDialogAction
                            onClick={(event) => {
                              event.preventDefault()
                              void confirmPendingMove()
                            }}
                            disabled={movePhase !== "validated"}
                            aria-busy={movePhase === "moving"}
                          >
                            Move
                          </AlertDialogAction>
                        </div>
                      </div>
                    </AlertDialogContent>
                  </AlertDialog>
                  {membershipResolved && !isMember && isPublicChannel && (
                    <div className="absolute inset-x-0 bottom-0 z-10">
                      <JoinChannelBar
                        workspaceId={workspaceId}
                        streamId={streamId}
                        channelName={stream?.slug ?? stream?.displayName ?? ""}
                        onJoined={handleJoined}
                        onHeightChange={handleComposerHeightChange}
                      />
                    </div>
                  )}
                  {(isMember || !isPublicChannel || !membershipResolved) && (
                    <MessageInput
                      workspaceId={workspaceId}
                      streamId={streamId}
                      disabled={isArchived || isSystem}
                      disabledReason={disabledReason}
                      autoFocus={autoFocus}
                      onComposerHeightChange={handleComposerHeightChange}
                      onMobileTypingChange={setMobileComposerTyping}
                    />
                  )}
                </div>
              </MessageConversationProvider>
            </SlotsProvider>
          </ConversationReplyProvider>
        </QuoteReplyProvider>
      </EditLastMessageContext.Provider>
    </ReadFrontierContext.Provider>
  )
}

/** Virtuoso-powered message list for streams, channels, and scratchpads */
function TimelineMessageList({
  visibleItems,
  cancelledFollowUpIds,
  delegationStatusPatches,
  botAccessStatusPatches,
  callEndedPatches,
  viewerIsMember,
  isLoading,
  holdForDeepLink,
  isConfirmedEmpty,
  listRef,
  scrollerRef,
  registerScroller,
  contentRef,
  scrollAbortRef,
  isJumpMode,
  userInteractedAtRef,
  shift,
  isInitialSettling,
  onTimelineScroll,
  isFollowingTailRef,
  hasOlderEvents,
  hasNewerEvents,
  fetchOlderEvents,
  fetchNewerEvents,
  isFetchingOlder,
  isFetchingNewer,
  workspaceId,
  streamId,
  highlightMessageId,
  firstUnreadEventId,
  isDividerDimmed,
  agentActivity,
  hideSessionCards,
  newMessageIds,
  isSearchOpen,
  batch,
  batchPointerHandlers,
  conversationOverlay,
  onJumpToDate,
  floatingChromeHidden,
}: {
  visibleItems: TimelineItem[]
  cancelledFollowUpIds: Set<string>
  delegationStatusPatches: Map<string, DelegationStatusChangedEventPayload>
  botAccessStatusPatches: Map<string, BotAccessStatusChangedEventPayload>
  callEndedPatches: Map<string, CallEndedEventPayload>
  /** True when the viewer is a member — gates the bot-access card's Approve/Deny. */
  viewerIsMember?: boolean
  isLoading: boolean
  /** Hold the skeleton until a deep-link (?m=) target is in the loaded window
   *  so the keyed list mounts already anchored on it. */
  holdForDeepLink: boolean
  /** True only when we've fully resolved IDB and bootstrap and the stream is
   *  actually empty. During mid-switch transitions this is false, so we avoid
   *  flashing the "No messages yet" state before useLiveQuery catches up. */
  isConfirmedEmpty: boolean
  /** virtua imperative handle (scrollToIndex for deep-link rendering). */
  listRef: React.RefObject<VirtualizerHandle | null>
  /** The scroll container we own (read-only handle; attach via registerScroller). */
  scrollerRef: React.RefObject<HTMLDivElement | null>
  /** Ref callback for the scroller `<div>`; keeps scrollerRef live and re-arms
   *  the ResizeObserver once the scroller mounts. */
  registerScroller: (node: HTMLDivElement | null) => void
  /** Inner content wrapper (sized to full scroll height). */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Non-null while a scrollToMessage refine loop is in flight. Programmatic
   *  scroll-into-view must not trigger edge pagination. */
  scrollAbortRef: React.MutableRefObject<(() => void) | null>
  /** True while reading a deep-linked / searched history window. */
  isJumpMode: boolean
  /** Last genuine user scroll gesture on the scroller. */
  userInteractedAtRef: React.MutableRefObject<number>
  /** virtua `shift`: maintain scroll from the end on this render (older page
   *  prepended) so the viewport doesn't move. */
  shift: boolean
  /** True during the cold-load settle: mask the list with a skeleton overlay so
   *  the measurement bounce stays off-screen until the height stabilises. */
  isInitialSettling: boolean
  /** Scroll handler from useTimelineScroll (updates at-bottom / follow state). */
  onTimelineScroll: () => void
  /** True while parked at the live tail; gates older-history prefetch. */
  isFollowingTailRef: React.MutableRefObject<boolean>
  hasOlderEvents: boolean
  hasNewerEvents: boolean
  fetchOlderEvents: () => boolean
  fetchNewerEvents: () => boolean
  isFetchingOlder: boolean
  isFetchingNewer: boolean
  workspaceId: string
  streamId: string
  highlightMessageId?: string | null
  firstUnreadEventId?: string
  isDividerDimmed?: boolean
  agentActivity?: Map<string, import("@/hooks").MessageAgentActivity>
  hideSessionCards?: boolean
  newMessageIds?: Set<string>
  isSearchOpen: boolean
  batch?: BatchTimelineState
  batchPointerHandlers?: React.HTMLAttributes<HTMLElement>
  conversationOverlay?: ConversationOverlayContext
  /** Jump to the first message on or after a date (floating date header). */
  onJumpToDate: (date: Date) => void
  /** True while floating date/jump chrome must yield to the composer. */
  floatingChromeHidden: boolean
}) {
  const { phase } = useCoordinatedLoading()
  const socket = useSocket()
  const stopAgentSession = useStopAgentSession(socket, workspaceId, streamId)
  const steerAgentSession = useSteerAgentSession(workspaceId, streamId)

  // Tracks whether this component has ever rendered with real timeline content.
  // Drives the empty fallback below: until the first paint, useEvents has not
  // resolved IDB yet and the user just came off MainContentGate's skeleton —
  // a blank frame here is the visible "skeleton, then nothing, then content"
  // regression. Sticky across stream switches so fast switches keep the
  // existing blank behaviour (no skeleton flash on top of prior chrome).
  const hasRenderedContentRef = useRef(false)

  // Floating date header (INV-42): the local day of the topmost visible row,
  // and whether the pill is shown. Updated from the scroll handler so it tracks
  // the day as the user scrolls, like Slack's sticky date.
  const [topDayMs, setTopDayMs] = useState<number | null>(null)
  const [datePillVisible, setDatePillVisible] = useState(false)
  const visibleItemsRef = useRef(visibleItems)
  visibleItemsRef.current = visibleItems

  const { sessionLiveCounts, sessionLiveSubsteps } = useMemo(() => {
    const counts = new Map<string, { stepCount: number; messageCount: number }>()
    const substeps = new Map<string, string | null>()
    if (agentActivity) {
      for (const activity of agentActivity.values()) {
        counts.set(activity.sessionId, {
          stepCount: activity.stepCount,
          messageCount: activity.messageCount,
        })
        substeps.set(activity.sessionId, activity.substep)
      }
    }
    return { sessionLiveCounts: counts, sessionLiveSubsteps: substeps }
  }, [agentActivity])

  const handleStopSession = useCallback((sessionId: string) => stopAgentSession(sessionId), [stopAgentSession])

  // First-message lookup for the context-bag attachment badge anchor.
  // Computed once per timeline change; the Virtuoso path threads this through
  // `renderCtx` so the badge can light up on whichever message the
  // conversation opened with. Without this, virtualized scratchpad timelines
  // would never get `isFirstMessage=true` and the badge would silently drop.
  const firstMessageId = useMemo(() => findFirstMessageId(visibleItems), [visibleItems])

  const renderCtx = useMemo<TimelineItemRenderContext>(
    () => ({
      workspaceId,
      streamId,
      highlightMessageId,
      firstUnreadEventId,
      isDividerDimmed,
      agentActivity,
      hideSessionCards,
      newMessageIds,
      firstMessageId,
      sessionLiveCounts,
      sessionLiveSubsteps,
      onStopSession: handleStopSession,
      onSteerSession: steerAgentSession,
      cancelledFollowUpIds,
      delegationStatusPatches,
      botAccessStatusPatches,
      callEndedPatches,
      viewerIsMember,
      batch,
      conversationOverlay,
    }),
    [
      workspaceId,
      streamId,
      highlightMessageId,
      firstUnreadEventId,
      isDividerDimmed,
      agentActivity,
      hideSessionCards,
      newMessageIds,
      firstMessageId,
      sessionLiveCounts,
      sessionLiveSubsteps,
      handleStopSession,
      steerAgentSession,
      cancelledFollowUpIds,
      delegationStatusPatches,
      botAccessStatusPatches,
      callEndedPatches,
      viewerIsMember,
      batch,
      conversationOverlay,
    ]
  )

  // Stagger the post-reveal hydration burst (INV-21 adjacent): when the
  // coordinated-loading phase flips to "ready", releasing every row's
  // deferSecondaryHydration at once fires all presigns/link previews/embeds
  // in one frame — a long task right at reveal. Instead release rows in
  // batches from the bottom (the viewport on a chat) upward, one batch per
  // frame. Once every row present at release time is hydrated, latch open so
  // later prepends/appends hydrate immediately.
  const HYDRATION_RELEASE_BATCH = 8
  const [hydrationWave, setHydrationWave] = useState(0)
  const fullyHydratedRef = useRef(false)
  const lastHydrationStreamRef = useRef(streamId)
  if (lastHydrationStreamRef.current !== streamId) {
    lastHydrationStreamRef.current = streamId
    fullyHydratedRef.current = false
    setHydrationWave(0)
  }
  const itemCount = visibleItems.length
  useEffect(() => {
    if (phase !== "ready" || fullyHydratedRef.current) return
    if (hydrationWave * HYDRATION_RELEASE_BATCH >= itemCount) {
      fullyHydratedRef.current = true
      return
    }
    const id = requestAnimationFrame(() => setHydrationWave((wave) => wave + 1))
    return () => cancelAnimationFrame(id)
  }, [phase, hydrationWave, itemCount])
  const releasedFromBottom = hydrationWave * HYDRATION_RELEASE_BATCH

  const olderFetchCooldownRef = useRef(0)
  const newerFetchCooldownRef = useRef(0)
  const FETCH_COOLDOWN_MS = 500

  const handleStartReached = useCallback(() => {
    // isFollowingTailRef is true while parked at the live tail. Reading
    // scrollHeight forces layout, so only measure in that case (see
    // shouldPrefetchOlderHistory): block the on-load prepend-jump when the
    // viewport is scrollable, but still let a window that fits the viewport
    // page in history the user can't scroll to.
    const followingLiveTail = isFollowingTailRef.current
    const el = scrollerRef.current
    const scrollerScrollable = followingLiveTail && el ? el.scrollHeight > el.clientHeight + 1 : false
    if (!shouldPrefetchOlderHistory({ followingLiveTail, scrollerScrollable, hasOlderEvents, isFetchingOlder })) return
    const now = performance.now()
    if (now < olderFetchCooldownRef.current) return
    const started = fetchOlderEvents()
    if (started !== false) {
      olderFetchCooldownRef.current = now + FETCH_COOLDOWN_MS
    }
  }, [hasOlderEvents, isFetchingOlder, fetchOlderEvents, isFollowingTailRef, scrollerRef])

  const handleEndReached = useCallback(() => {
    if (!hasNewerEvents || isFetchingNewer) return
    const now = performance.now()
    if (now < newerFetchCooldownRef.current) return
    const started = fetchNewerEvents()
    if (started !== false) {
      newerFetchCooldownRef.current = now + FETCH_COOLDOWN_MS
    }
  }, [hasNewerEvents, isFetchingNewer, fetchNewerEvents])

  // Refresh the floating date header: the topmost visible day (nearest item to
  // the scroll offset, scanning for the first row that carries a day) and the
  // pill's visibility. Reads visibleItems off a ref so it stays stable across
  // data ticks and doesn't churn the scroll handler it's called from.
  const updateDatePill = useCallback(() => {
    const list = listRef.current
    const el = scrollerRef.current
    if (!list || !el) return
    let idx: number
    try {
      idx = list.findItemIndex(list.scrollOffset)
    } catch {
      return
    }
    const items = visibleItemsRef.current
    let day: number | null = null
    for (let i = Math.max(0, idx); i < items.length && day == null; i++) day = itemDayStartMs(items[i])
    if (day == null)
      for (let i = Math.min(idx, items.length - 1); i >= 0 && day == null; i--) day = itemDayStartMs(items[i])
    setTopDayMs((prev) => (prev === day ? prev : day))
    const show = el.scrollTop > 40 && !isSearchOpen && !batch?.enabled && !isFetchingOlder && !isInitialSettling
    setDatePillVisible((prev) => (prev === show ? prev : show))
  }, [listRef, scrollerRef, isSearchOpen, batch?.enabled, isFetchingOlder, isInitialSettling])

  // Pagination is driven off the owned scroller's native scroll. virtua has no
  // rangeChanged, so we measure distance from each edge in px and prefetch when
  // within a lead distance. Gated so a programmatic deep-link scroll never
  // kicks off pagination (its reflow would fight the refine loop).
  const handleScroll = useCallback(() => {
    onTimelineScroll()
    updateDatePill()
    if (
      !shouldRunEdgePagination({
        scrollRefineActive: scrollAbortRef.current !== null,
        isJumpMode,
        userInteractedAt: userInteractedAtRef.current,
      })
    ) {
      return
    }
    const el = scrollerRef.current
    if (!el) return
    const { reachedStart, reachedEnd } = computeScrollEdges({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      prefetchPx: EDGE_PREFETCH_PX,
    })
    if (reachedStart) handleStartReached()
    if (reachedEnd) handleEndReached()
  }, [
    onTimelineScroll,
    updateDatePill,
    scrollAbortRef,
    isJumpMode,
    userInteractedAtRef,
    scrollerRef,
    handleStartReached,
    handleEndReached,
  ])

  // virtua has no rangeChanged, so a window that fits the viewport (not
  // scrollable) would never fire a scroll to page in older history the user
  // can't scroll to reach. Re-check the edges after each content change, on the
  // next frame so virtua has measured. The cooldowns + shouldPrefetchOlderHistory
  // gating keep this from looping; after a prepend the held scroll position sits
  // further from the top, so reachedStart clears.
  useEffect(() => {
    const id = requestAnimationFrame(() => handleScroll())
    return () => cancelAnimationFrame(id)
  }, [visibleItems.length, handleScroll])

  // The genuine-input stamp on the owned scroller lives in useTimelineScroll,
  // gated on the mounted scroller element — an effect here keyed on streamId
  // attached to a null ref on cold loads (the scroller mounts behind the
  // skeleton) and never re-ran, leaving the stamp dead.

  // Center the deep-linked target on mount/when it loads. virtua mounts at the
  // top; this anchors it near the target before the scrollToMessage refine loop
  // takes over (and before paint, so there's no flash from the top). Runs once
  // per stream: the keyed scroller div remounts on switch but this component
  // does NOT, so the ref must be reset by hand when the stream changes.
  const didInitialJumpRef = useRef(false)
  const lastJumpStreamRef = useRef(streamId)
  if (lastJumpStreamRef.current !== streamId) {
    lastJumpStreamRef.current = streamId
    didInitialJumpRef.current = false
  }
  useLayoutEffect(() => {
    if (didInitialJumpRef.current || !highlightMessageId) return
    const idx = findMessageItemIndex(visibleItems, highlightMessageId)
    if (idx < 0) return
    try {
      listRef.current?.scrollToIndex(idx, { align: "center" })
    } catch {
      // virtua can throw on a not-yet-measured list; the refine loop recovers.
    }
    didInitialJumpRef.current = true
  }, [highlightMessageId, visibleItems, listRef])

  // Reserve room at the top for the floating BatchSelectionBar / StreamSearchBar
  // when open (taller), otherwise a small spacer so the head row's hover toolbar
  // isn't clipped. Rendered as a real element above the virtualizer; its height
  // is fed to virtua via startMargin so index math stays aligned.
  const reservedTopSpacer = isSearchOpen || batch?.enabled
  const topSpacerRef = useRef<HTMLDivElement>(null)
  const [startMargin, setStartMargin] = useState(0)
  useLayoutEffect(() => {
    setStartMargin(topSpacerRef.current?.offsetHeight ?? 0)
  }, [reservedTopSpacer])

  // Single skeleton shape shared by the active-load branch and the cold-boot
  // empty fallback so the seam between MainContentGate's skeleton and
  // StreamContent's first paint is invisible.
  const skeleton = (
    <div className="flex flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex gap-3">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  )

  if (isLoading || holdForDeepLink) {
    return skeleton
  }

  // Only render the empty state when we're *certain* the stream has no events.
  // Without this guard, the mid-switch gap where visibleItems is briefly [] (IDB
  // re-subscribing after a streamId change) would flash the empty state before
  // the real data arrives.
  if (visibleItems.length === 0 && isConfirmedEmpty) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">No messages yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Start the conversation by sending a message below</p>
        </div>
      </div>
    )
  }

  // Grace-window gap: !isLoading, !isConfirmedEmpty, but events haven't been
  // re-subscribed from IDB yet (the "render briefly blank, no skeleton flash"
  // path in computeTimelineLoadState). Two sub-cases:
  //
  //  - First-ever render (cold boot): MainContentGate just released its
  //    skeleton, useLiveQuery has not resolved yet. A blank gap here lets the
  //    skeleton→content transition show a visible "nothing" frame, which is
  //    exactly the regression report ("skeleton, then nothing again, then
  //    content"). Keep the skeleton on screen until IDB resolves so the
  //    handoff is seamless.
  //  - Subsequent renders (stream switch): we've already painted content, so
  //    a brief blank is preferable to a skeleton flash. The previous stream's
  //    chrome is the visible background; rendering a skeleton on top of it
  //    would jiggle the layout.
  //
  // Either way we mustn't mount the virtualized list empty: the initial
  // scroll-to-bottom and the cold-load settle mask in useTimelineScroll both
  // arm when items first exist, so a list mounted with zero items paints an
  // empty top-anchored frame and the populate + pin a frame later is visible
  // (the "loads in too low then jumps" report). Deferring the mount until
  // data exists makes the keyed instance mount already-populated, exactly
  // like cold boot, so the settle mask covers the measurement bounce.
  if (visibleItems.length > 0) hasRenderedContentRef.current = true
  if (visibleItems.length === 0) {
    return hasRenderedContentRef.current ? <div className="h-full" aria-hidden /> : skeleton
  }

  return (
    // Remount per stream (keyed) so all scroll state — the owned scroller, the
    // useTimelineScroll ResizeObserver, the deep-link jump latch — resets on a
    // switch and the new stream mounts already-populated at its tail.
    //
    // During the cold-load settle the scroller is mounted (so virtua can measure
    // item heights) but masked by a skeleton overlay, so the measurement bounce
    // happens off-screen; the hook flips `isInitialSettling` false once the
    // height stabilises. The overlay is pointer-events-none so an eager scroll
    // still reaches the scroller (which aborts the settle and reveals at once).
    <>
      <div
        key={streamId}
        ref={registerScroller}
        className={cn("h-full overflow-y-auto overflow-x-hidden overscroll-y-contain", batch?.enabled && "select-none")}
        style={{ overflowAnchor: "none" }}
        data-suppress-pull-refresh="true"
        onScroll={handleScroll}
        {...batchPointerHandlers}
      >
        <div ref={contentRef}>
          <div ref={topSpacerRef}>{reservedTopSpacer ? <BarTopSpacer /> : <StreamHeaderSpacer />}</div>
          <Virtualizer
            ref={listRef}
            scrollRef={scrollerRef}
            startMargin={startMargin}
            // Maintain scroll from the end when an older page is prepended so the
            // viewport doesn't move — the core reverse-infinite-scroll fix.
            shift={shift}
            // Off-screen px kept mounted so fast scrolling doesn't outrun
            // mount+measure and flash blank rows. Was 1000 when every data tick
            // re-rendered the whole window; with memoized rows the steady-state
            // cost of extra mounted rows is near zero, so a larger buffer buys
            // fling headroom. Mount cost still bounds it — don't raise further
            // without profiling on a low-end device.
            bufferSize={2000}
          >
            {visibleItems.map((item, index) => (
              <div key={getTimelineItemKey(item)} className="relative mx-auto max-w-[800px]">
                <TimelineItemContent
                  item={item}
                  ctx={renderCtx}
                  deferSecondaryHydration={
                    !fullyHydratedRef.current && (phase !== "ready" || index < visibleItems.length - releasedFromBottom)
                  }
                />
              </div>
            ))}
          </Virtualizer>
          <ComposerFooterSpacer />
        </div>
      </div>
      <StreamDateHeader
        dayStartMs={topDayMs}
        visible={datePillVisible && !floatingChromeHidden}
        onJumpToDate={onJumpToDate}
        scrollerRef={scrollerRef}
      />
      {isInitialSettling && (
        <div aria-hidden data-testid="settle-mask" className="pointer-events-none absolute inset-0 z-10 bg-background">
          {skeleton}
        </div>
      )}
    </>
  )
}

// Spacer reserving room for the floating composer pill, so the most recent
// message sits visually offset above the pill at rest and the at-bottom edge
// accounts for the composer's height.
const StreamHeaderSpacer = () => <div className="h-3 sm:h-6" aria-hidden />

const ComposerFooterSpacer = () => <div aria-hidden style={{ height: "var(--composer-height, 0px)" }} />

// 44px scrollable spacer reserved at the top while the search or batch-selection
// bar is open. Both bars render `absolute top-0` outside the scroller; this
// reserves matching room *inside* it so the topmost item never sits permanently
// underneath either bar. h-11 keeps the numbers aligned with `StreamSearchBar` /
// `BatchSelectionBar`.
const BarTopSpacer = () => <div aria-hidden className="h-11" />

/**
 * Three-phase state for the batch-move confirmation dialog. Drives the
 * inline footer status row (`MoveStatusRow`) and the disabled / aria-busy
 * state of the Move button.
 *
 * - `validating` — drop just landed, server validate is in flight, lease
 *   not yet returned. Move button disabled, Cancel still allowed.
 * - `validated`  — lease in hand, user gates the irreversible commit.
 * - `moving`     — moveToThread in flight. Both buttons disabled, Move
 *   carries `aria-busy` for assistive tech.
 */
type MovePhase = "validating" | "validated" | "moving"

/**
 * Inline status indicator pinned to the left of the dialog footer. The
 * dialog body (title + description) stays constant across all three
 * phases — this row is the only thing that changes, so the user never
 * has to re-read the question. `min-h-[1.75rem]` locks the row height
 * so the icon swap from spinner → check pill doesn't jiggle the buttons.
 *
 * Accessibility: `role="status"` + `aria-live="polite"` + `aria-atomic`
 * causes assistive tech to announce each phase transition once, as a
 * complete sentence ("Verifying…", "Verified", "Moving…"). Icons are
 * decorative (`aria-hidden`) — the text label carries the meaning.
 */
function MoveStatusRow({ phase }: { phase: MovePhase }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex min-h-[1.75rem] items-center gap-2 text-[13px] leading-none tabular-nums"
    >
      {phase === "validating" && (
        <>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/80" aria-hidden />
          <span className="text-muted-foreground">Verifying…</span>
        </>
      )}
      {phase === "validated" && (
        <>
          <span
            aria-hidden
            className={cn(
              "grid h-4 w-4 shrink-0 place-content-center rounded-full",
              "bg-emerald-500/15 text-emerald-600",
              "animate-in fade-in zoom-in-50 duration-300"
            )}
          >
            <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
          </span>
          <span className="font-medium text-emerald-600">Verified</span>
        </>
      )}
      {phase === "moving" && (
        <>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden />
          <span className="text-foreground">Moving…</span>
        </>
      )}
    </div>
  )
}

/**
 * Flush-top toolbar shown while batch-selection mode is active. Mirrors the
 * `StreamSearchBar` pattern (h-11 strip, border-b, blurred translucent
 * background) so the scroller's matching `pt-11` keeps every previously
 * visible message reachable — the topmost item slides under the bar instead
 * of disappearing.
 */
function BatchSelectionBar({ count, onCancel }: { count: number; onCancel: () => void }) {
  const hint = count === 0 ? "Tap messages to select" : "Drag onto a message above to move"

  return (
    <div
      className={cn(
        "absolute top-0 left-0 right-0 z-20",
        "flex items-center gap-2 px-2 py-1.5 sm:px-4 sm:py-2",
        "bg-background/95 backdrop-blur-sm border-b shadow-sm"
      )}
      // Outer toolbar listens for nothing — its children handle their own
      // events. Setting select-none here prevents accidental text selection
      // when the user starts dragging from a message and crosses the bar.
      style={{ userSelect: "none" }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={cn(
            "inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full",
            "text-xs font-medium tabular-nums tracking-tight transition-colors",
            count > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}
          aria-live="polite"
        >
          {count}
        </span>
        <span className="hidden sm:inline text-sm font-medium">
          {count === 1 ? "message selected" : "messages selected"}
        </span>
      </div>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Move className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{hint}</span>
      </div>

      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onCancel} aria-label="Cancel selection">
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

/**
 * The split-conversation twin of {@link BatchSelectionBar}. Same flush-top strip,
 * but instead of the drag-to-target hint it offers a target picker: reassign the
 * selection into an existing conversation, or split it into a new one. No drag,
 * no confirm dialog — membership moves are reversible.
 */
function SplitSelectionBar({
  count,
  workspaceId,
  conversations,
  colorIndexById,
  busy,
  onMoveToExisting,
  onCreateNew,
  onCancel,
}: {
  count: number
  workspaceId: string
  conversations: ConversationWithStaleness[]
  colorIndexById?: ReadonlyMap<string, number>
  busy: boolean
  onMoveToExisting: (conversationId: string) => void
  onCreateNew: () => void
  onCancel: () => void
}) {
  const disabled = count === 0 || busy
  const streams = useWorkspaceStreams(workspaceId)

  return (
    <div
      className={cn(
        "absolute top-0 left-0 right-0 z-20",
        "flex items-center gap-2 px-2 py-1.5 sm:px-4 sm:py-2",
        "bg-background/95 backdrop-blur-sm border-b shadow-sm"
      )}
      style={{ userSelect: "none" }}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={cn(
            "inline-flex items-center justify-center h-6 min-w-6 px-1.5 rounded-full",
            "text-xs font-medium tabular-nums tracking-tight transition-colors",
            count > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
          )}
          aria-live="polite"
        >
          {count}
        </span>
        <span className="hidden sm:inline text-sm font-medium">
          {count === 1 ? "message selected" : "messages selected"}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="h-7 gap-1.5"
              disabled={disabled}
              aria-label="Move selected messages to a conversation"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Move className="h-3.5 w-3.5" aria-hidden />
              )}
              <span>Move to…</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[50dvh] w-64 overflow-y-auto">
            <DropdownMenuItem onSelect={() => onCreateNew()} className="gap-2">
              <Plus className="h-4 w-4 shrink-0" aria-hidden />
              <span>New conversation</span>
            </DropdownMenuItem>
            {conversations.length > 0 && <DropdownMenuSeparator />}
            {conversations.map((conversation) => (
              <DropdownMenuItem
                key={conversation.id}
                onSelect={() => onMoveToExisting(conversation.id)}
                className="gap-2"
              >
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: conversationColor(colorIndexById?.get(conversation.id) ?? 0) }}
                />
                <span className="min-w-0 flex-1 truncate">
                  {effectiveConversationTitle(
                    conversation,
                    streams.find((stream) => stream.id === conversation.streamId)
                  ) || "Untitled conversation"}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {conversation.messageIds.length}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          // Disabled mid-request: the reassign can't be aborted (cancelBatchMode
          // only resets local UI), and letting the bar vanish while the mutation
          // still lands would silently reassign after an apparent cancel. Matches
          // the move-to-thread dialog's Cancel guard.
          disabled={busy}
          onClick={onCancel}
          aria-label="Cancel selection"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
