import { useMemo, useEffect, useLayoutEffect, useCallback, useRef, useState } from "react"
import { useLocation, useSearchParams } from "react-router-dom"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { MessageSquare, ArrowDown, ArrowUp, X, Move, Loader2, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import {
  useEvents,
  useStreamSocket,
  useTimelineScroll,
  useScrollBehavior,
  useStreamBootstrap,
  useWorkspaceUserId,
  useAutoMarkAsRead,
  useLastSeenEvent,
  useUnreadCounts,
  useUnreadDivider,
  isDividerReadPast,
  useIsMobile,
  useNewMessageIndicator,
  useAgentActivity,
  useAbortResearch,
  useEditLastMessageTrigger,
  useKeyboardShortcuts,
  streamKeys,
  workspaceKeys,
} from "@/hooks"
import { useSocket, useCoordinatedLoading } from "@/contexts"
import { useMessageService } from "@/contexts"
import { useStreamEvents } from "@/stores/stream-store"
import { useWorkspaceStreams, useWorkspaceStreamMemberships } from "@/stores/workspace-store"
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
} from "@threa/types"
import { isAbortableStepType } from "@/lib/step-config"
import {
  EventList,
  TimelineItemContent,
  groupTimelineItems,
  annotateAuthorGroups,
  annotateConversationRows,
  injectGapItems,
  injectDayDividers,
  itemDayStartMs,
  findFirstMessageId,
  findMessageItemIndex,
  findEventItemIndex,
  getTimelineItemKey,
  filterVisibleItems,
  OLDER_SKELETON_ITEMS,
  type TimelineItem,
  type TimelineItemRenderContext,
  type BatchTimelineState,
} from "./event-list"
import { ConversationOverlayPanel } from "./conversation-overlay/conversation-overlay"
import { useConversationOverlay } from "./conversation-overlay/use-conversation-overlay"
import type { ConversationOverlayContext } from "./conversation-overlay/model"
import { MessageInput } from "./message-input"
import { StreamDateHeader } from "./stream-date-header"
import { JoinChannelBar } from "./join-channel-bar"
import { ThreadParentMessage } from "../thread/thread-parent-message"
import { EditLastMessageContext } from "./edit-last-message-context"
import { QuoteReplyProvider } from "./quote-reply-context"
import { SharedMessagesProvider } from "@/components/shared-messages/context"
import { TextSelectionQuote } from "./text-selection-quote"
import { StreamSearchBar } from "./stream-search-bar"
import { useStreamSearch } from "@/hooks/use-stream-search"
import { useSearchHighlight } from "@/hooks/use-search-highlight"
import { stripMarkdownToInline } from "@/lib/markdown"
import { localStartOfDayMs } from "@/lib/dates"
import { addStartBatchSelectListener } from "@/lib/batch-selection-events"
import { addMarkReadUpToHereListener, addMarkUnreadListener } from "@/lib/mark-read-events"
import { ReadFrontierContext } from "./read-frontier-context"

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
  const user = useUser()
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
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
  const lastReadEventId = idbStream?.lastReadEventId ?? membership?.lastReadEventId

  const stream = streamFromProps ?? idbStream ?? bootstrap?.stream
  const isThread = stream?.type === StreamTypes.THREAD
  const isArchived = stream?.archivedAt != null
  const isSystem = stream?.type === StreamTypes.SYSTEM

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
  const closeConversationOverlay = useCallback(() => {
    setSearchParams(
      (prev) => {
        prev.delete("convOverlay")
        return prev
      },
      { replace: true }
    )
  }, [setSearchParams])
  // Batch-selection mode suspends the whole overlay (legend, rails, chips,
  // correction swatch) — batch turns every row into a selection toggle, and
  // the overlay's swatch would compete for the same clicks. The URL param is
  // kept, so the overlay returns when batch mode ends.
  const activeConversationOverlay = batchMode ? undefined : conversationOverlay
  const parentStreamId = stream?.parentStreamId
  const parentMessageId = stream?.parentMessageId
  const parentCachedEvents = useStreamEvents(parentStreamId ?? undefined)
  const cachedParentMessage = useMemo(() => {
    if (!isThread || !parentStreamId || !parentMessageId || !parentCachedEvents) return null
    return parentCachedEvents.find(
      (event) =>
        event.eventType === "message_created" &&
        (event.payload as { messageId?: string })?.messageId === parentMessageId
    )
  }, [isThread, parentStreamId, parentMessageId, parentCachedEvents])

  // Fetch parent stream bootstrap (for threads to get parent message)
  // Only fetch when we have a valid parentStreamId
  const { data: parentBootstrap } = useStreamBootstrap(workspaceId, parentStreamId!, {
    enabled: !isDraft && isThread && !!parentStreamId && !!parentMessageId && !cachedParentMessage,
  })

  // Find parent message from parent stream's events
  const parentMessage = useMemo(() => {
    if (!isThread || !parentStreamId || !parentMessageId) return null
    if (cachedParentMessage) return cachedParentMessage as unknown as StreamEvent
    if (!parentBootstrap?.events) return null

    return parentBootstrap.events.find(
      (e) => e.eventType === "message_created" && (e.payload as { messageId?: string })?.messageId === parentMessageId
    )
  }, [cachedParentMessage, isThread, parentStreamId, parentMessageId, parentBootstrap?.events])

  // Subscribe to stream room FIRST (subscribe-then-bootstrap pattern)
  useStreamSocket(workspaceId, streamId, { enabled: !isDraft })

  const {
    events,
    holes,
    isLoading,
    isConfirmedEmpty,
    error,
    pagedSharedMessages,
    fetchOlderEvents,
    hasOlderEvents,
    isFetchingOlder,
    fetchNewerEvents,
    hasNewerEvents,
    isFetchingNewer,
    jumpToEvent,
    jumpToEventByDate,
    exitJumpMode,
    isJumpMode,
  } = useEvents(workspaceId, streamId, { enabled: !isDraft, loadAll: isThread })

  // Merge bootstrap + paginated `sharedMessages` so pointers in pages older
  // than the bootstrap window (or in jump-mode windows) hydrate without
  // waiting for a full bootstrap refetch. Bootstrap entries take precedence
  // when both maps carry the same source-message id since bootstrap reflects
  // the latest backend response while paged data may be older.
  //
  // For threads, also fold in the parent stream's `sharedMessages` so any
  // pointer embedded in the parent message hydrates with full data
  // (including attachments) rather than falling through to the IDB-cache
  // fallback. The parent bootstrap is fetched above for the parent message
  // anyway; the hydration map rides along on the same response.
  const mergedSharedMessages = useMemo(
    () => ({
      ...pagedSharedMessages,
      ...(parentBootstrap?.sharedMessages ?? {}),
      ...(bootstrap?.sharedMessages ?? {}),
    }),
    [pagedSharedMessages, parentBootstrap?.sharedMessages, bootstrap?.sharedMessages]
  )

  // For drafts, query pending/failed events directly from IDB so optimistic
  // messages are visible while offline or waiting for queue processing.
  const draftPendingEvents = useStreamEvents(isDraft ? streamId : undefined)
  const hasDraftPendingEvents = isDraft && draftPendingEvents && draftPendingEvents.length > 0

  const editLastMessageCtx = useEditLastMessageTrigger(events, currentWorkspaceUserId)

  // Track live agent session progress for all stream types (step/message counts on session cards).
  // In channels, session cards are hidden (responses go to threads) and inline activity shows on trigger messages instead.
  const isChannel = stream?.type === StreamTypes.CHANNEL
  const agentActivity = useAgentActivity(events, socket, workspaceId, currentWorkspaceUserId)

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

  // Escape closes search when focus is outside the search input.
  useEffect(() => {
    if (!isSearchOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isInput = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable

      if (event.key === "Escape" && !isInput) {
        setIsSearchOpen(false)
        clearSearch()
      }
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [isSearchOpen, clearSearch])

  const handleSearchClose = useCallback(() => {
    setIsSearchOpen(false)
    clearSearch()
  }, [clearSearch])

  // Compute timeline items in StreamContent so the virtualizer can use count + keys.
  // After grouping commands/sessions, annotate consecutive same-author message runs
  // with `groupContinuation` so MessageEvent can collapse the repeated header row.
  // Membership events are suppressed in threads: thread participation is implicit
  // (replying joins you, the parent author is auto-added), so "X was added to the
  // conversation" reads as noise next to the author who clearly is here.
  const displayEvents = useMemo(() => {
    if (!isThread) return events
    return [...events]
      .filter((e) => !THREAD_HIDDEN_EVENT_TYPES.has(e.eventType))
      .sort((a, b) => {
        const timeDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        if (timeDelta !== 0) return timeDelta
        return a.id.localeCompare(b.id)
      })
  }, [events, isThread])

  // Gap placeholders are injected AFTER grouping/annotation so a hole in the
  // broadcast chain (INV-61) renders as its own in-place loading row — see
  // useEvents' contiguity gate for how holes are detected and backfilled.
  const conversationOverlayModel = conversationOverlay?.model
  const timelineItems = useMemo(() => {
    let items = annotateAuthorGroups(groupTimelineItems(displayEvents, currentWorkspaceUserId ?? undefined))
    if (conversationOverlayModel && conversationOverlayModel.conversations.length > 0) {
      items = annotateConversationRows(items, conversationOverlayModel)
    }
    return injectGapItems(items, holes)
  }, [displayEvents, currentWorkspaceUserId, holes, conversationOverlayModel])

  // `order` is the position in the rendered timeline. Non-thread streams
  // happen to sort by sequence already, but threads re-sort by
  // (createdAt, id) — once moved messages land in a thread, their sequence
  // (assigned in the destination's event log) can diverge from their visual
  // position. Validating "target precedes selection" against `order` keeps
  // batch UI consistent with what the user sees.
  const messageEventMeta = useMemo(() => {
    const meta = new Map<string, { order: number; content: string }>()
    let order = 0
    for (const event of displayEvents) {
      if (event.eventType !== "message_created") continue
      const payload = event.payload as { messageId?: string; contentMarkdown?: string; deletedAt?: string }
      if (!payload.messageId || payload.deletedAt) continue
      meta.set(payload.messageId, { order: order++, content: payload.contentMarkdown ?? "" })
    }
    return meta
  }, [displayEvents])

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
    (preselectedMessageId?: string) => {
      setBatchMode(true)
      setSelectedMessageIds(preselectedMessageId ? new Set([preselectedMessageId]) : new Set())
      setHoveredBatchTargetId(null)
      setDragGhost(null)
      // Selection and search share the same flush-top strip; keep one open at a
      // time so they can't stack. Search bar's own listeners handle the reverse.
      setIsSearchOpen(false)
      clearSearch()
    },
    [clearSearch]
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
      startBatchSelect(detail.preselectedMessageId)
    })
  }, [startBatchSelect, streamId])

  useEffect(() => {
    cancelBatchMode()
    suppressNextBatchClickRef.current = false
  }, [streamId, cancelBatchMode])

  const batchState = useMemo<BatchTimelineState | undefined>(
    () => ({
      enabled: batchMode,
      selectedMessageIds,
      invalidTargetIds: invalidBatchTargetIds,
      hoveredTargetId: hoveredBatchTargetId,
      onToggleMessage: toggleBatchMessage,
    }),
    [batchMode, selectedMessageIds, invalidBatchTargetIds, hoveredBatchTargetId, toggleBatchMessage]
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

  const batchPointerHandlers = batchMode
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
  const visibleItems = useMemo(() => {
    const filtered = useVirtualized ? filterVisibleItems(timelineItems, isChannel) : timelineItems
    // Day dividers go on the post-filter list so a boundary lands above the
    // first *visible* row of a day (INV-42), then skeletons prepend above all.
    const base = injectDayDividers(filtered)
    return showOlderSkeletons ? [...OLDER_SKELETON_ITEMS, ...base] : base
  }, [timelineItems, useVirtualized, isChannel, showOlderSkeletons])

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

  const {
    listRef,
    scrollerRef: virtualScrollerRef,
    registerScroller: registerVirtualScroller,
    contentRef: virtualContentRef,
    shift,
    isScrolledFarFromBottom: virtualIsScrolledFar,
    isInitialSettling: virtualIsInitialSettling,
    scrollToBottom: virtualScrollToBottom,
    disableAutoScroll: virtualDisableAutoScroll,
    isFollowingTailRef,
    handleScroll: handleVirtualScroll,
    resetShiftBaseline,
  } = useTimelineScroll({
    itemCount: useVirtualized ? visibleItems.length : 0,
    getFirstKey: () => (useVirtualized && visibleItems.length > 0 ? getTimelineItemKey(visibleItems[0]) : null),
    resetKey: streamId,
    skipInitialScroll,
    isJumpMode,
    userInteractedAtRef,
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
  const handleComposerHeightChange = useCallback(
    (_px: number, opts: { initial: boolean }) => {
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
        // scrolled up to read history isn't yanked back to the tail.
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

  // Scroll to a specific message and keep re-scrolling until the target
  // element is actually visible in the scroller viewport. Items rendered
  // with estimated heights cause the target to drift after the first scroll
  // as surrounding items are measured; this loop keeps correcting until
  // stable (or a short timeout). User input (wheel / touch / key) aborts
  // the loop immediately so manual scrolling always wins.
  //
  // Implementation notes: Virtuoso's scrollToIndex expects the 0-based
  // index within the current data array (NOT firstItemIndex + idx). Once
  // the item is rendered in the DOM we use native scrollTo on the scroller
  // to position it precisely — this sidesteps Virtuoso's internal offset
  // estimation which tends to overshoot with unmeasured items.
  const scrollRetryTimerRef = useRef<number | null>(null)
  const scrollAbortRef = useRef<(() => void) | null>(null)
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
    (messageId: string) => {
      if (!useVirtualized) {
        deepLinkDebug("scrollToMessage bail: not virtualized", messageId)
        return false
      }
      if (findMessageItemIndex(visibleItems, messageId) < 0) {
        deepLinkDebug("scrollToMessage bail: target not a timeline item yet", messageId)
        return false
      }
      // The user already took manual control for this scroll intent (e.g.
      // started scrolling while jumpToEvent was loading the window). Don't
      // start a retry loop that would fight them back to the target — the
      // mount anchor already placed it close enough.
      if (userInteractedAtRef.current > 0) {
        deepLinkDebug("scrollToMessage bail: user already interacting", messageId)
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

      const scroller = virtuosoScrollerRef.current
      if (!scroller) {
        deepLinkDebug("scrollToMessage bail: scroller not attached yet", messageId)
        return false
      }

      // Abort the retry loop the moment the user takes over
      let aborted = false
      const abort = () => {
        aborted = true
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
      const MAX_MS = 1200
      let stableFrames = 0

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

        const el = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)

        if (el) {
          // Target is rendered — scroll via DOM so we get pixel-precise positioning
          const sr = scroller.getBoundingClientRect()
          const er = el.getBoundingClientRect()
          const elCenter = (er.top + er.bottom) / 2
          const scCenter = (sr.top + sr.bottom) / 2
          const delta = elCenter - scCenter
          if (Math.abs(delta) > 2) {
            scroller.scrollTop += delta
          }

          // Re-measure after the scroll
          const er2 = el.getBoundingClientRect()
          const fullyVisible = er2.top >= sr.top - 1 && er2.bottom <= sr.bottom + 1
          const hasScrollRoom = scroller.scrollHeight > scroller.clientHeight + 8
          const centered = !hasScrollRoom || Math.abs((er2.top + er2.bottom) / 2 - scCenter) < 40
          if (fullyVisible && centered) {
            stableFrames += 1
            if (stableFrames >= 2) {
              abort()
              return
            }
          } else {
            stableFrames = 0
          }
        } else {
          // Target is virtualized out — ask Virtuoso to render it (0-based
          // index). Re-resolve against the live timeline every tick: the
          // window can shift under this loop, and a stale/out-of-range index
          // makes react-virtuoso's offset-tree binary search dereference an
          // undefined node, throwing "Cannot read properties of undefined
          // (reading 'index')" which crashes the whole route.
          const liveIdx = findMessageItemIndex(visibleItemsRef.current, messageId)
          // liveIdx < 0 means the target is transiently out of the window
          // (e.g. a jump-window swap mid-flight). Skip this tick rather than
          // scroll to a wrong index; a later tick retries once it reappears,
          // and MAX_MS still bounds the loop if it never does.
          if (liveIdx >= 0) {
            try {
              listRef.current?.scrollToIndex(liveIdx, { align: "center" })
            } catch {
              // virtua can still throw internally on a freshly mounted,
              // not-yet-measured list. Non-fatal: the next tick retries once
              // sizes are populated, or the DOM path takes over once the row
              // renders.
            }
          }
          stableFrames = 0
        }

        const elapsed = performance.now() - started
        if (elapsed < MAX_MS) {
          scrollRetryTimerRef.current = window.setTimeout(attempt, 60)
        } else {
          abort()
        }
      }
      deepLinkDebug("scrollToMessage: refine loop engaged", messageId)
      attempt()
      return true
    },
    [useVirtualized, visibleItems, listRef, disableAutoScroll]
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
      const isInCurrentEvents = events.some((e) => {
        const payload = e.payload as { messageId?: string }
        return payload?.messageId === messageId
      })

      if (isInCurrentEvents) {
        // Message is loaded — scroll to it (handles both in-DOM and virtualized-out items)
        scrollToMessage(messageId)
        return
      }

      // Message not in current window — load events around it, then scroll after load
      disableAutoScroll()
      pendingScrollTarget.current = messageId
      jumpToEvent(messageId)
    },
    [events, jumpToEvent, disableAutoScroll, scrollToMessage]
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
        pendingScrollTarget.current = null
        scrollToMessage(inWindowMessageId)
        return
      }
      resetShiftBaseline()
      const anchorId = await jumpToEventByDate(new Date(targetDayMs).toISOString())
      if (anchorId) {
        pendingScrollTarget.current = anchorId
        setPendingScrollRequestVersion((version) => version + 1)
      } else {
        pendingScrollTarget.current = null
        toast.info("No messages on or after that date")
      }
    },
    [events, hasOlderEvents, disableAutoScroll, scrollToMessage, jumpToEventByDate, resetShiftBaseline]
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

    if (!useVirtualized) {
      // Threads use plain scroll, not this jump-then-virtualized-scroll path.
      pendingScrollTarget.current = null
      return
    }

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
        return
      }
      if (phase === "deadline") {
        deepLinkDebug("post-jump: deadline exceeded, giving up", target)
        pendingScrollTarget.current = null
        // The jump window loaded but the target never became placeable (e.g. a
        // mid-flight window swap). Mark the deep-link as conclusively failed so
        // the holdForDeepLink skeleton releases and the gated ?m= clear can
        // fire — without this the skeleton/param would hang now that the clear
        // no longer runs on a blind mount timer.
        setDeepLinkGaveUp(true)
        return
      }

      const inEvents = events.some((e) => (e.payload as { messageId?: string })?.messageId === target)
      if (inEvents && scrollToMessage(target)) {
        // scrollToMessage engaged its own resilient loop — it owns landing
        // + user-abort from here, so this driver is done.
        deepLinkDebug("post-jump: scrollToMessage engaged", target)
        pendingScrollTarget.current = null
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
  }, [events, isLoading, scrollToMessage, useVirtualized, setDeepLinkGaveUp, pendingScrollRequestVersion])

  // Jump to highlighted message if it's not in the current event window.
  // The guard uses location.key so repeat clicks on the same message link
  // (which produce identical URLs and would otherwise not change any state)
  // still re-trigger — react-router stamps each navigation with a fresh key.
  useEffect(() => {
    if (!highlightMessageId || isLoading || isDraft) return
    if (jumpTriggeredKeyRef.current === location.key) return
    const navigationKey = location.key
    jumpTriggeredKeyRef.current = navigationKey
    // Fresh navigation: re-arm the mount hold for this target and clear any
    // prior manual-control stamp so the refine loop is allowed to run.
    setDeepLinkGaveUp(false)
    userInteractedAtRef.current = 0

    // Disable auto-scroll so highlight scroll-into-view isn't overridden
    disableAutoScroll()

    // Check if the message is already visible in current events
    const isVisible = events.some((e) => {
      const payload = e.payload as { messageId?: string }
      return payload?.messageId === highlightMessageId
    })

    if (isVisible) {
      deepLinkDebug("highlight: target already in window, scrolling directly", highlightMessageId)
      scrollToMessage(highlightMessageId)
      return
    }

    if (events.length > 0) {
      deepLinkDebug("highlight: target out of window, jumping", highlightMessageId)
      pendingScrollTarget.current = highlightMessageId
      jumpToEvent(highlightMessageId)
        .then((success) => {
          // A newer navigation may have superseded this request while it was
          // in flight; its stale completion must not clear the new target or
          // release the new mount hold.
          if (jumpTriggeredKeyRef.current !== navigationKey) return
          deepLinkDebug("highlight: jumpToEvent resolved", highlightMessageId, "success=", success)
          if (!success) {
            pendingScrollTarget.current = null
            setDeepLinkGaveUp(true)
          }
        })
        .catch(() => {
          if (jumpTriggeredKeyRef.current !== navigationKey) return
          deepLinkDebug("highlight: jumpToEvent rejected", highlightMessageId)
          pendingScrollTarget.current = null
          setDeepLinkGaveUp(true)
        })
    }
  }, [highlightMessageId, location.key, isLoading, isDraft, events, jumpToEvent, disableAutoScroll, scrollToMessage])

  // Reset jump and search state when switching streams (component stays mounted).
  // Also abort any in-flight scrollToMessage retry loop so its stale closure
  // (holding an index from the previous stream) doesn't scroll the new stream
  // to the wrong position.
  useEffect(() => {
    jumpTriggeredKeyRef.current = null
    scrollAbortRef.current?.()
    if (pendingScrollRafRef.current) {
      cancelAnimationFrame(pendingScrollRafRef.current)
      pendingScrollRafRef.current = 0
    }
    pendingScrollTarget.current = null
    setDeepLinkGaveUp(false)
    userInteractedAtRef.current = 0
    exitJumpMode()
    setIsSearchOpen(false)
    clearSearch()
  }, [streamId, exitJumpMode, clearSearch])

  // Auto-mark stream as read when viewing. The stream opens at the live bottom;
  // read state advances only through the contiguous run the viewer scrolls
  // through from where they left off (see useLastSeenEvent), so the unread above
  // the fold stays unread until they go up to it (or press Escape). A not-at-tail
  // mark is partial — the badge keeps the remaining unread (markAsRead partial).
  const autoMarkEnabled = !isDraft && !isLoading && !isJumpMode
  const { lastSeenEventId, atLastRow, unreadAboveViewport } = useLastSeenEvent({
    scrollContainerRef,
    // Observe the scrolling content box (its height tracks scrollHeight) so a
    // settle / embed / image resize re-scans even when the stream is too short
    // to scroll. Both paths pass one — the virtualized list's inner content div
    // and the plain (thread) scroller's content wrapper. Observing the scroller
    // itself wouldn't catch it: a fixed h-full box doesn't change as content grows.
    contentRef: useVirtualized ? virtualContentRef : plainContentRef,
    events: displayEvents,
    streamId,
    lastReadEventId,
    enabled: autoMarkEnabled,
  })
  useAutoMarkAsRead(workspaceId, streamId, lastSeenEventId, { enabled: autoMarkEnabled, partial: !atLastRow })

  const isMobile = useIsMobile()
  const { markAsRead, markUnread, getUnreadCount } = useUnreadCounts(workspaceId)
  const unreadCount = getUnreadCount(streamId)

  // Track live-arriving messages from other users for brief "new" indicator.
  const newMessageIds = useNewMessageIndicator(events, currentWorkspaceUserId ?? undefined, streamId, lastReadEventId)

  // Unread divider state — a bookmark line at the first unread message. The
  // stream opens at the bottom (no auto-scroll to unread); the viewer reaches
  // the divider via the "N new" jump button or by scrolling up.
  const { dividerEventId, dismiss: dismissUnreadDivider } = useUnreadDivider({
    events: displayEvents,
    lastReadEventId,
    currentUserId: currentWorkspaceUserId ?? undefined,
    streamId,
    isLoading,
    highlightMessageId,
    // Never auto-scroll to the unread line — opening lands at the live bottom.
    scrollToUnread: false,
    // `lastReadEventId` is `string | null` once resolved; it is only `undefined`
    // while the read sources (stream row / membership) are still hydrating. Gate
    // on that so a not-yet-known read position can't be read as "all unread" and
    // latch a divider on the first message (which would then stick for the
    // session). `idbStream` alone isn't enough — its denormalized copy can be a
    // stale null while the authoritative membership value is still loading.
    readStateResolved: lastReadEventId !== undefined,
  })

  // The divider is red while unread still sits at/after it, and turns muted-gray
  // once the read pointer has passed it (read through, or "Mark as read") — a
  // pure read-state signal, not a time-based fade.
  const isDividerDimmed = useMemo(
    () => isDividerReadPast(events, dividerEventId, lastReadEventId),
    [events, dividerEventId, lastReadEventId]
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

  // "Escape the unread block": mark the stream fully read, dismiss the
  // persistent unread divider, and resume tailing the live bottom. Shared by
  // the desktop Escape shortcut and the touchable ✕ on the divider / jump bar
  // (the ✕ is the only path on mobile, where the keyboard shortcut is absent).
  const escapeUnread = useCallback(() => {
    const lastLoadedEventId = lastLoadedEventIdRef.current
    if (lastLoadedEventId) markAsReadRef.current(streamId, lastLoadedEventId)
    dismissUnreadDivider()
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
      markUnreadRef.current(streamId, detail.messageId)
    })
  }, [streamId])

  const queryClient = useQueryClient()
  const isPublicChannel = stream?.type === StreamTypes.CHANNEL && stream?.visibility === Visibilities.PUBLIC
  const isMember = !!membership
  const membershipResolved = currentWorkspaceUserId !== null || bootstrap !== undefined
  let disabledReason: string | undefined
  if (isSystem) {
    disabledReason = "System notifications are read-only."
  } else if (isArchived) {
    disabledReason = "This thread has been sealed in the labyrinth. It can be read but not extended."
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
  }, [isJumpMode, exitJumpMode, resetShiftBaseline, scrollToBottom])

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
        listRef.current?.scrollToIndex(idx, { align: "start", offset: -56 })
      } catch {
        // A not-yet-measured virtua list can throw; the row is already rendered
        // by the time this button is clickable, so this is best-effort.
      }
    } else {
      scrollContainerRef.current
        ?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(dividerEventId)}"]`)
        ?.scrollIntoView({ block: "start" })
    }
  }, [dividerEventId, useVirtualized, visibleItems, listRef, disableAutoScroll, scrollContainerRef])

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
  // and releases when the target loads (deepLinkTargetLoaded) or the jump
  // conclusively fails (deepLinkGaveUp) so it never hangs.
  const deepLinkTargetLoaded = useMemo(
    () =>
      !highlightMessageId ||
      events.some((e) => (e.payload as { messageId?: string })?.messageId === highlightMessageId),
    [events, highlightMessageId]
  )
  const holdForDeepLink =
    !!highlightMessageId &&
    !deepLinkTargetLoaded &&
    !deepLinkGaveUp &&
    !isLoading &&
    !isConfirmedEmpty &&
    events.length > 0

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

  return (
    <ReadFrontierContext.Provider value={readFrontierSequence}>
      <EditLastMessageContext.Provider value={editLastMessageCtxWithScroll}>
        <QuoteReplyProvider>
          <SharedMessagesProvider map={mergedSharedMessages}>
            <TextSelectionQuote streamId={streamId} />
            <div className="relative h-full">
              <div className="absolute inset-0 overflow-hidden">
                {isSearchOpen && (
                  <StreamSearchBar
                    search={streamSearch}
                    onClose={handleSearchClose}
                    onNavigate={handleSearchNavigate}
                  />
                )}
                {batchMode && <BatchSelectionBar count={selectedMessageIds.size} onCancel={cancelBatchMode} />}
                {activeConversationOverlay && (
                  <ConversationOverlayPanel
                    overlay={activeConversationOverlay}
                    inViewConversations={inViewConversations}
                    onClose={closeConversationOverlay}
                    searchBarOpen={isSearchOpen}
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
                      isLoading={isLoading}
                      holdForDeepLink={holdForDeepLink}
                      isConfirmedEmpty={isConfirmedEmpty}
                      listRef={listRef}
                      scrollerRef={virtualScrollerRef}
                      registerScroller={registerVirtualScroller}
                      contentRef={virtualContentRef}
                      scrollAbortRef={scrollAbortRef}
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
                        // Sit above the Jump to latest button (when visible) which itself sits above the floating composer.
                        bottom:
                          isJumpMode || isScrolledFarFromBottom
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
                      {isThread && parentMessage && parentStreamId && (
                        <ThreadParentMessage
                          event={parentMessage}
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
              Positioned above the floating composer pill. */}
              {(isJumpMode || isScrolledFarFromBottom) && (
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
              {unreadAboveViewport && unreadCount > 0 && !batchMode && !isSearchOpen && (
                <div
                  // Sits clearly below the floating date pill (top-2, ~30px tall)
                  // so the top-center affordances never overlap.
                  className="pointer-events-none absolute left-1/2 -translate-x-1/2 z-10 flex items-center gap-1"
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
                    className="pointer-events-auto h-8 w-8 shadow-lg"
                    onClick={escapeUnread}
                    aria-label="Mark all read"
                  >
                    <X className="h-3.5 w-3.5" />
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
                  onComposerHeightChange={useVirtualized ? handleComposerHeightChange : undefined}
                />
              )}
            </div>
          </SharedMessagesProvider>
        </QuoteReplyProvider>
      </EditLastMessageContext.Provider>
    </ReadFrontierContext.Provider>
  )
}

/** Virtuoso-powered message list for streams, channels, and scratchpads */
function TimelineMessageList({
  visibleItems,
  isLoading,
  holdForDeepLink,
  isConfirmedEmpty,
  listRef,
  scrollerRef,
  registerScroller,
  contentRef,
  scrollAbortRef,
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
}: {
  visibleItems: TimelineItem[]
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
}) {
  const { phase } = useCoordinatedLoading()
  const socket = useSocket()
  const abortResearch = useAbortResearch(socket)

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

  const { sessionLiveCounts, sessionLiveSubsteps, sessionCanAbort } = useMemo(() => {
    const counts = new Map<string, { stepCount: number; messageCount: number }>()
    const substeps = new Map<string, string | null>()
    const canAbort = new Map<string, boolean>()
    if (agentActivity) {
      for (const activity of agentActivity.values()) {
        counts.set(activity.sessionId, {
          stepCount: activity.stepCount,
          messageCount: activity.messageCount,
        })
        substeps.set(activity.sessionId, activity.substep)
        canAbort.set(activity.sessionId, isAbortableStepType(activity.currentStepType))
      }
    }
    return { sessionLiveCounts: counts, sessionLiveSubsteps: substeps, sessionCanAbort: canAbort }
  }, [agentActivity])

  const handleAbortResearch = useCallback(
    (sessionId: string) => abortResearch({ sessionId, workspaceId }),
    [abortResearch, workspaceId]
  )

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
      sessionCanAbort,
      onAbortResearch: handleAbortResearch,
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
      sessionCanAbort,
      handleAbortResearch,
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
    if (scrollAbortRef.current !== null) return
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
  }, [onTimelineScroll, updateDatePill, scrollAbortRef, scrollerRef, handleStartReached, handleEndReached])

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
        visible={datePillVisible}
        onJumpToDate={onJumpToDate}
        scrollerRef={scrollerRef}
      />
      {isInitialSettling && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-10 bg-background">
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
