import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  ChevronLeft,
  Hash,
  FileEdit,
  User,
  MessageSquareText,
  Link2,
  Check,
  CircleCheck,
  type LucideIcon,
} from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { buildBranchedBoardRows } from "@/components/board/board-row-item"
import { BranchedBoardRows, BranchProvenanceRow } from "@/components/board/branch-rows"
import { resolveBoardEventRows } from "@/lib/board/board-event-rows"
import { groupBranches, type BranchConversationView } from "@/lib/board/branch-grouping"
import {
  useConversationGraph,
  useStreamStructuralIndex,
  deriveBranchConversations,
  collectBranchThreadStreamIds,
  deriveBranchProvenance,
} from "@/hooks/use-conversation-graph"
import { useInlineBranchComposer } from "@/components/board/use-inline-branch-composer"
import { useMoveToSubtopic } from "@/components/board/use-move-to-subtopic"
import { ConversationActionsMenu } from "@/components/conversations/conversation-actions-menu"
import { useBoardHiddenConversations } from "@/stores/board-exclusions-store"
import { cn } from "@/lib/utils"
import { ConversationReadProvider, useConversationReadController } from "@/components/message/conversation-read-context"
import { useConversationAutoRead } from "@/components/message/use-conversation-auto-read"
import { RelativeTime } from "@/components/relative-time"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import {
  FloatingComposerAnchorProvider,
  useFloatingComposerAnchor,
  FLOATING_COMPOSER_HEIGHT_VAR,
} from "@/components/composer"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { SidebarToggle } from "@/components/layout"
import { useActors, useVisibleStreams } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useStreamName } from "@/hooks/use-stream-name"
import { useConversationService, usePanel, parseConversationPanel, useSidebar } from "@/contexts"
import { useStreamFromStore } from "@/stores/stream-store"
import { consumeConversationReplyOpen, subscribeConversationReplyOpen } from "@/stores/conversation-reply-open-store"
import { conversationKeys, useConversationBoardPost, useSplitThread } from "@/hooks/use-conversations"
import { useBoardCardMessages } from "@/hooks/use-board-card-messages"
import { usePanelStreamSubscriptions } from "@/hooks/use-panel-stream-subscriptions"
import { buildConversationLink } from "@/lib/stream-links"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

interface ConversationPanelProps {
  workspaceId: string
  onClose: () => void
}

/**
 * A single conversation opened in the side panel (Mechanism B,
 * board-view-design.md) — a projection peer to a thread, keyed by `?panel=conv:<id>`.
 * Reads the conversation flattened-chronological across its root + threads (one
 * root), live off the same `db.events` rail the board card and timeline ride, and
 * replies scoped to it via the recency-biased board-reply path. No stream is
 * mutated and access is the conversation's single root check (enforced when the
 * by-id post is fetched, INV-62) — the panel adds no per-message gating.
 */
export function ConversationPanel({ workspaceId, onClose }: ConversationPanelProps) {
  const { isMobile } = useSidebar()
  const [floatingAnchorEl, setFloatingAnchorEl] = useState<HTMLElement | null>(null)
  const { panelId } = usePanel()
  const conversationId = panelId ? parseConversationPanel(panelId) : null
  const { post, isLoading, notFound, refetch } = useConversationBoardPost(workspaceId, conversationId)
  // Hidden set — the panel is reachable for a hidden conversation (deep-link,
  // search, Saved), so it offers "Unhide" when the open one is hidden.
  const hiddenConversations = useBoardHiddenConversations(workspaceId)

  // "Reply in conversation" opened this panel with the intent to reply, not just
  // read — pick up its one-shot signal (queued before this panel mounted, or
  // arriving while it's already open for the same conversation) and land the user
  // in the composer. A monotonic nonce, not a boolean, so a repeat request while
  // the panel is already open re-opens the composer after a manual collapse.
  // Stays 0 on a plain deep-link/"Show in conversation" open (no queued request).
  const [openReplySignal, setOpenReplySignal] = useState(0)
  useEffect(() => {
    if (!conversationId) return
    const bump = () => {
      if (consumeConversationReplyOpen(conversationId)) setOpenReplySignal((n) => n + 1)
    }
    bump()
    return subscribeConversationReplyOpen(conversationId, bump)
  }, [conversationId])

  // Keep the conversation's streams (root + threads) caught up + joined while the
  // panel is open, so the rail is live and offline-first. Its own SyncEngine slot,
  // so it composes with the board feed rather than clobbering it. The nested
  // branch conversations' threads are folded in too — the panel renders their
  // bodies inline, so they must sync like any other rendered stream.
  const conversationGraph = useConversationGraph(workspaceId)
  const structuralIndex = useStreamStructuralIndex(workspaceId)
  const panelStreamIds = useMemo(() => {
    if (!post) return []
    const branchIds = collectBranchThreadStreamIds({
      conversationId: post.conversation.id,
      memberMessageIds: post.conversation.messageIds,
      index: structuralIndex,
      graph: conversationGraph,
    })
    return [...new Set([post.conversation.streamId, ...(post.streamIds ?? []), ...branchIds])]
  }, [post, structuralIndex, conversationGraph])
  usePanelStreamSubscriptions(panelStreamIds)
  // The panel's streams aren't in the URL (`?panel=conv:…`), so the SW's push
  // suppression can only know they're on screen if we register them here.
  useVisibleStreams(panelStreamIds)

  // Escape closes the panel, matching StreamPanel — the two are peers in the same
  // slot, so the keyboard affordance should be consistent. Skip when the event was
  // already handled (the reply composer's own Escape collapses the editor first) or
  // when focus is in a text field, so closing the panel never eats a composer Escape.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('[contenteditable="true"], input, textarea')) return
      onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  // Header "Copy link" confirms in place — the icon swaps to a checkmark for a
  // beat (same footprint, no shift per INV-21) rather than a toast, because a
  // persistent header button is an on-screen anchor (INV-63; mirrors the
  // image-gallery toolbar). Only the anchorless callers (the mod+Shift+L
  // shortcut, the message-menu item) keep `copyConversationLink`'s toast.
  const [copyDone, setCopyDone] = useState(false)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    },
    []
  )
  const handleCopyLink = useCallback(async () => {
    if (!conversationId) return
    try {
      await navigator.clipboard.writeText(buildConversationLink(workspaceId, conversationId))
      setCopyDone(true)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopyDone(false), 1200)
    } catch {
      toast.error("Failed to copy link")
    }
  }, [conversationId, workspaceId])

  const anchorStreamId = post?.conversation.streamId
  const hostStream = useStreamFromStore(anchorStreamId)
  const hostStreamType = hostStream?.type
  const locator = useStreamName(workspaceId, anchorStreamId ?? "", "generic") ?? "Conversation"
  const ContextGlyph = (hostStreamType && TYPE_GLYPH[hostStreamType]) || MessageSquareText

  let body: React.ReactNode
  if (post) {
    body = (
      <ConversationPanelBody
        workspaceId={workspaceId}
        post={post}
        hostStreamType={hostStreamType}
        openReplySignal={openReplySignal}
      />
    )
  } else if (isLoading) {
    body = (
      <div className="flex flex-col gap-3 p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-start gap-2">
            <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/4" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    )
  } else if (notFound) {
    body = (
      <Empty className="min-h-[16rem] border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareText />
          </EmptyMedia>
          <EmptyTitle>Couldn't open this conversation</EmptyTitle>
          {/* The state covers both a transient load failure (retry helps) and a
              gone/merged/access-lost conversation (retry won't) — so the copy names
              both rather than asserting one, keeping "Try again" honest. */}
          <EmptyDescription>
            It may have moved or been merged, you may have lost access, or there was a problem loading it.
          </EmptyDescription>
        </EmptyHeader>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
          Try again
        </Button>
      </Empty>
    )
  } else {
    // Resolved to no post and not an error — transient; show nothing rather than flash.
    body = null
  }

  return (
    <SidePanel data-editor-zone="panel">
      <SidePanelHeader>
        {isMobile && <SidebarToggle location="page" />}
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
          <ChevronLeft className="h-4 w-4" />
          <span className="sr-only">Back</span>
        </Button>
        <SidePanelTitle className="flex min-w-0 flex-1 items-center gap-1.5">
          <ContextGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />
          {post?.conversation.status === "resolved" && (
            <CircleCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Resolved" />
          )}
          {/* The topic is the conversation's identity — show it when set, falling
            back to the stream locator (the pre-topic behavior). */}
          <span className={cn("truncate", post?.conversation.status === "resolved" && "text-muted-foreground")}>
            {post?.conversation.topicSummary ?? locator}
          </span>
          {post && (
            <RelativeTime
              date={post.conversation.lastActivityAt}
              terse
              className="ml-1 shrink-0 text-xs font-normal text-muted-foreground"
            />
          )}
        </SidePanelTitle>
        {post && (
          <ConversationActionsMenu
            workspaceId={workspaceId}
            conversationId={post.conversation.id}
            streamId={post.conversation.streamId}
            topicSummary={post.conversation.topicSummary}
            status={post.conversation.status}
            isHidden={hiddenConversations.has(post.conversation.id)}
            triggerClassName="shrink-0"
          />
        )}
        {conversationId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={copyDone ? "Link copied" : "Copy link to conversation"}
                onClick={() => void handleCopyLink()}
              >
                {copyDone ? <Check className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{copyDone ? "Copied" : "Copy link"}</TooltipContent>
          </Tooltip>
        )}
        {!isMobile && <SidePanelClose onClose={onClose} />}
      </SidePanelHeader>
      {/* `relative` + the anchor: on mobile an open reply/branch composer portals
          to this container's bottom as the shared floating pill (same as the
          stream page) instead of sitting in the scrolled flow. */}
      <SidePanelContent ref={setFloatingAnchorEl} className="relative flex flex-col">
        <FloatingComposerAnchorProvider el={floatingAnchorEl}>{body}</FloatingComposerAnchorProvider>
      </SidePanelContent>
    </SidePanel>
  )
}

interface ConversationPanelBodyProps {
  workspaceId: string
  post: BoardViewPost
  hostStreamType: string | undefined
  /** Bumped each time the panel is opened via "Reply in conversation" — opens the composer. */
  openReplySignal: number
}

/**
 * The panel's message column + scoped composer. Always renders the FULL
 * conversation (the panel is permanently "expanded"): the live rail from
 * {@link useBoardCardMessages} for opening + recent + the viewer's pending
 * replies, backfilled with the complete ordered list when the local rail is
 * incomplete — the same merge the board card runs on expand.
 */
function ConversationPanelBody({ workspaceId, post, hostStreamType, openReplySignal }: ConversationPanelBodyProps) {
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const splitThread = useSplitThread(workspaceId)
  const { conversation } = post
  // Per-row read state + the mark-read/unread actions for this conversation's
  // rows (docs/sparse-read-overlay-design.md). The panel has no unread dot, so
  // only the provider value is used.
  const {
    value: conversationReadValue,
    markReadSilently,
    setExplicitUnreadListener,
    getReadTruth,
  } = useConversationReadController(workspaceId, conversation.id, conversation.streamId, currentUserId)
  // Deep-link target from `?m=` — the row to scroll to + flash. Shared with the
  // host page's `m` param, but only the conversation panel reads it here (the
  // board page, the panel's host for a conversation link, ignores it), so a
  // shared conversation link lands on the right message without a competing
  // main-view highlight.
  const [searchParams] = useSearchParams()
  const highlightMessageId = searchParams.get("m")

  // Shared graph + structural index, needed before the rail hook: the inline
  // branch composer derives the branch thread streams (and pending sub-topic
  // draft rails) the panel subscribes to as extra rails.
  const conversationGraph = useConversationGraph(workspaceId)
  const structuralIndex = useStreamStructuralIndex(workspaceId)
  const inlineComposer = useInlineBranchComposer({
    workspaceId,
    conversationId: conversation.id,
    memberMessageIds: conversation.messageIds,
    index: structuralIndex,
    graph: conversationGraph,
  })
  const { derivePendingBranches } = inlineComposer

  const {
    openingMessage,
    replies: railReplies,
    totalReplies,
    pendingReplies,
    source,
    events: railEvents,
    messagesById,
    taggedByConversation,
  } = useBoardCardMessages(post, hostStreamType, {
    branchStreamIds: inlineComposer.branchStreamIds,
    extraDraftPanelIds: inlineComposer.extraDraftPanelIds,
  })

  // Backfill the full window when the local rail is missing older replies (or the
  // stream isn't synced yet); the live rail shows immediately, this only fills the
  // gap when online. Mirrors board-card's expand path.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  const {
    data: allMessages,
    isError: backfillFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversation.id),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversation.id),
    enabled: incompleteLocally,
    staleTime: 60_000,
  })

  // Prefer the server backfill only while the local rail is still incomplete; once
  // it catches up, fall through to the rail so live edits keep flowing.
  let replies: RenderableMessage[]
  if (incompleteLocally && allMessages)
    replies = (allMessages as RenderableMessage[]).filter((m) => m.id !== openingMessage?.id)
  else replies = railReplies
  // Merge the viewer's own just-sent replies (deduped), then sort by time — a
  // pending reply can be older than a confirmed one.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  const displayedReplies = [...replies, ...pendingReplies.filter((m) => !seenReplyIds.has(m.id))].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  const loadingMore = incompleteLocally && !allMessages && !backfillFailed

  const all = openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies

  // Agent traces / memo captures / follow-ups on this conversation, interleaved
  // into the message rows. Render-only (STREAM_ROW_SPEC `bumps: false`) — kept out
  // of the read-state arrays (they are not members). A session shows iff its
  // invoking message is a conversation member.
  const memberMessageIds = useMemo(() => {
    const set = new Set<string>(conversation.messageIds)
    for (const message of all) set.add(message.id)
    return set
  }, [conversation.messageIds, all])
  const eventRows = useMemo(
    () => resolveBoardEventRows(railEvents, { conversationId: conversation.id, memberMessageIds }),
    [railEvents, conversation.id, memberMessageIds]
  )

  // Per-thread-boundary grouping — same derivation as the board card (the panel
  // is the always-expanded peer). Overflow rows link into the thread's own stream
  // panel here rather than back to this conversation.
  const { getPanelUrl } = usePanel()
  const occupiedStreamIds = useMemo(() => {
    const set = new Set<string>([conversation.streamId])
    for (const message of all) if (message.streamId) set.add(message.streamId)
    return set
  }, [conversation.streamId, all])
  // A nested branch's bodies resolve through the panel's merged rail — its server
  // `messageIds` unioned with the rows tagged with its id (a just-sent branch
  // reply rides the tag through its echo window). The panel is always expanded,
  // so every locally-available branch message shows; only unsynced members count
  // toward the "N more replies" link.
  const resolveBranchMessages = useCallback(
    (branchConversationId: string, branchMemberIds: string[]) => {
      const rows: RenderableMessage[] = []
      const seen = new Set<string>()
      for (const id of branchMemberIds) {
        const message = messagesById.get(id)
        if (!message) continue
        rows.push(message)
        seen.add(id)
      }
      for (const tagged of taggedByConversation.get(branchConversationId) ?? []) {
        if (!seen.has(tagged.id)) rows.push(tagged)
      }
      rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      const knownTotal = Math.max(branchMemberIds.length, rows.length)
      return { messages: rows, hiddenCount: Math.max(0, knownTotal - rows.length) }
    },
    [messagesById, taggedByConversation]
  )
  const branchesByForkMessageId = useMemo(() => {
    const branches = deriveBranchConversations({
      conversationId: conversation.id,
      memberMessageIds: conversation.messageIds,
      index: structuralIndex,
      graph: conversationGraph,
      resolveMessages: resolveBranchMessages,
      excludeThreadStreamIds: occupiedStreamIds,
    })
    const byFork = new Map<string, BranchConversationView[]>()
    for (const branch of branches) {
      const list = byFork.get(branch.forkMessageId)
      if (list) list.push(branch)
      else byFork.set(branch.forkMessageId, [branch])
    }
    // In-flight sub-topic sends render as synthetic pending branches until the
    // graph takes over (one thread per fork, so a graph-covered fork wins).
    for (const branch of derivePendingBranches(messagesById)) {
      if (!byFork.has(branch.forkMessageId)) byFork.set(branch.forkMessageId, [branch])
    }
    return byFork
  }, [
    conversation.id,
    conversation.messageIds,
    structuralIndex,
    conversationGraph,
    resolveBranchMessages,
    occupiedStreamIds,
    derivePendingBranches,
    messagesById,
  ])
  const provenance = useMemo(
    () =>
      deriveBranchProvenance({
        conversationId: conversation.id,
        anchorStreamId: conversation.streamId,
        index: structuralIndex,
        graph: conversationGraph,
      }),
    [conversation.id, conversation.streamId, structuralIndex, conversationGraph]
  )
  const rows = buildBranchedBoardRows(
    groupBranches(all, { streams: structuralIndex.streamsById, conversation: { streamId: conversation.streamId } }),
    eventRows,
    branchesByForkMessageId,
    openingMessage?.id
  )
  // "Move to sub-topic" re-file — same gesture as the board card (membership move
  // within one root; the hook hides the action when a row has nowhere to go).
  const moveToSubtopic = useMoveToSubtopic({ workspaceId, conversation, branchesByForkMessageId })
  const renderMessage = (message: RenderableMessage, continuation: boolean) => {
    // Each row renders against its own stream so reactions and the permalink
    // target where the message actually lives (one root, many streams); fall
    // back to the anchor.
    const rowStreamId = message.streamId ?? conversation.streamId
    // Hide "New sub-topic" once a thread already exists under the message (a
    // populated thread would mix membership — "Split this thread" is the gesture
    // there, adjustment D).
    const canBranch = !structuralIndex.threadsByParentMessageId.has(message.id)
    return (
      <MessageItem
        key={message.id}
        workspaceId={workspaceId}
        streamId={rowStreamId}
        message={message}
        authorName={getActorName(message.authorId, message.authorType)}
        currentUserId={currentUserId}
        continuation={continuation}
        conversationId={conversation.id}
        conversationRootStreamId={conversation.streamId}
        isHighlighted={message.id === highlightMessageId}
        // Break the row out of the list's px-4 and re-pad it, so an actor accent
        // fills to the panel edges (the stream-view look) with content aligned —
        // matching the board card and timeline.
        surfaceClassName="bg-background px-4"
        rowInsetClassName="-mx-4"
        onNewSubtopic={canBranch ? () => inlineComposer.openNewSubtopic(rowStreamId, message.id) : undefined}
        onMoveToSubtopic={moveToSubtopic.moveHandlerFor(message.id, conversation.id)}
      />
    )
  }
  // A nested branch's rows are OUTSIDE this conversation: render-only (null read
  // provider — no mark-read/unread here) and identified as the CHILD conversation
  // so copy-link opens its panel. Same shape as the board card's.
  const renderBranchMessage = (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => {
    const canBranch = !structuralIndex.threadsByParentMessageId.has(message.id)
    return (
      <ConversationReadProvider value={null}>
        <MessageItem
          workspaceId={workspaceId}
          streamId={message.streamId ?? branch.threadStreamId}
          message={message}
          authorName={getActorName(message.authorId, message.authorType)}
          currentUserId={currentUserId}
          continuation={continuation}
          conversationId={branch.conversationId}
          conversationRootStreamId={branch.threadStreamId}
          surfaceClassName="bg-background"
          onNewSubtopic={
            canBranch
              ? () => inlineComposer.openNewSubtopic(message.streamId ?? branch.threadStreamId, message.id)
              : undefined
          }
          onMoveToSubtopic={
            branch.pending ? undefined : moveToSubtopic.moveHandlerFor(message.id, branch.conversationId)
          }
        />
      </ConversationReadProvider>
    )
  }
  // The conversation's most-recently-active stream — the latest reply's own stream
  // (a thread under the root), so a continuation follows the conversation there
  // instead of re-interleaving the channel (board-view-design.md). Falls back to
  // the conversation's anchor, NOT the opening message's stream (a thread post's
  // opener lives in the parent stream).
  const lastActiveStreamId = displayedReplies.at(-1)?.streamId ?? conversation.streamId

  // Scopes text-selection quoting to this panel's message list.
  const listRef = useRef<HTMLDivElement>(null)

  // True while any of the panel's composers (footer reply, branch tail, new
  // sub-topic) floats in the mobile pill over this panel.
  const floatingComposerOpen = useFloatingComposerAnchor()?.claimantId != null

  // Viewport auto-read: every rendered row is eligible. While older replies are
  // still backfilling, the cutoff through a rendered row also covers the not-
  // yet-fetched middle — deliberate, same as the board card: reading the
  // conversation's visible tail reads it up to there.
  const autoReadRows = all
  useConversationAutoRead({
    containerRef: listRef,
    messages: autoReadRows,
    rootStreamId: conversation.streamId,
    rowState: conversationReadValue.state,
    markRead: markReadSilently,
    registerExplicitUnread: setExplicitUnreadListener,
    getReadTruth,
  })

  return (
    // Quote reply from a row routes into this conversation's reply composer.
    <ConversationReadProvider value={conversationReadValue}>
      <QuoteReplyProvider>
        {/* Desktop text-selection → floating "Quote" button, scoped to this list. */}
        <TextSelectionQuote streamId={conversation.streamId} containerRef={listRef} />
        {moveToSubtopic.moveDialog}
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto px-4"
          // pb-3 baseline, plus room for the mobile floating composer while one
          // is open so the conversation tail can scroll above the pill.
          style={{ paddingBottom: `calc(var(${FLOATING_COMPOSER_HEIGHT_VAR}, 0px) + 0.75rem)` }}
        >
          {provenance && (
            <BranchProvenanceRow conversationId={provenance.parentConversationId} title={provenance.title} />
          )}
          <BranchedBoardRows
            rows={rows}
            workspaceId={workspaceId}
            renderMessage={renderMessage}
            continueThreadTo={(streamId) => getPanelUrl(streamId)}
            onSplitThread={(threadStreamId) => splitThread.mutate({ conversationId: conversation.id, threadStreamId })}
            renderBranchMessage={renderBranchMessage}
            renderBranchTail={inlineComposer.renderBranchTail}
            renderAfterMessage={inlineComposer.renderAfterMessage}
          />
          {loadingMore && <span className="mt-3 block text-xs text-muted-foreground">Loading messages…</span>}
          {backfillFailed && (
            <button
              type="button"
              onClick={() => void refetchMessages()}
              className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
            >
              Couldn't load the full conversation. Retry.
            </button>
          )}
        </div>
        {/* Hidden while a mobile composer floats over the panel (the pill replaces
            the footer's affordance; a second bottom bar under it would double up).
            `hidden`, not unmount — the reply composer inside must stay mounted to
            keep its portal, draft, and open state alive. */}
        <div className={cn("border-t px-4 py-3", floatingComposerOpen && "hidden")}>
          <BoardReplyComposer
            workspaceId={workspaceId}
            post={post}
            hostStreamType={hostStreamType}
            lastActiveStreamId={lastActiveStreamId}
            openReplySignal={openReplySignal}
          />
        </div>
      </QuoteReplyProvider>
    </ConversationReadProvider>
  )
}
