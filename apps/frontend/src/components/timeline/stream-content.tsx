import { useMemo, useEffect, useCallback, useRef, useState } from "react"
import { useLocation, useSearchParams } from "react-router-dom"
import { Virtuoso } from "react-virtuoso"
import { MessageSquare, ArrowDown, X, Move, Loader2, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import {
  useEvents,
  useStreamSocket,
  useVirtuosoScroll,
  useScrollBehavior,
  useStreamBootstrap,
  useWorkspaceUserId,
  useAutoMarkAsRead,
  useUnreadDivider,
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
  AgentStepTypes,
  type Stream,
  type StreamEvent,
  type StreamMember,
  type WorkspaceBootstrap,
  type StreamBootstrap,
} from "@threa/types"
import {
  EventList,
  TimelineItemContent,
  groupTimelineItems,
  annotateAuthorGroups,
  findFirstMessageId,
  findMessageItemIndex,
  getTimelineItemKey,
  filterVisibleItems,
  type TimelineItem,
  type TimelineItemRenderContext,
  type BatchTimelineState,
} from "./event-list"
import { MessageInput } from "./message-input"
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
import { addStartBatchSelectListener } from "@/lib/batch-selection-events"

/** Membership events; suppressed in threads (see displayEvents memo). */
const THREAD_HIDDEN_EVENT_TYPES = new Set<StreamEvent["eventType"]>(["member_joined", "member_added", "member_left"])

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
  const [, setSearchParams] = useSearchParams()
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

  // Clear highlight param after delay (works for both main view and panels)
  useEffect(() => {
    if (highlightMessageId) {
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
    }
  }, [highlightMessageId, setSearchParams])

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
  const agentActivity = useAgentActivity(events, socket)

  // --- In-stream search ---
  const streamSearch = useStreamSearch({ workspaceId, streamId })
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

  const timelineItems = useMemo(
    () => annotateAuthorGroups(groupTimelineItems(displayEvents, user?.id)),
    [displayEvents, user?.id]
  )

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
      toast.success(`Moved ${messageIds.length} message${messageIds.length === 1 ? "" : "s"} to thread`)
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

  // Filter out zero-height items (reactions, hidden session cards) for the virtualizer.
  // Without this, items that render as empty wrappers get measured as 0px, causing
  // subsequent items to overlap at the same Y position.
  const visibleItems = useMemo(
    () => (useVirtualized ? filterVisibleItems(timelineItems, isChannel) : timelineItems),
    [timelineItems, useVirtualized, isChannel]
  )

  // Mirror of `visibleItems` for the long-lived scrollToMessage retry loop:
  // its closure is created once per scroll but runs for up to ~1.2s, during
  // which the event window can shift. Reading the ref keeps each retry tick
  // resolving the target index against the array Virtuoso currently holds.
  const visibleItemsRef = useRef(visibleItems)
  visibleItemsRef.current = visibleItems

  const getItemKey = useCallback(
    (index: number) => {
      const item = visibleItems[index]
      return item ? getTimelineItemKey(item) : String(index)
    },
    [visibleItems]
  )

  // --- Virtuoso scroll (main streams, channels, scratchpads) ---
  const {
    virtuosoRef,
    firstItemIndex,
    initialTopMostItemIndex,
    isScrolledFarFromBottom: virtualIsScrolledFar,
    shouldFollowOutput,
    scrollToBottom: virtualScrollToBottom,
    disableAutoScroll: virtualDisableAutoScroll,
    handleAtBottomChange,
    handleRangeChanged,
    handleScrollerRef,
    resetPrependState,
  } = useVirtuosoScroll({
    itemCount: useVirtualized ? visibleItems.length : 0,
    getItemKey: useVirtualized ? getItemKey : () => "0",
    resetKey: streamId,
    skipInitialScroll: !!highlightMessageId,
  })

  // Virtuoso ref for scroll container access (search highlight, etc.)
  const virtuosoScrollerRef = useRef<HTMLDivElement | null>(null)

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
  })

  // Unified API regardless of scroll mode
  const scrollContainerRef = useVirtualized ? virtuosoScrollerRef : plainScrollRef
  const isScrolledFarFromBottom = useVirtualized ? virtualIsScrolledFar : plainIsScrolledFar
  const scrollToBottom = useVirtualized ? virtualScrollToBottom : plainScrollToBottom
  const disableAutoScroll = useVirtualized ? virtualDisableAutoScroll : plainDisableAutoScroll

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
  const scrollToMessage = useCallback(
    (messageId: string) => {
      if (!useVirtualized) return false
      if (findMessageItemIndex(visibleItems, messageId) < 0) return false

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
      if (!scroller) return false

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
              virtuosoRef.current?.scrollToIndex({ index: liveIdx, align: "center", behavior: "auto" })
            } catch {
              // react-virtuoso can still throw internally on a freshly
              // mounted, not-yet-measured list (no defaultItemHeight).
              // Non-fatal: the next tick retries once the size tree is
              // populated, or the DOM path takes over once the row renders.
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
      attempt()
      return true
    },
    [useVirtualized, visibleItems, virtuosoRef, disableAutoScroll]
  )

  useEffect(() => {
    return () => {
      scrollAbortRef.current?.()
    }
  }, [])

  // After jumpToEvent loads events around a target, scroll to it once the
  // events array updates and the target is present.
  const pendingScrollTarget = useRef<string | null>(null)

  // When a search result is selected, navigate to that message.
  // If the message is already in the loaded events, just scroll to it in the DOM —
  // don't call jumpToEvent which loads a new event window and disrupts scroll position.
  // Only use jumpToEvent for messages outside the current window (older history).
  const handleSearchNavigate = useCallback(
    (messageId: string) => {
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

  // Highlight search matches in the DOM via CSS Custom Highlight API
  useSearchHighlight(
    scrollContainerRef,
    isSearchOpen ? streamSearch.query : "",
    streamSearch.activeMessageId,
    streamSearch.activeOccurrence
  )
  useEffect(() => {
    if (!pendingScrollTarget.current || isLoading) return
    const target = pendingScrollTarget.current
    const found = events.some((e) => {
      const payload = e.payload as { messageId?: string }
      return payload?.messageId === target
    })
    if (found) {
      // Allow one frame for Virtuoso to process the new data before scrolling
      requestAnimationFrame(() => scrollToMessage(target))
      pendingScrollTarget.current = null
    }
  }, [events, isLoading, scrollToMessage])

  // Jump to highlighted message if it's not in the current event window.
  // The guard uses location.key so repeat clicks on the same message link
  // (which produce identical URLs and would otherwise not change any state)
  // still re-trigger — react-router stamps each navigation with a fresh key.
  useEffect(() => {
    if (!highlightMessageId || isLoading || isDraft) return
    if (jumpTriggeredKeyRef.current === location.key) return
    const navigationKey = location.key
    jumpTriggeredKeyRef.current = navigationKey
    // Fresh navigation: re-arm the mount hold for this target.
    setDeepLinkGaveUp(false)

    // Disable auto-scroll so highlight scroll-into-view isn't overridden
    disableAutoScroll()

    // Check if the message is already visible in current events
    const isVisible = events.some((e) => {
      const payload = e.payload as { messageId?: string }
      return payload?.messageId === highlightMessageId
    })

    if (isVisible) {
      scrollToMessage(highlightMessageId)
      return
    }

    if (events.length > 0) {
      pendingScrollTarget.current = highlightMessageId
      jumpToEvent(highlightMessageId)
        .then((success) => {
          // A newer navigation may have superseded this request while it was
          // in flight; its stale completion must not clear the new target or
          // release the new mount hold.
          if (jumpTriggeredKeyRef.current !== navigationKey) return
          if (!success) {
            pendingScrollTarget.current = null
            setDeepLinkGaveUp(true)
          }
        })
        .catch(() => {
          if (jumpTriggeredKeyRef.current !== navigationKey) return
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
    pendingScrollTarget.current = null
    setDeepLinkGaveUp(false)
    exitJumpMode()
    setIsSearchOpen(false)
    clearSearch()
  }, [streamId, exitJumpMode, clearSearch])

  // Auto-mark stream as read when viewing
  const lastEventId = events.length > 0 ? events[events.length - 1].id : undefined
  useAutoMarkAsRead(workspaceId, streamId, lastEventId, { enabled: !isDraft && !isLoading && !isJumpMode })

  // Track live-arriving messages from other users for brief "new" indicator.
  const newMessageIds = useNewMessageIndicator(events, currentWorkspaceUserId ?? undefined, streamId, lastReadEventId)

  // Unread divider state management (also handles scroll-to-first-unread).
  // Pass `displayEvents` so the divider's first-unread search skips events we
  // hide from this stream's render (e.g. thread membership rows) — otherwise
  // the divider can target an event id that never matches a rendered row and
  // silently fails to show.
  const { dividerEventId, isFading: isDividerFading } = useUnreadDivider({
    events: displayEvents,
    lastReadEventId,
    currentUserId: currentWorkspaceUserId ?? undefined,
    streamId,
    isLoading,
    highlightMessageId,
  })

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
      resetPrependState()
      requestAnimationFrame(() => {
        scrollToBottom({ force: true })
      })
    } else {
      scrollToBottom({ force: true, behavior: "smooth" })
    }
  }, [isJumpMode, exitJumpMode, resetPrependState, scrollToBottom])

  if (error && !isDraft && events.length === 0 && !idbStream) {
    return (
      <ErrorView
        className="h-full border-0"
        title="Failed to Load Messages"
        description="We couldn't load the messages for this stream. Please refresh the page or try again later."
      />
    )
  }

  const editLastMessageCtxWithScroll = useMemo(
    () => ({ ...editLastMessageCtx, scrollToMessage }),
    [editLastMessageCtx, scrollToMessage]
  )

  // Deep-link (?m=) mount hold. On a push-notification / Activities deep link
  // the latest window loads first; the jump effect then fetches the window
  // around the target and swaps `events` wholesale. react-virtuoso only
  // honors initialTopMostItemIndex at mount, so a Virtuoso instance mounted
  // on the latest window can't re-anchor onto the jump window — scrollToMessage
  // fights the stale anchor and the user lands far from the target ("scrolled
  // to hell"). Holding the skeleton until the target is actually in the loaded
  // window makes the single keyed mount land already-anchored on it. Uses the
  // raw ?m= id (not the search-active id) so in-stream search is unaffected,
  // and releases via deepLinkGaveUp / the 3s ?m= clear so it never hangs.
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

  return (
    <EditLastMessageContext.Provider value={editLastMessageCtxWithScroll}>
      <QuoteReplyProvider>
        <SharedMessagesProvider map={mergedSharedMessages}>
          <TextSelectionQuote streamId={streamId} />
          <div className="relative h-full">
            <div className="absolute inset-0 overflow-hidden">
              {isSearchOpen && (
                <StreamSearchBar search={streamSearch} onClose={handleSearchClose} onNavigate={handleSearchNavigate} />
              )}
              {batchMode && <BatchSelectionBar count={selectedMessageIds.size} onCancel={cancelBatchMode} />}
              {isDraft && (
                <div
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
                  <VirtuosoMessageList
                    visibleItems={visibleItems}
                    isLoading={isLoading}
                    holdForDeepLink={holdForDeepLink}
                    isConfirmedEmpty={isConfirmedEmpty}
                    virtuosoRef={virtuosoRef}
                    virtuosoScrollerRef={virtuosoScrollerRef}
                    handleScrollerRef={handleScrollerRef}
                    firstItemIndex={firstItemIndex}
                    initialTopMostItemIndex={initialTopMostItemIndex}
                    shouldFollowOutput={shouldFollowOutput}
                    handleAtBottomChange={handleAtBottomChange}
                    handleRangeChanged={handleRangeChanged}
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
                    isDividerFading={isDividerFading}
                    agentActivity={agentActivity}
                    hideSessionCards={isChannel}
                    newMessageIds={newMessageIds}
                    isSearchOpen={isSearchOpen}
                    batch={batchState}
                    batchPointerHandlers={batchPointerHandlers}
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
                    isDividerFading={isDividerFading}
                    agentActivity={agentActivity}
                    hideSessionCards={isChannel}
                    newMessageIds={newMessageIds}
                    batch={batchState}
                  />
                  {isFetchingNewer && (
                    <div className="flex justify-center py-2">
                      <p className="text-sm text-muted-foreground">Loading newer messages...</p>
                    </div>
                  )}
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
              <div className="absolute inset-x-0 z-10" style={{ bottom: "var(--composer-height, 0px)" }}>
                <JoinChannelBar
                  workspaceId={workspaceId}
                  streamId={streamId}
                  channelName={stream?.slug ?? stream?.displayName ?? ""}
                  onJoined={handleJoined}
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
              />
            )}
          </div>
        </SharedMessagesProvider>
      </QuoteReplyProvider>
    </EditLastMessageContext.Provider>
  )
}

/** Virtuoso-powered message list for streams, channels, and scratchpads */
function VirtuosoMessageList({
  visibleItems,
  isLoading,
  holdForDeepLink,
  isConfirmedEmpty,
  virtuosoRef,
  virtuosoScrollerRef,
  handleScrollerRef,
  firstItemIndex,
  initialTopMostItemIndex,
  shouldFollowOutput,
  handleAtBottomChange,
  handleRangeChanged,
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
  isDividerFading,
  agentActivity,
  hideSessionCards,
  newMessageIds,
  isSearchOpen,
  batch,
  batchPointerHandlers,
}: {
  visibleItems: TimelineItem[]
  isLoading: boolean
  /** Hold the skeleton until a deep-link (?m=) target is in the loaded window
   *  so the keyed Virtuoso instance mounts already anchored on it. */
  holdForDeepLink: boolean
  /** True only when we've fully resolved IDB and bootstrap and the stream is
   *  actually empty. During mid-switch transitions this is false, so we avoid
   *  flashing the "No messages yet" state before useLiveQuery catches up. */
  isConfirmedEmpty: boolean
  virtuosoRef: React.RefObject<import("react-virtuoso").VirtuosoHandle | null>
  virtuosoScrollerRef: React.MutableRefObject<HTMLDivElement | null>
  handleScrollerRef: (ref: HTMLElement | Window | null) => void
  firstItemIndex: number
  initialTopMostItemIndex: import("react-virtuoso").IndexLocationWithAlign | number | undefined
  shouldFollowOutput: boolean
  handleAtBottomChange: (atBottom: boolean) => void
  handleRangeChanged: (range: { startIndex: number; endIndex: number }) => void
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
  isDividerFading?: boolean
  agentActivity?: Map<string, import("@/hooks").MessageAgentActivity>
  hideSessionCards?: boolean
  newMessageIds?: Set<string>
  isSearchOpen: boolean
  batch?: BatchTimelineState
  batchPointerHandlers?: React.HTMLAttributes<HTMLElement>
}) {
  const { phase } = useCoordinatedLoading()
  const socket = useSocket()
  const abortResearch = useAbortResearch(socket)

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
        canAbort.set(activity.sessionId, activity.currentStepType === AgentStepTypes.WORKSPACE_SEARCH)
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

  // On a deep-link (?m=) jump the scroll hook returns `initialTopMostItemIndex:
  // undefined` so it can drive the jump imperatively via scrollToMessage. But
  // an absent prop leaves react-virtuoso's internal index stream at its `0`
  // default, so the listState anchors the freshly-remounted (per-stream key)
  // window at index 0 — the *top* of the loaded window — and the scroller
  // lands far above the target, fighting scrollToMessage until it gives up.
  // When the linked message is already in the loaded window, anchor the
  // initial window on it so the cold-boot mount renders centered on the
  // target; scrollToMessage then only has to refine. Falls back to the hook's
  // value when the target isn't loaded yet (the jumpToEvent fetch path).
  const effectiveInitialTopMostItemIndex = useMemo(() => {
    if (highlightMessageId) {
      const idx = findMessageItemIndex(visibleItems, highlightMessageId)
      if (idx >= 0) return { index: idx, align: "center" } as const
    }
    return initialTopMostItemIndex
  }, [highlightMessageId, visibleItems, initialTopMostItemIndex])

  const renderCtx = useMemo<TimelineItemRenderContext>(
    () => ({
      workspaceId,
      streamId,
      highlightMessageId,
      firstUnreadEventId,
      isDividerFading,
      agentActivity,
      hideSessionCards,
      newMessageIds,
      firstMessageId,
      sessionLiveCounts,
      sessionLiveSubsteps,
      sessionCanAbort,
      onAbortResearch: handleAbortResearch,
      phase,
      batch,
    }),
    [
      workspaceId,
      streamId,
      highlightMessageId,
      firstUnreadEventId,
      isDividerFading,
      agentActivity,
      hideSessionCards,
      newMessageIds,
      firstMessageId,
      sessionLiveCounts,
      sessionLiveSubsteps,
      sessionCanAbort,
      handleAbortResearch,
      phase,
      batch,
    ]
  )

  // Memoize followOutput callback ref to avoid Virtuoso re-renders
  const shouldFollowRef = useRef(shouldFollowOutput)
  shouldFollowRef.current = shouldFollowOutput

  const followOutput = useCallback((_isAtBottom: boolean) => {
    if (shouldFollowRef.current) return "auto"
    return false
  }, [])

  // Fetch guards to prevent rapid re-firing
  const olderFetchCooldownRef = useRef(0)
  const newerFetchCooldownRef = useRef(0)
  const FETCH_COOLDOWN_MS = 500

  const handleStartReached = useCallback(() => {
    if (!hasOlderEvents || isFetchingOlder) return
    const now = performance.now()
    if (now < olderFetchCooldownRef.current) return
    const started = fetchOlderEvents()
    if (started !== false) {
      olderFetchCooldownRef.current = now + FETCH_COOLDOWN_MS
    }
  }, [hasOlderEvents, isFetchingOlder, fetchOlderEvents])

  const handleEndReached = useCallback(() => {
    if (!hasNewerEvents || isFetchingNewer) return
    const now = performance.now()
    if (now < newerFetchCooldownRef.current) return
    const started = fetchNewerEvents()
    if (started !== false) {
      newerFetchCooldownRef.current = now + FETCH_COOLDOWN_MS
    }
  }, [hasNewerEvents, isFetchingNewer, fetchNewerEvents])

  const itemContent = useCallback(
    (_index: number, item: TimelineItem) => (
      <div className="mx-auto max-w-[800px]">
        <TimelineItemContent item={item} ctx={renderCtx} />
      </div>
    ),
    [renderCtx]
  )

  // Key items by stable identity so React doesn't reuse component instances
  // across messages and leak per-message state (e.g. link previews).
  const computeItemKey = useCallback((_index: number, item: TimelineItem) => getTimelineItemKey(item), [])

  // Stable scroller ref callback — wrapping in useCallback avoids Virtuoso
  // calling the old callback with null and the new one with the element
  // on every render, which would disconnect/reconnect the ResizeObserver.
  const handleVirtuosoScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      virtuosoScrollerRef.current = ref as HTMLDivElement | null
      handleScrollerRef(ref)
    },
    [virtuosoScrollerRef, handleScrollerRef]
  )

  // Virtuoso's `startReached` / `endReached` observables throttle via
  // `zt(200)` and use `distinctUntilChanged` on the emitted index, which
  // means they can silently miss boundary crossings after a prepend
  // (firstItemIndex decrements, but the distinct tracker may still hold a
  // stale value if the user never scrolled away from the top between
  // prepends). Tracking the range ourselves via `rangeChanged` guarantees
  // the fetch triggers fire whenever the user is actually within a few
  // items of either edge. Gated on `hasSettledRef` so transient ranges
  // during the initial scroll-to-LAST don't kick off an unwanted fetch.
  const hasRangeSettledRef = useRef(false)
  useEffect(() => {
    hasRangeSettledRef.current = false
  }, [streamId])

  const wrappedHandleAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (visibleItems.length > 0) hasRangeSettledRef.current = true
      handleAtBottomChange(atBottom)
    },
    [handleAtBottomChange, visibleItems.length]
  )

  const wrappedHandleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      handleRangeChanged(range)
      if (!hasRangeSettledRef.current || visibleItems.length === 0) return
      const distFromStart = range.startIndex - firstItemIndex
      if (distFromStart <= 3) handleStartReached()
      const lastVirtualIndex = firstItemIndex + visibleItems.length - 1
      const distFromEnd = lastVirtualIndex - range.endIndex
      if (distFromEnd <= 3) handleEndReached()
    },
    [handleRangeChanged, firstItemIndex, visibleItems.length, handleStartReached, handleEndReached]
  )

  // Virtuoso positions items absolutely inside its scroller, so plain CSS
  // `padding-top` on the wrapper is silently ignored — the topmost item still
  // renders flush at scroller-top, where the floating BatchSelectionBar /
  // StreamSearchBar overlap it. The official escape hatch is the `Header`
  // component, which renders before the first item and is treated as
  // scrollable content. We swap it in only while one of the bars is open.
  // Must sit above the early returns below so the hook order stays stable.
  const reservedTopSpacer = isSearchOpen || batch?.enabled
  const components = useMemo(
    () => ({
      // When no bar is open, fall back to StreamHeaderSpacer so the head
      // row's hover toolbar (which floats above the message via
      // `bottom-[calc(100%-20px)]`) doesn't get clipped by the scroller's
      // top edge. Bar-open state uses the taller h-11 spacer.
      Header: reservedTopSpacer ? BarTopSpacer : StreamHeaderSpacer,
      Footer: ComposerFooterSpacer,
    }),
    [reservedTopSpacer]
  )

  if (isLoading || holdForDeepLink) {
    return (
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
  // path in computeTimelineLoadState). Render a blank scroll area rather than
  // mounting <Virtuoso data={[]} />. Virtuoso's hidden-until-stable reveal gate
  // arms only at didMount, and only when initialTopMostItemIndex is set — which
  // it is NOT while itemCount is 0 (the scroll hook returns undefined). A
  // Virtuoso mounted empty therefore reveals immediately, so the populate +
  // scroll-to-LAST a frame later is visible (the "loads in too low then jumps"
  // report). Deferring the mount until data exists makes the keyed instance
  // mount already-populated, exactly like cold boot, so the gate arms.
  if (visibleItems.length === 0) {
    return <div className="h-full" aria-hidden />
  }

  return (
    <Virtuoso
      // Remount per stream so the mount-only reveal gate re-arms. Navigating
      // between streams otherwise reuses this instance (only the streamId prop
      // changes), leaving the gate latched-open from the previous stream. A
      // fresh mount with populated data (guaranteed by the grace-window guard
      // above) re-runs the exact cold-boot path: didMount sees
      // initialTopMostItemIndex=LAST so the gate arms, the window is measured
      // while hidden, and reveal waits until scroll-to-LAST settles.
      key={streamId}
      ref={virtuosoRef}
      scrollerRef={handleVirtuosoScrollerRef}
      className={cn("h-full", batch?.enabled && "select-none")}
      data-suppress-pull-refresh="true"
      firstItemIndex={firstItemIndex}
      // Passing `initialTopMostItemIndex={undefined}` is NOT the same as
      // omitting it: the prop key is still present, so react-virtuoso
      // publishes `undefined` into its internal index stream (overwriting the
      // safe numeric default), and a later reactive listState recompute runs
      // its index normalizer on that `undefined` -> "Cannot read properties
      // of undefined (reading 'index')", which crashes the whole route via
      // the error boundary. The hook returns `undefined` on deep-link jumps;
      // effectiveInitialTopMostItemIndex substitutes the linked message's
      // index when it is loaded. Spread the prop only when it has a value and
      // let react-virtuoso keep its default otherwise.
      {...(effectiveInitialTopMostItemIndex !== undefined
        ? { initialTopMostItemIndex: effectiveInitialTopMostItemIndex }
        : {})}
      data={visibleItems}
      // Intentionally no defaultItemHeight: it makes Virtuoso skip the probe
      // measure and reveal the list using the estimate, so a tall code block
      // measured one frame after reveal triggers a "size increased" re-scroll
      // (the down-then-back jump). Without it, the window is measured while
      // hidden and reveal waits until scroll-to-LAST settles on real sizes.
      skipAnimationFrameInResizeObserver
      itemContent={itemContent}
      computeItemKey={computeItemKey}
      followOutput={followOutput}
      atBottomStateChange={wrappedHandleAtBottomChange}
      rangeChanged={wrappedHandleRangeChanged}
      startReached={handleStartReached}
      endReached={handleEndReached}
      atBottomThreshold={30}
      increaseViewportBy={{ top: 600, bottom: 600 }}
      components={components}
      {...batchPointerHandlers}
    />
  )
}

// Spacer reserving room for the floating composer pill, so the most recent
// message sits visually offset above the pill at rest and `atBottom` accounts
// for the composer's height (Virtuoso treats Footer as content).
const StreamHeaderSpacer = () => <div className="h-3 sm:h-6" aria-hidden />

const ComposerFooterSpacer = () => <div aria-hidden style={{ height: "var(--composer-height, 0px)" }} />

// 44px scrollable spacer used as Virtuoso's Header while the search or
// batch-selection bar is open. Both bars render `absolute top-0` outside the
// scroller; Header reserves matching room *inside* the scroller so the
// topmost item never sits permanently underneath either bar. h-11 keeps the
// numbers aligned with `StreamSearchBar` / `BatchSelectionBar`.
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
