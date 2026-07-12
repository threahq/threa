import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import type { VirtualizerHandle } from "virtua"
import { ChevronDown, ChevronRight, CircleCheck, PanelRight } from "lucide-react"
import { DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT, DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT } from "@threa/types"
import { RelativeTime } from "@/components/relative-time"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { actorRowTheme } from "@/components/message/actor-row-theme"
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
import { streamTypeVisual } from "@/lib/stream-visuals"
import { ConversationReadProvider, useConversationReadController } from "@/components/message/conversation-read-context"
import { useConversationAutoRead } from "@/components/message/use-conversation-auto-read"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import { useMoveToSubtopic } from "@/components/board/use-move-to-subtopic"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { useActors, useVisibleStreams } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useBoardFlash } from "@/stores/board-flash-store"
import { useConversationService, usePanel, createConversationPanelId, usePreferences } from "@/contexts"
import { useBoardCardCollapse } from "@/hooks/use-board-card-collapse"
import { conversationKeys, useSplitThread } from "@/hooks/use-conversations"
import { useBoardCardMessages, useStableReplyWindow } from "@/hooks/use-board-card-messages"
import { useInlineBranchComposer } from "@/components/board/use-inline-branch-composer"
import { useBoardCardRevealAnchor } from "@/hooks/use-board-card-reveal-anchor"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"

interface BoardCardProps {
  workspaceId: string
  post: BoardViewPost
  /** Where the post lives (channel name, DM peer, scratchpad name), for the header. */
  contextLabel: string
  /** Resolved stream type, selecting the context glyph + tile tint. */
  streamType: string | undefined
  /** For a DM post, the peer's user id — resolves the peer avatar shown over the
   *  locator tile, matching the sidebar. Absent for non-DM streams. */
  dmPeerUserId?: string | null
  /** The board's owned scroll viewport — lets a middle-gap expand hold the newest
   *  replies still instead of shoving them down (`useBoardCardRevealAnchor`).
   *  Absent when the card renders outside the virtualized board (tests). */
  scrollerRef?: RefObject<HTMLDivElement | null>
  /** virtua's imperative handle for the board feed, paired with `scrollerRef`. */
  listRef?: RefObject<VirtualizerHandle | null>
}

/** How many trailing messages a nested branch previews on a collapsed card; the
 *  hidden rest sits behind an "N more replies" link into the child's panel. */
const BRANCH_PREVIEW_CAP = 2

// Softens the collapsed card's raw `max-height` clip so it doesn't slice a
// message mid-line/mid-image. Masks the content transparent at the cut (like
// CollapsibleBody) rather than painting a colored gradient — the rows carry the
// actor accent, so any fixed target color would band wrong on some surface; a
// mask lets whatever is behind show through, correct everywhere.
const COLLAPSED_FADE_MASK = "linear-gradient(to bottom, black calc(100% - 2rem), transparent)"

/**
 * One board post: a conversation rendered as a feed post that reads like the
 * stream timeline. Messages use the same primitives (`ActorAvatar`,
 * `MarkdownContent`, `MessageReactions`) and the same same-author grouping, so a
 * board message is indistinguishable from a real one. The card delimits the
 * conversation (no reply indentation); a collapsed "N more messages" gap fills
 * in on click. The stream it lives in is the header locator, not a topic line.
 */
export function BoardCard({
  workspaceId,
  post,
  contextLabel,
  streamType,
  dmPeerUserId,
  scrollerRef,
  listRef,
}: BoardCardProps) {
  const { conversation } = post
  const flash = useBoardFlash(conversation.id)
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const conversationService = useConversationService()
  const { openPanel, getPanelUrl } = usePanel()
  const [expanded, setExpanded] = useState(false)
  // A running session's Redirect bumps this nonce to expand + focus the card's
  // reply composer in place (its editor is collapsed until opened, so there's no
  // DOM zone to walk to). A counter, not a boolean, so a repeat Redirect re-opens
  // it after a manual collapse.
  const [openReplySignal, setOpenReplySignal] = useState(0)
  const openReplyComposer = useCallback(() => setOpenReplySignal((n) => n + 1), [])
  // Scopes text-selection quoting to this card so a selection routes into this
  // card's composer, not a sibling card's provider.
  const cardRef = useRef<HTMLDivElement>(null)
  // Revealing the hidden middle ("N more messages") grows this card from OLDER
  // content above the trailing replies; hold the card bottom fixed so the newest
  // replies the reader is on don't jump (the board's `shift`, see the hook).
  const beginReveal = useBoardCardRevealAnchor({ cardRef, scrollerRef, listRef })

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
  // Leading visual matches the sidebar's stream row: a per-type glyph on a tinted
  // tile, except a DM shows the peer avatar over it (icon as the fallback). Shared
  // `streamTypeVisual` keeps board and sidebar in lockstep.
  const { Icon: TypeIcon, tileClassName } = streamTypeVisual(streamType)
  const dmAvatarUrl = dmPeerUserId ? getActorAvatar(dmPeerUserId, "user").avatarUrl : undefined

  // Whole-card fold: every card can be folded from the chevron; automatic
  // collapse is opt-in and only decides whether a tall conversation starts
  // folded. The trigger is the card body's rendered height, not message count.
  const { preferences } = usePreferences()
  const boardCardCollapseEnabled = preferences?.boardCardCollapseEnabled ?? false
  const collapseAtHeight = preferences?.boardCardCollapseAtHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT
  const collapseToHeight = Math.min(
    preferences?.boardCardCollapseToHeight ?? DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
    collapseAtHeight
  )
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
      setTall(height > collapseAtHeight)
    }
    measure()
    const el = bodyRef.current
    if (!el) return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapseAtHeight, preferencesLoaded])
  const { collapsed: bodyCollapsed, toggle: toggleBodyCollapsed } = useBoardCardCollapse(
    conversation.id,
    boardCardCollapseEnabled && tall
  )

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
  // Direct sub-topics under this conversation — the "↳" branch groups, counted
  // for the locator line and collapse pill. Top-level only (grandchildren nest
  // visually but don't inflate the card's headline count).
  const subtopicCount = useMemo(() => {
    let n = 0
    for (const list of branchesByForkMessageId.values()) n += list.length
    return n
  }, [branchesByForkMessageId])
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
  // "Move to sub-topic" re-file: membership move between this conversation and
  // its nested sub-topics (one root). The hook hides the action when a row has
  // nowhere to go.
  const moveToSubtopic = useMoveToSubtopic({ workspaceId, conversation, branchesByForkMessageId })
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
    // The board feed scroller (`data-board-scroll-viewport`, virtualized) or a
    // Radix scroll viewport (the conversation panel). Match either so the pinned-
    // header elevation resolves against the real scroll root in both surfaces.
    const root = sentinel.closest("[data-board-scroll-viewport],[data-radix-scroll-area-viewport]")
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
        rowInsetClassName="-mx-3 sm:-mx-4"
        onNewSubtopic={canBranch ? () => inlineComposer.openNewSubtopic(rowStreamId, message.id) : undefined}
        onMoveToSubtopic={moveToSubtopic.moveHandlerFor(message.id, conversation.id)}
      />
    )
  }

  // A nested branch's rows are OUTSIDE this card's conversation: render-only
  // here, so they're wrapped in a null read provider (no mark-read/unread, no
  // auto-read, no unread-dot input — their read state belongs to the child's own
  // surfaces) and identify as the CHILD conversation (copy-link opens its panel).
  const renderBranchMessage = (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => {
    const canBranch = !structuralIndex.threadsByParentMessageId.has(message.id)
    // Per-message spine color: a colored actor (persona gold / bot green / system)
    // overlays its own 2px border onto the branch's neutral rail at that row —
    // covering it at the same width — while a user row stays plain so the neutral
    // grouping rail shows. The row's own accent stripe is suppressed either way.
    // Break out by the rail's padding PLUS its 2px border (`-mx-2.5 sm:-mx-3.5`)
    // so the colored border lands ON the neutral rail, not beside it; `px-2 sm:px-3`
    // re-pads so content aligns with the branch header.
    const rail = actorRowTheme(message.authorType).railClassName
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
          surfaceClassName={rail ? cn("bg-card border-l-2 px-2 sm:px-3", rail) : "bg-card"}
          rowInsetClassName={rail ? "-mx-2.5 sm:-mx-3.5" : undefined}
          suppressRowAccent
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

  // Header chrome shared by both header shapes (title-led and message-led), so
  // the chevron/dot/actions don't get duplicated across the two branches.
  const chevronToggle = (
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
  )
  // Quiet unread dot: the conversation holds an effectively-unread member
  // message. Reserved fixed footprint (no layout shift, INV-21); clears live.
  const unreadDot = (
    <span
      className="flex h-2 w-2 shrink-0 items-center justify-center"
      aria-label={cardHasUnread ? "Unread" : undefined}
    >
      {cardHasUnread && <span className="h-2 w-2 rounded-full bg-primary" />}
    </span>
  )
  const headerActions = (
    <>
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
        streamId={conversation.streamId}
        topicSummary={conversation.topicSummary}
        status={conversation.status}
        triggerClassName="shrink-0"
      />
    </>
  )
  // The stream the post lives in — a real link back into it (INV-40). The leading
  // visual mirrors the sidebar: a DM shows the peer avatar (glyph fallback), every
  // other type shows the tinted glyph tile. `size` scales tile+label for the
  // message-led lead (where the locator IS the headline) vs the demoted locator.
  const locatorLink = (size: "sm" | "xs") => {
    const tileSize = size === "sm" ? "h-6 w-6" : "h-5 w-5"
    const glyph = <TypeIcon className={size === "sm" ? "h-3.5 w-3.5" : "h-3 w-3"} />
    return (
      <Link
        to={`/w/${workspaceId}/s/${streamId}`}
        className="flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
      >
        {dmAvatarUrl ? (
          <Avatar className={cn("shrink-0 rounded-md", tileSize)}>
            <AvatarImage src={dmAvatarUrl} alt={contextLabel} />
            <AvatarFallback className={cn("rounded-md", tileClassName)}>{glyph}</AvatarFallback>
          </Avatar>
        ) : (
          <span className={cn("flex shrink-0 items-center justify-center rounded-md", tileSize, tileClassName)}>
            {glyph}
          </span>
        )}
        <span className={cn("truncate", size === "sm" ? "text-sm font-medium text-foreground" : "font-medium")}>
          {contextLabel}
        </span>
      </Link>
    )
  }
  const subtopicLabel = subtopicCount > 0 && (
    <>
      <span className="shrink-0 opacity-50">·</span>
      <span className="shrink-0">
        {subtopicCount} {subtopicCount === 1 ? "sub-topic" : "sub-topics"}
      </span>
    </>
  )

  return (
    // Scope quote reply to this card: a message row's "Quote reply" routes into
    // this card's own reply composer, not another card's.
    <ConversationReadProvider value={conversationReadValue}>
      <QuoteReplyProvider>
        {/* Desktop text-selection → floating "Quote" button, scoped to this card. */}
        <TextSelectionQuote streamId={streamId} containerRef={cardRef} />
        {moveToSubtopic.moveDialog}
        {/* Rest shadow lifts the card off the page — the light-mode card/bg
            lightness delta is ~1%, so the border alone left cards reading flat.
            Board-scoped; global tokens untouched. Dark leans on a deeper shadow
            since the fill delta reads weakly on the charcoal canvas. */}
        <div
          ref={cardRef}
          className={cn(
            "board-card-lift rounded-xl border bg-card p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_14px_-8px_rgb(0_0_0/0.10)] sm:p-4 dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_6px_16px_-8px_rgb(0_0_0/0.5)]",
            flash && "board-post-flash"
          )}
        >
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
              "z-10 -mx-3 -mt-3 rounded-t-xl border-b border-transparent bg-card px-3 pt-3 pb-2 transition-[box-shadow,border-color] duration-200 sm:sticky sm:top-0 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4",
              headerStuck && "sm:border-border/60 sm:shadow-[0_4px_12px_-6px_rgb(0_0_0/0.4)]"
            )}
          >
            {/* Title-led when the extractor (or a rename) set a topic: the topic is
                the card's headline and the locator (glyph · stream · time) demotes
                to a small line beneath it. A message-led card (no topic) keeps the
                locator AS the lead so it never grows a fake title. A resolved topic
                reads muted with a marker; it also drops out of the Active lens. */}
            {conversation.topicSummary ? (
              <>
                <div className="flex items-center gap-1.5">
                  {chevronToggle}
                  {conversation.status === "resolved" && (
                    <CircleCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Resolved" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[15px] leading-tight tracking-tight",
                      conversation.status === "resolved" ? "font-medium text-muted-foreground" : "font-semibold"
                    )}
                  >
                    {conversation.topicSummary}
                  </span>
                  {unreadDot}
                  {headerActions}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {locatorLink("xs")}
                  <span className="shrink-0 opacity-50">·</span>
                  <RelativeTime date={conversation.lastActivityAt} terse className="shrink-0" />
                  {subtopicLabel}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {chevronToggle}
                {locatorLink("sm")}
                {subtopicLabel}
                <div className="ml-auto flex items-center gap-1.5">
                  {unreadDot}
                  <RelativeTime date={conversation.lastActivityAt} terse className="shrink-0" />
                  {headerActions}
                </div>
              </div>
            )}

            {/* Collapsed: keep scale visible without hiding the whole conversation body. */}
            {bodyCollapsed && (
              <button
                type="button"
                onClick={toggleBodyCollapsed}
                className="mt-2 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {messageCount} {messageCount === 1 ? "message" : "messages"}
                {subtopicCount > 0 && ` · ${subtopicCount} ${subtopicCount === 1 ? "sub-topic" : "sub-topics"}`}
              </button>
            )}
          </div>

          <div
            className={cn(bodyCollapsed && "overflow-hidden")}
            style={
              bodyCollapsed
                ? { maxHeight: collapseToHeight, maskImage: COLLAPSED_FADE_MASK, WebkitMaskImage: COLLAPSED_FADE_MASK }
                : undefined
            }
          >
            <div ref={bodyRef}>
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
                  onRedirectSession={openReplyComposer}
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
                      onClick={() => {
                        beginReveal()
                        setExpanded(true)
                      }}
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
                    onRedirectSession={openReplyComposer}
                  />
                </>
              )}
            </div>

            {!bodyCollapsed && (
              <BoardReplyComposer
                workspaceId={workspaceId}
                post={post}
                hostStreamType={streamType}
                openReplySignal={openReplySignal}
                contextChip={conversation.topicSummary ?? contextLabel}
                // The conversation's most-recently-active stream — the latest displayed
                // reply's own stream (a thread under the root), INCLUDING the viewer's own
                // pending reply and any expand-backfilled rows, so a continuation follows
                // the conversation into the thread it moved to instead of re-interleaving
                // the channel. `displayedReplies` is chronological; its last entry is the
                // freshest activity. Falls back to the conversation's own stream — NOT the
                // opening message's, which for a thread post is the parent-stream message.
                lastActiveStreamId={displayedReplies.at(-1)?.streamId ?? streamId}
              />
            )}
          </div>
        </div>
      </QuoteReplyProvider>
    </ConversationReadProvider>
  )
}
