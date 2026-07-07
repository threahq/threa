import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import {
  Hash,
  FileEdit,
  User,
  MessageSquareText,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  PanelRight,
  type LucideIcon,
} from "lucide-react"
import { DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD } from "@threa/types"
import { RelativeTime } from "@/components/relative-time"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { buildBranchedBoardRows } from "@/components/board/board-row-item"
import { BranchedBoardRows, BranchProvenanceRow } from "@/components/board/branch-rows"
import { resolveBoardEventRows } from "@/lib/board/board-event-rows"
import { groupBranches, type BranchConversationView } from "@/lib/board/branch-grouping"
import {
  useConversationGraph,
  useStreamStructuralIndex,
  deriveBranchConversations,
  deriveBranchProvenance,
} from "@/hooks/use-conversation-graph"
import { ConversationActionsMenu } from "@/components/conversations/conversation-actions-menu"
import { cn } from "@/lib/utils"
import { ConversationReadProvider, useConversationReadController } from "@/components/message/conversation-read-context"
import { useConversationAutoRead } from "@/components/message/use-conversation-auto-read"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { useActors, useVisibleStreams } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useConversationService, usePanel, createConversationPanelId, usePreferences } from "@/contexts"
import { useBoardCardCollapse } from "@/hooks/use-board-card-collapse"
import { conversationKeys, useSplitThread } from "@/hooks/use-conversations"
import { useBoardCardMessages, useStableReplyWindow } from "@/hooks/use-board-card-messages"
import { useInlineBranchComposer } from "@/components/board/use-inline-branch-composer"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

interface BoardCardProps {
  workspaceId: string
  post: BoardViewPost
  /** Where the post lives (channel name, DM peer, scratchpad name), for the header. */
  contextLabel: string
  /** Resolved stream type, selecting the context glyph. */
  streamType: string | undefined
}

const TYPE_GLYPH: Record<string, LucideIcon> = {
  channel: Hash,
  scratchpad: FileEdit,
  dm: User,
}

/** How many trailing messages a nested branch previews on a collapsed card; the
 *  hidden rest sits behind an "N more replies" link into the child's panel. */
const BRANCH_PREVIEW_CAP = 2

/**
 * One board post: a conversation rendered as a feed post that reads like the
 * stream timeline. Messages use the same primitives (`ActorAvatar`,
 * `MarkdownContent`, `MessageReactions`) and the same same-author grouping, so a
 * board message is indistinguishable from a real one. The card delimits the
 * conversation (no reply indentation); a collapsed "N more messages" gap fills
 * in on click. The stream it lives in is the header locator, not a topic line.
 */
export function BoardCard({ workspaceId, post, contextLabel, streamType }: BoardCardProps) {
  const { conversation } = post
  const { getActorName } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const { openPanel, getPanelUrl } = usePanel()
  const [expanded, setExpanded] = useState(false)
  // Scopes text-selection quoting to this card so a selection routes into this
  // card's composer, not a sibling card's provider.
  const cardRef = useRef<HTMLDivElement>(null)

  // Shared graph + structural index, needed BEFORE the rail hook: the inline
  // branch composer derives the branch thread streams (and any pending
  // sub-topic draft rails) the card must subscribe to as extra rails.
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

  // Bodies ride the same `db.events` rail the timeline does — live and
  // offline-first — with the cached server projection as the cold-start fallback.
  // `pendingReplies` are the viewer's own just-sent replies awaiting their echo:
  // they aren't in the conversation's `messageIds` yet, so the card appends them
  // in place (deduped by id below) until the echo swaps each for the real row.
  const {
    openingMessage,
    replies: railReplies,
    totalReplies,
    pendingReplies,
    source,
    events: railEvents,
    messagesById,
    taggedByConversation,
  } = useBoardCardMessages(post, streamType, {
    branchStreamIds: inlineComposer.branchStreamIds,
    extraDraftPanelIds: inlineComposer.extraDraftPanelIds,
  })

  const streamId = conversation.streamId
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

  // Whole-card fold: every card can be folded to its header from the chevron; the
  // threshold only decides whether a TALL conversation starts folded so it doesn't
  // dominate the feed. The trigger is the card body's rendered height, not a
  // message count — one long composed message warrants folding as much as a long
  // back-and-forth, and a run of one-line messages that stays short does not.
  // Measured pre-paint and latched at the first real measurement (per threshold)
  // so a card that grows tall while on screen never folds under the eye; a
  // per-card toggle persists an override that wins over the measured default.
  const { preferences } = usePreferences()
  const collapseThreshold = preferences?.boardCardCollapseThreshold ?? DEFAULT_BOARD_CARD_COLLAPSE_THRESHOLD
  const messageCount = totalReplies + (openingMessage ? 1 : 0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const tallDecidedRef = useRef(false)
  // Hold the fold decision until preferences hydrate, so a card that mounts
  // before the workspace preferences load doesn't lock in DEFAULT_… and fold
  // against the wrong threshold. Re-runs (resetting the latch) when the real
  // threshold arrives or later changes; gated on the boolean, not the object, so
  // an unrelated preference edit can't re-fold a card the user is looking at.
  const preferencesLoaded = preferences != null
  useLayoutEffect(() => {
    tallDecidedRef.current = false
    if (!preferencesLoaded) return
    const measure = () => {
      if (tallDecidedRef.current) return
      const el = bodyRef.current
      if (!el) return
      const height = el.scrollHeight
      // No layout engine yet (first paint / JSDOM / detached) — stay undecided so
      // the card renders expanded rather than folding on a zero measurement.
      if (height <= 0) return
      tallDecidedRef.current = true
      setTall(height > collapseThreshold)
    }
    measure()
    const el = bodyRef.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapseThreshold, preferencesLoaded])
  const { collapsed: bodyCollapsed, toggle: toggleBodyCollapsed } = useBoardCardCollapse(conversation.id, tall)

  // Conversation read state: per-row gating + actions for the message rows, plus
  // the card's effectively-unread signal for the header dot. Both derive live
  // from the overlay + per-stream watermarks, so the dot clears the moment a
  // read lands (docs/sparse-read-overlay-design.md).
  const {
    value: conversationReadValue,
    hasUnread,
    markReadSilently,
    setExplicitUnreadListener,
    getReadTruth,
  } = useConversationReadController(workspaceId, conversation.id, streamId, currentUserId)
  // Over the card's known local messages (opening + the full local reply rail);
  // own-authored rows are excluded inside `hasUnread`.
  const knownMessages = useMemo(
    () => (openingMessage ? [openingMessage, ...railReplies] : railReplies),
    [openingMessage, railReplies]
  )
  const cardHasUnread = hasUnread(knownMessages)

  // Agent traces / memo captures / follow-ups on this conversation, interleaved
  // into the message rows below. Render-only (STREAM_ROW_SPEC `bumps: false`), so
  // they stay OUT of the read-state arrays above — they are not members and carry
  // no read state. A session shows iff its invoking message is a conversation
  // member; the member set is the card's known messages plus the server ids.
  const memberMessageIds = useMemo(() => {
    const set = new Set<string>(conversation.messageIds)
    for (const message of knownMessages) set.add(message.id)
    return set
  }, [conversation.messageIds, knownMessages])
  const eventRows = useMemo(
    () => resolveBoardEventRows(railEvents, { conversationId: conversation.id, memberMessageIds }),
    [railEvents, conversation.id, memberMessageIds]
  )

  // Per-thread-boundary grouping: soft-thread seams, nested branch conversations,
  // and "branched from" provenance derive from the stream graph + the shared
  // conversation graph. Grouping runs over the already-displayed rows below, so
  // the stable-window / allResolved machinery stays untouched.
  const occupiedStreamIds = useMemo(() => {
    const set = new Set<string>([streamId])
    for (const message of knownMessages) if (message.streamId) set.add(message.streamId)
    return set
  }, [streamId, knownMessages])
  // A nested branch conversation's own bodies, resolved through this card's
  // merged rail: its server `messageIds` unioned with the rows tagged with its
  // id (a just-sent branch reply rides the tag through its echo window — the
  // same union the card does for its own replies). A collapsed card previews a
  // branch's last BRANCH_PREVIEW_CAP messages; the hidden rest links to the
  // child's panel.
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
      const shown = expanded ? rows : rows.slice(-BRANCH_PREVIEW_CAP)
      // Server-known members not shown (locally missing, or under the collapsed
      // window) count toward the "N more replies" link into the child's panel.
      const knownTotal = Math.max(branchMemberIds.length, rows.length)
      return { messages: shown, hiddenCount: Math.max(0, knownTotal - shown.length) }
    },
    [messagesById, taggedByConversation, expanded]
  )
  const branchesByForkMessageId = useMemo(() => {
    const branches = deriveBranchConversations({
      conversationId: conversation.id,
      memberMessageIds: conversation.messageIds,
      index: structuralIndex,
      graph: conversationGraph,
      resolveMessages: resolveBranchMessages,
      // A thread this conversation itself occupies renders inline (soft/spanning),
      // never doubled as a branch group (mixed membership, adjustment D).
      excludeThreadStreamIds: occupiedStreamIds,
    })
    const byFork = new Map<string, BranchConversationView[]>()
    for (const branch of branches) {
      const list = byFork.get(branch.forkMessageId)
      if (list) list.push(branch)
      else byFork.set(branch.forkMessageId, [branch])
    }
    // In-flight sub-topic sends render as synthetic pending branches until the
    // graph takes over. A fork carries at most one thread, so a fork the graph
    // already covers skips its pending twin (the one-render hand-off overlap).
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
        anchorStreamId: streamId,
        index: structuralIndex,
        graph: conversationGraph,
      }),
    [conversation.id, streamId, structuralIndex, conversationGraph]
  )
  const branchRows = (messages: RenderableMessage[]) =>
    buildBranchedBoardRows(
      groupBranches(messages, { streams: structuralIndex.streamsById, conversation: { streamId } }),
      eventRows,
      branchesByForkMessageId,
      openingMessage?.id
    )
  // A spanning-overflow row from a card opens the whole conversation in the panel.
  const continueThreadTo = () => getPanelUrl(createConversationPanelId(conversation.id))
  // Heal a soft-thread seam into its own topic (the card re-forms as a nested
  // branch group via the conversation:created/updated sync).
  const splitThread = useSplitThread(workspaceId)
  const onSplitThread = (threadStreamId: string) =>
    splitThread.mutate({ conversationId: conversation.id, threadStreamId })

  // The rail carries every locally-synced reply; older ones (or a wholly unsynced
  // stream — `source === "projection"`) may be missing, so on expand we backfill
  // the full hydrated set from the server. Never blocks the first render: the
  // local replies show immediately, this only fills the gap when online.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  const {
    data: allMessages,
    isError: expandFailed,
    refetch: refetchMessages,
  } = useQuery({
    queryKey: conversationKeys.boardMessages(conversation.id),
    queryFn: () => conversationService.getBoardMessages(workspaceId, conversation.id),
    enabled: expanded && incompleteLocally,
    staleTime: 60_000,
  })

  // Collapsed cards preview an append-only window over the local rail: trailing
  // replies at first reveal, growing (never sliding) as new ones land, so a
  // visible reply is never evicted back under the "N more" gap.
  const collapsedReplies = useStableReplyWindow(conversation.id, railReplies)

  // Expanded: the full conversation minus the opening (server backfill when the
  // local rail is incomplete, else the rail itself). Collapsed: the stable
  // window of the local rail. Flat if-chain, not a nested ternary (INV-47).
  let replies: RenderableMessage[]
  if (!expanded) replies = collapsedReplies
  // Prefer the server backfill only while the local rail is still incomplete;
  // once the rail catches up, fall through to it so live edits keep flowing (the
  // backfill's `data` lingers after `enabled` goes false).
  else if (incompleteLocally && allMessages)
    replies = (allMessages as RenderableMessage[]).filter((m) => m.id !== openingMessage?.id)
  else replies = railReplies
  // Merge this card's own just-sent replies with the confirmed set, skipping any
  // the rail or a backfill already carries, then sort by time: a pending reply
  // can be OLDER than a confirmed one (someone else's reply lands while yours is
  // still in flight), so appending blindly would render it out of order.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  const displayedReplies = [...replies, ...pendingReplies.filter((m) => !seenReplyIds.has(m.id))].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )
  const hiddenCount = expanded ? 0 : Math.max(0, totalReplies - replies.length)
  const loadingMore = expanded && incompleteLocally && !allMessages && !expandFailed
  // No middle is hidden, so opening + replies form one uninterrupted run that
  // groups across the boundary. Otherwise a gap row sits between them.
  const contiguous = (expanded && (!incompleteLocally || !!allMessages)) || (!expanded && hiddenCount === 0)

  // Viewport auto-read: rows that dwell on screen mark themselves read (the menu
  // actions are the override). Every rendered row is eligible — on a collapsed
  // card the cutoff through a trailing-preview row also covers the hidden "N
  // more" middle, deliberately: the card IS the conversation surface, so reading
  // its visible tail reads the conversation up to there, exactly like invoking
  // "Mark as read up to here" on that row (Kris's dogfood ruling on PR #1174 —
  // having the conversation open is enough to mark it).
  const autoReadRows = openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies
  useConversationAutoRead({
    containerRef: cardRef,
    messages: autoReadRows,
    rootStreamId: streamId,
    rowState: conversationReadValue.state,
    markRead: markReadSilently,
    registerExplicitUnread: setExplicitUnreadListener,
    getReadTruth,
  })

  // The card is a first-class reading surface (live message bodies, viewport
  // auto-read above), so while any part of it is on screen its streams count
  // as visible for push suppression — otherwise a push banners the exact
  // message the user is reading on the board. Viewport-gated (not mount-gated)
  // so off-screen cards on a long board don't suppress streams the user can't
  // see.
  const [cardInViewport, setCardInViewport] = useState(false)
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => setCardInViewport(entry.isIntersecting))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // The nested branches the card renders count as on-screen too — their content
  // is read right here, so pushes for them must suppress as well.
  const cardVisibleStreamIds = useMemo(
    () =>
      cardInViewport ? [...new Set([streamId, ...(post.streamIds ?? []), ...inlineComposer.branchStreamIds])] : [],
    [cardInViewport, streamId, post.streamIds, inlineComposer.branchStreamIds]
  )
  useVisibleStreams(cardVisibleStreamIds)

  // Elevate the sticky header once it pins: a zero-height sentinel at the card
  // top drives it — when the sentinel scrolls out of the board viewport the
  // header is stuck, so a hairline + shadow separate it from the messages sliding
  // under it (otherwise the pinned header reads flat against them).
  const stuckSentinelRef = useRef<HTMLDivElement>(null)
  const [headerStuck, setHeaderStuck] = useState(false)
  useEffect(() => {
    const sentinel = stuckSentinelRef.current
    if (!sentinel || typeof IntersectionObserver === "undefined") return
    const root = sentinel.closest("[data-radix-scroll-area-viewport]")
    const observer = new IntersectionObserver(([entry]) => setHeaderStuck(!entry.isIntersecting), { root })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  const renderMessage = (message: RenderableMessage, continuation: boolean) => {
    // A conversation can span its root + threads (one root); render each row
    // against its own stream so reactions and the permalink target where the
    // message actually lives, falling back to the card's anchor stream.
    const rowStreamId = message.streamId ?? streamId
    // "New sub-topic" only where a fresh branch is valid: hide it once a thread
    // already exists under the message (a populated thread would mix membership —
    // "Split this thread" is the gesture there, adjustment D).
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
        // Break the row out of the card's p-3/p-4 padding and pad the content back in,
        // so an actor accent fills to the card edges (stream-view look) with rows aligned.
        surfaceClassName="bg-card px-3 sm:px-4"
        bodyFadeClassName="to-card"
        rowInsetClassName="-mx-3 sm:-mx-4"
        onNewSubtopic={canBranch ? () => inlineComposer.openNewSubtopic(rowStreamId, message.id) : undefined}
      />
    )
  }

  // A nested branch's rows are OUTSIDE this card's conversation: render-only
  // here, so they're wrapped in a null read provider (no mark-read/unread, no
  // auto-read, no unread-dot input — their read state belongs to the child's own
  // surfaces) and identify as the CHILD conversation (copy-link opens its panel).
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
          surfaceClassName="bg-card"
          bodyFadeClassName="to-card"
          onNewSubtopic={
            canBranch
              ? () => inlineComposer.openNewSubtopic(message.streamId ?? branch.threadStreamId, message.id)
              : undefined
          }
        />
      </ConversationReadProvider>
    )
  }

  return (
    // Scope quote reply to this card: a message row's "Quote reply" routes into
    // this card's own reply composer, not another card's.
    <ConversationReadProvider value={conversationReadValue}>
      <QuoteReplyProvider>
        {/* Desktop text-selection → floating "Quote" button, scoped to this card. */}
        <TextSelectionQuote streamId={streamId} containerRef={cardRef} />
        <div ref={cardRef} className="rounded-xl border bg-card p-3 sm:p-4">
          {/* Zero-height marker at the card top: drives the header's stuck state
              (see the observer above). In flow but h-0, so it shifts nothing. */}
          <div ref={stuckSentinelRef} aria-hidden className="h-0" />
          {/* Header pins to the scroll-viewport top while the card's messages
              scroll under it (bg-card covers them), so the locator + topic stay
              legible in a long card. The negative margins + re-padding fill the
              header to the card edges; at rest it looks identical to an unpinned
              header. A hairline + shadow fade in once pinned (headerStuck) to lift
              it off the messages; the border is always present but transparent so
              the elevation never shifts layout (INV-21). */}
          <div
            className={cn(
              "sticky top-0 z-10 -mx-3 -mt-3 rounded-t-xl border-b border-transparent bg-card px-3 pt-3 pb-2 transition-[box-shadow,border-color] duration-200 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4",
              headerStuck && "border-border/60 shadow-[0_4px_12px_-6px_rgb(0_0_0/0.4)]"
            )}
          >
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleBodyCollapsed}
                    aria-expanded={!bodyCollapsed}
                    aria-label={bodyCollapsed ? "Expand conversation" : "Collapse conversation"}
                    className="-ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground"
                  >
                    {bodyCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{bodyCollapsed ? "Expand" : "Collapse"}</TooltipContent>
              </Tooltip>
              {/* The stream the post lives in — a real link back into it (INV-40). */}
              <Link
                to={`/w/${workspaceId}/s/${streamId}`}
                className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <ContextGlyph className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-medium">{contextLabel}</span>
              </Link>
              {/* Quiet unread dot: the conversation holds an effectively-unread member
              message. Reserved fixed footprint (no layout shift, INV-21); clears
              live as read state changes. */}
              <span
                className="ml-auto flex h-2 w-2 shrink-0 items-center justify-center"
                aria-label={cardHasUnread ? "Unread" : undefined}
              >
                {cardHasUnread && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <RelativeTime date={conversation.lastActivityAt} terse className="shrink-0" />
              {/* Open the whole conversation in the side panel (Mechanism B) — reads it
            coherently and replies scoped to it, peer to a thread. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Open conversation"
                    onClick={() => openPanel(createConversationPanelId(conversation.id))}
                  >
                    <PanelRight className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Open conversation</TooltipContent>
              </Tooltip>
              <ConversationActionsMenu
                workspaceId={workspaceId}
                conversationId={conversation.id}
                topicSummary={conversation.topicSummary}
                status={conversation.status}
                triggerClassName="shrink-0"
              />
            </div>

            {/* The conversation's topic — a quiet single-line label, shown only when
            the extractor (or a rename) set one, so a message-led card stays
            message-led when it hasn't. A resolved topic reads muted with a small
            marker; the card also drops out of the Active lens (its own signal). */}
            {conversation.topicSummary && (
              <div className="mt-2 flex items-center gap-1.5">
                {conversation.status === "resolved" && (
                  <CircleCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Resolved" />
                )}
                <span
                  className={cn(
                    "truncate text-sm font-medium",
                    conversation.status === "resolved" && "text-muted-foreground line-through decoration-1"
                  )}
                >
                  {conversation.topicSummary}
                </span>
              </div>
            )}

            {/* Collapsed: the header stands alone; the message count names how much
              is folded so scale is legible without unfolding. */}
            {bodyCollapsed && (
              <button
                type="button"
                onClick={toggleBodyCollapsed}
                className="mt-2 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {messageCount} {messageCount === 1 ? "message" : "messages"}
              </button>
            )}
          </div>

          {!bodyCollapsed && (
            <>
              <div ref={bodyRef} className="mt-3 [&>*:first-child]:mt-0">
                {provenance && (
                  <BranchProvenanceRow conversationId={provenance.parentConversationId} title={provenance.title} />
                )}
                {contiguous ? (
                  <BranchedBoardRows
                    rows={branchRows(openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies)}
                    workspaceId={workspaceId}
                    renderMessage={renderMessage}
                    continueThreadTo={continueThreadTo}
                    onSplitThread={onSplitThread}
                    renderBranchMessage={renderBranchMessage}
                    renderBranchTail={inlineComposer.renderBranchTail}
                    renderAfterMessage={inlineComposer.renderAfterMessage}
                  />
                ) : (
                  <>
                    {openingMessage && renderMessage(openingMessage, false)}
                    {/* The opening renders outside the row builder here, so its inline
                    "new sub-topic" composer slot must be placed explicitly. */}
                    {openingMessage && inlineComposer.renderAfterMessage(openingMessage.id)}
                    {!expanded && hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpanded(true)}
                        className="mt-3 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                        {hiddenCount} more {hiddenCount === 1 ? "message" : "messages"}
                      </button>
                    )}
                    {loadingMore && (
                      <span className="mt-3 block text-xs text-muted-foreground">Loading older messages…</span>
                    )}
                    {/* The backfill loads the older/full window; the recent replies the
                rail carried are already shown above, so the error names "older"
                rather than contradicting visible content. */}
                    {expanded && expandFailed && (
                      <button
                        type="button"
                        onClick={() => void refetchMessages()}
                        className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
                      >
                        Couldn't load older messages. Retry.
                      </button>
                    )}
                    <BranchedBoardRows
                      rows={branchRows(displayedReplies)}
                      workspaceId={workspaceId}
                      renderMessage={renderMessage}
                      continueThreadTo={continueThreadTo}
                      onSplitThread={onSplitThread}
                      renderBranchMessage={renderBranchMessage}
                      renderBranchTail={inlineComposer.renderBranchTail}
                      renderAfterMessage={inlineComposer.renderAfterMessage}
                    />
                  </>
                )}
              </div>

              <BoardReplyComposer
                workspaceId={workspaceId}
                post={post}
                hostStreamType={streamType}
                // The conversation's most-recently-active stream — the latest displayed
                // reply's own stream (a thread under the root), INCLUDING the viewer's own
                // pending reply and any expand-backfilled rows, so a continuation follows
                // the conversation into the thread it moved to instead of re-interleaving
                // the channel. `displayedReplies` is chronological; its last entry is the
                // freshest activity. Falls back to the conversation's own stream — NOT the
                // opening message's, which for a thread post is the parent-stream message.
                lastActiveStreamId={displayedReplies.at(-1)?.streamId ?? streamId}
              />
            </>
          )}
        </div>
      </QuoteReplyProvider>
    </ConversationReadProvider>
  )
}
