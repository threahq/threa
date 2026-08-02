import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { RefObject } from "react"
import { Link } from "react-router-dom"
import type { VirtualizerHandle } from "virtua"
import { ChevronDown, ChevronRight, CircleCheck, PanelRight } from "lucide-react"
import {
  DEFAULT_BOARD_CARD_COLLAPSE_AT_HEIGHT,
  DEFAULT_BOARD_CARD_COLLAPSE_TO_HEIGHT,
  DEFAULT_BOARD_FULL_TAIL_COUNT,
  DEFAULT_BOARD_LEDGER_ROWS,
  DEFAULT_BOARD_LEAD_LINE_LENGTH,
} from "@threa/types"
import { RelativeTime } from "@/components/relative-time"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { actorRowTheme } from "@/components/message/actor-row-theme"
import { buildBranchedBoardRows } from "@/components/board/board-row-item"
import {
  BranchedBoardRows,
  BranchProvenanceRow,
  BRANCH_SETTLING_RAIL_CLASS,
  BRANCH_ACCENTED_SETTLING_RAIL_CLASS,
} from "@/components/board/branch-rows"
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
import { DeletedMessageEvent } from "@/components/timeline/deleted-message-event"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { useActors, useVisibleStreams } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useBoardFlash } from "@/stores/board-flash-store"
import { usePanel, createConversationPanelId, usePreferences } from "@/contexts"
import { useBoardCardCollapse } from "@/hooks/use-board-card-collapse"
import { useSplitThread } from "@/hooks/use-conversations"
import { applySettlingAll, useBoardCardMessages } from "@/hooks/use-board-card-messages"
import { useConversationBackfill } from "@/hooks/use-conversation-backfill"
import { useInlineBranchComposer } from "@/components/board/use-inline-branch-composer"
import { useBoardCardRevealAnchor } from "@/hooks/use-board-card-reveal-anchor"
import { LedgerRow } from "@/components/board/ledger-row"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { localStartOfDayMs } from "@/lib/dates"
import type { BoardViewPost } from "@/hooks/use-stable-board-view"
import { Skeleton } from "@/components/ui/skeleton"
import { MESSAGE_ROW_CONTINUATION_PADDING, MESSAGE_ROW_HEAD_PADDING } from "@/components/message/message-row-layout"

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
  /** The board's owned scroll viewport — lets a card that grows from older content
   *  hold the newest replies still instead of shoving them down
   *  (`useBoardCardRevealAnchor`).
   *  Absent when the card renders outside the virtualized board (tests). */
  scrollerRef?: RefObject<HTMLDivElement | null>
  /** virtua's imperative handle for the board feed, paired with `scrollerRef`. */
  listRef?: RefObject<VirtualizerHandle | null>
  /**
   * Render the card inert: the conversation it stands for is gone (merged away
   * or emptied), so the content stays — the row keeps its exact footprint — but
   * nothing in it is interactive, no composer opens, and auto-read never fires a
   * read POST at a dead conversation. `BoardRemovedCard` owns the overlay that
   * explains the state; this only makes the card underneath dead weight.
   */
  removed?: boolean
  /** Fired ONCE, on the card's first intersection with the viewport — "the viewer
   *  has laid eyes on this card in this session". Drives the board's re-buffering:
   *  an unseen card that gains activity goes back behind the "N new" pill. */
  onSeen?: () => void
}

/** How many trailing messages a nested branch previews on a collapsed card; the
 *  hidden rest sits behind an "N more replies" link into the child's panel. */
const BRANCH_PREVIEW_CAP = 2

const EMPTY_EXPANDED: Set<string> = new Set()

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
 * conversation (no reply indentation); the reply region is the ledger — the
 * newest replies stay full rows, older ones collapse to lead lines that expand
 * in place. The stream it lives in is the header locator, not a topic line.
 */
export function BoardCard({
  workspaceId,
  post,
  contextLabel,
  streamType,
  dmPeerUserId,
  scrollerRef,
  listRef,
  removed = false,
  onSeen,
}: BoardCardProps) {
  const { conversation } = post
  const flash = useBoardFlash(conversation.id)
  const { getActorName, getActorAvatar } = useActors(workspaceId)
  const currentUserId = useWorkspaceUserId(workspaceId)
  const { openPanel, getPanelUrl } = usePanel()
  // A running session's Redirect bumps this nonce to expand + focus the card's
  // reply composer in place (its editor is collapsed until opened, so there's no
  // DOM zone to walk to). A counter, not a boolean, so a repeat Redirect re-opens
  // it after a manual collapse.
  const [openReplySignal, setOpenReplySignal] = useState(0)
  const openReplyComposer = useCallback(() => setOpenReplySignal((n) => n + 1), [])
  // Scopes text-selection quoting to this card so a selection routes into this
  // card's composer, not a sibling card's provider.
  const cardRef = useRef<HTMLDivElement>(null)
  // Older rows landing above the full tail (backfill / late sync) insert INSIDE
  // one virtua item, so nothing compensates the jump. The card arms the reveal
  // window for exactly the backfill's flight (`beginReveal` on the in-flight
  // rising edge below, landmarked on the first full-tail row) and holds it open
  // through `loadingMoreRef` — which mirrors `loadingMore` (computed below, after
  // the rail) so the hook reads it at settle time without re-subscribing.
  const loadingMoreRef = useRef(false)
  const { beginReveal, closeReveal } = useBoardCardRevealAnchor({
    cardRef,
    scrollerRef,
    listRef,
    shouldHoldOpen: useCallback(() => loadingMoreRef.current, []),
  })
  // Which ledger rows the reader has opened into full messages. Recycling this
  // card instance onto another conversation resets the set — the conversation id
  // lives IN the state (not a ref) so a discarded render can't strand the reset.
  const [ledgerExpansion, setLedgerExpansion] = useState<{ conversationId: string; expanded: Set<string> }>({
    conversationId: conversation.id,
    expanded: EMPTY_EXPANDED,
  })
  if (ledgerExpansion.conversationId !== conversation.id)
    setLedgerExpansion({ conversationId: conversation.id, expanded: EMPTY_EXPANDED })
  const expandedRowIds = ledgerExpansion.conversationId === conversation.id ? ledgerExpansion.expanded : EMPTY_EXPANDED
  // The full tail is MONOTONE for the card's life on one conversation: the row
  // that opened it stays its first row, so a message rendered full never demotes
  // to a lead (which would unmount its MessageItem — losing an open edit buffer,
  // menu or selection) and a newer arrival simply extends the tail. Only the
  // FIRST full row is remembered; everything at or after it is full, so an older
  // row inserted above (backfill) lands in the ledger where it belongs.
  // `boardFullTailCount` therefore sizes the INITIAL tail, not a rolling window.
  const [fullTailAnchor, setFullTailAnchor] = useState<{ conversationId: string; messageId: string | null }>({
    conversationId: conversation.id,
    messageId: null,
  })
  if (fullTailAnchor.conversationId !== conversation.id)
    setFullTailAnchor({ conversationId: conversation.id, messageId: null })
  const toggleLedgerRow = useCallback(
    (messageId: string) =>
      setLedgerExpansion((current) => {
        const base = current.conversationId === conversation.id ? current.expanded : EMPTY_EXPANDED
        const expanded = new Set(base)
        if (!expanded.delete(messageId)) expanded.add(messageId)
        return { conversationId: conversation.id, expanded }
      }),
    [conversation.id]
  )

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
    settlingIds,
    knownMessageIds,
    railCoversMembership,
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
  // Ledger density: how many newest replies stay full rows, how many ledger lines
  // sit above them, and how long a collapsed lead runs.
  const fullTailCount = Math.max(0, preferences?.boardFullTailCount ?? DEFAULT_BOARD_FULL_TAIL_COUNT)
  const ledgerRowLimit = Math.max(0, preferences?.boardLedgerRows ?? DEFAULT_BOARD_LEDGER_ROWS)
  const leadLineLength = preferences?.boardLeadLineLength ?? DEFAULT_BOARD_LEAD_LINE_LENGTH
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
  // own-authored rows are excluded inside `hasUnread`. A tombstone is visible but
  // counts as zero: a message added and deleted before you look at it is no new
  // message, so it never lights the dot — excluded here exactly as it is from
  // `autoReadRows` below, keeping "what lights the dot" and "what can clear it"
  // the same set.
  const knownMessages = useMemo(
    () => (openingMessage ? [openingMessage, ...railReplies] : railReplies).filter((m) => !m.deletedAt),
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
      const shown = rows.slice(-BRANCH_PREVIEW_CAP)
      // Server-known members not shown (locally missing, or under the collapsed
      // window) count toward the "N more replies" link into the child's panel.
      const knownTotal = Math.max(branchMemberIds.length, rows.length)
      return { messages: shown, hiddenCount: Math.max(0, knownTotal - shown.length) }
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
  const moveToSubtopic = useMoveToSubtopic({
    workspaceId,
    conversation,
    branchesByForkMessageId,
    hasSettlingRows: settlingIds.size > 0,
  })
  // A spanning-overflow row from a card opens the whole conversation in the panel.
  const continueThreadTo = () => getPanelUrl(createConversationPanelId(conversation.id))
  // Heal a soft-thread seam into its own topic (the card re-forms as a nested
  // branch group via the conversation:created/updated sync).
  const splitThread = useSplitThread(workspaceId)
  const onSplitThread = (threadStreamId: string) =>
    splitThread.mutate({ conversationId: conversation.id, threadStreamId })

  // The rail carries every locally-synced reply; older ones (or a wholly unsynced
  // stream — `source === "projection"`) may be missing. The ledger shows up to
  // `ledgerRowLimit` older rows, so the card wants the whole hydrated set, not
  // just a trailing preview — the backfill arms whenever the rail is short (the
  // hook self-gates on rail coverage, so a complete rail fetches nothing). Never
  // blocks the first render: the local replies show immediately.
  const incompleteLocally = source === "projection" || railReplies.length < totalReplies
  // The card is a first-class reading surface (live message bodies, viewport
  // auto-read below), so while any part of it is on screen its streams count
  // as visible for push suppression — otherwise a push banners the exact
  // message the user is reading on the board. Viewport-gated (not mount-gated)
  // so off-screen cards on a long board don't suppress streams the user can't
  // see. The same signal gates the backfill below.
  const [cardInViewport, setCardInViewport] = useState(false)
  // Same observer answers "has the viewer seen this card" (`onSeen`, first
  // intersection only) — seen-ness is latched in a ref so a later re-intersection
  // can't re-fire it, and the callback is held in a ref so the observer isn't
  // torn down when the parent hands a fresh closure.
  const onSeenRef = useRef(onSeen)
  onSeenRef.current = onSeen
  const seenFiredRef = useRef(false)
  useEffect(() => {
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => {
      setCardInViewport(entry.isIntersecting)
      if (entry.isIntersecting && !seenFiredRef.current) {
        seenFiredRef.current = true
        onSeenRef.current?.()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Without an IntersectionObserver (jsdom, ancient engines) there is no viewport
  // truth to gate on — fail open rather than never fetching at all.
  const viewportUnknown = typeof IntersectionObserver === "undefined"
  // Two gates beyond "the rail is short": the card's rail has actually READ (a
  // projection-sourced card is still resolving, and its incompleteness is an
  // artifact of that, not a real gap — every mounted card fetching on mount was
  // the #1640 cost class), and the card is on screen.
  const backfillEnabled =
    !removed && source !== "projection" && incompleteLocally && (cardInViewport || viewportUnknown)
  const {
    data: allMessages,
    isError: expandFailed,
    refetch: refetchMessages,
  } = useConversationBackfill(workspaceId, conversation.id, {
    enabled: backfillEnabled,
    railCoversMembership,
    memberIds: conversation.messageIds,
    knownMessageIds,
  })

  const replies: RenderableMessage[] = railReplies
  // Merge this card's own just-sent replies with the confirmed set, skipping any
  // the rail or a backfill already carries, then sort by time: a pending reply
  // can be OLDER than a confirmed one (someone else's reply lands while yours is
  // still in flight), so appending blindly would render it out of order.
  const seenReplyIds = new Set(replies.map((m) => m.id))
  // The hook stamps settling on its own rows; the server backfill above bypasses
  // it, so the merged list runs through the same helper (rows already marked come
  // back by identity).
  const displayedReplies = applySettlingAll(
    [...replies, ...pendingReplies.filter((m) => !seenReplyIds.has(m.id))].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    ),
    settlingIds
  )
  // The reply region IS the ledger: the newest `fullTailCount` replies keep the
  // full message row (reactions, actions, settling affordances); everything older
  // that fits in `ledgerRowLimit` renders as a collapsed ledger line, and the mass
  // above that collapses into one head row into the panel.
  // Monotone: once a row opened the tail it stays its first row, so the partition
  // only ever grows downward. A remembered anchor that has left the window (moved
  // away, re-filed) falls back to a fresh newest-N partition, which the effect
  // below re-remembers.
  const anchorId = fullTailAnchor.conversationId === conversation.id ? fullTailAnchor.messageId : null
  const anchorIndex = anchorId === null ? -1 : displayedReplies.findIndex((m) => m.id === anchorId)
  const tailStart = anchorIndex >= 0 ? anchorIndex : Math.max(0, displayedReplies.length - fullTailCount)
  const ledgerCandidates = displayedReplies.slice(0, tailStart)
  const fullTailReplies = displayedReplies.slice(tailStart)
  const ledgerReplies =
    ledgerCandidates.length > ledgerRowLimit ? ledgerCandidates.slice(-ledgerRowLimit) : ledgerCandidates
  const hiddenOlder = ledgerCandidates.slice(0, ledgerCandidates.length - ledgerReplies.length)
  const ledgerIds = new Set(ledgerReplies.map((m) => m.id))
  const visibleReplies = [...ledgerReplies, ...fullTailReplies]
  const firstFullTailId = fullTailReplies[0]?.id ?? null
  // Commit the partition's first row after render, never during it.
  useEffect(() => {
    if (firstFullTailId === null) return
    setFullTailAnchor((current) =>
      current.conversationId === conversation.id && current.messageId === firstFullTailId
        ? current
        : { conversationId: conversation.id, messageId: firstFullTailId }
    )
  }, [conversation.id, firstFullTailId])
  // `totalReplies` counts tombstones as zero, so the rendered rows are counted the
  // same way — replies the rail hasn't synced at all are earlier mass too.
  const unsyncedOlder = Math.max(0, totalReplies - displayedReplies.filter((m) => !m.deletedAt).length)
  const earlierCount = hiddenOlder.length + unsyncedOlder
  // The backfill can outrun the local rail while the head row stands for rows only
  // the server has; the wait and its retry take that same single row, so nothing
  // below them shifts through either state (INV-21). Both are gated on there being
  // unsynced older replies at all — a card whose whole conversation is on screen
  // must never flip through a "Loading older messages…" row it has no use for
  // (the flip would also swap the rows between the two render shapes below).
  // Gated on the backfill actually being ARMED, not merely on the rail being
  // short: an unarmed card (off-screen, rail unresolved) would otherwise sit under
  // a "Loading older messages…" label with no request behind it, forever.
  const loadingMore = unsyncedOlder > 0 && backfillEnabled && !allMessages && !expandFailed
  loadingMoreRef.current = loadingMore
  // The rows that backfill brings land ABOVE the full tail, inside this one virtua
  // item. Arm the reveal window on the flight's rising edge, landmarked on the
  // tail's first row — monotone above, so the element stays put for the whole
  // window — and let `shouldHoldOpen` (loadingMoreRef) keep it open until the rows
  // land. Idle card: never armed, so a live tail reply still pushes normally.
  const revealArmedRef = useRef(false)
  useEffect(() => {
    if (!loadingMore) {
      revealArmedRef.current = false
      return
    }
    if (revealArmedRef.current) return
    revealArmedRef.current = true
    const landmark =
      firstFullTailId === null
        ? null
        : (cardRef.current?.querySelector<HTMLElement>(`[data-message-row][data-message-id="${firstFullTailId}"]`) ??
          null)
    beginReveal({ mode: "scroll", landmark })
  }, [loadingMore, firstFullTailId, beginReveal])
  const failedOlder = unsyncedOlder > 0 && expandFailed
  // Nothing sits above the ledger, so opening + replies form one uninterrupted run
  // that groups across the boundary. Otherwise a head row sits between them.
  const contiguous = earlierCount === 0 && !loadingMore && !failedOlder
  // Device-local (INV-42). A range inside one day reads as times; across days the
  // date carries it, since two clock times would say nothing about the span.
  const { formatTime, formatDate } = useFormattedDate()
  let earlierLabel = `${earlierCount} earlier`
  if (hiddenOlder.length > 0) {
    const first = new Date(hiddenOlder[0].createdAt)
    const last = new Date(hiddenOlder[hiddenOlder.length - 1].createdAt)
    const sameDay = localStartOfDayMs(first) === localStartOfDayMs(last)
    const render = (date: Date) => (sameDay ? formatTime(date) : formatDate(date))
    earlierLabel = `${earlierCount} earlier · ${render(first)} → ${render(last)}`
  }

  // Viewport auto-read: rows that dwell on screen mark themselves read (the menu
  // actions are the override). Every rendered row is eligible — on a collapsed
  // card the cutoff through a trailing-preview row also covers the hidden "N
  // more" middle, deliberately: the card IS the conversation surface, so reading
  // its visible tail reads the conversation up to there, exactly like invoking
  // "Mark as read up to here" on that row (Kris's dogfood ruling on PR #1174 —
  // having the conversation open is enough to mark it).
  // A tombstone counts as zero for unread, so it must not carry read state either
  // way — keep it out of the auto-read set entirely.
  // The ledger does NOT change this: a lead mounts no `data-message-row`, so it
  // never dwells as an observed row, but the cutoff through a read tail row still
  // covers the older leads beneath it — whole-card read, exactly as before the
  // ledger. Lead-granular read waits for sparse-read.
  const autoReadRows = (openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies).filter(
    (m) => !m.deletedAt
  )
  useConversationAutoRead({
    containerRef: cardRef,
    messages: autoReadRows,
    rootStreamId: streamId,
    rowState: conversationReadValue.state,
    markRead: markReadSilently,
    registerExplicitUnread: setExplicitUnreadListener,
    getReadTruth,
    disabled: removed,
  })

  // A programmatic jump (the "N new" pill sets scrollTop to 0) doesn't fire the
  // gesture listeners that disarm the hold, so an armed window on a card that just
  // left the viewport would scroll the feed back toward it when its growth lands.
  // A card taller than the viewport keeps intersecting mid-walk, so a genuine walk
  // is unaffected.
  useEffect(() => {
    if (!cardInViewport) closeReveal()
  }, [cardInViewport, closeReveal])

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

  // One row above the ledger, whatever it says: the earlier mass, the wait for it,
  // or its failure — so nothing below shifts as the state changes (INV-21). The
  // head row is a link into the panel, where the whole conversation reads
  // coherently.
  let ledgerHeadRow = (
    <Link
      to={continueThreadTo()}
      className="mt-3 block w-fit text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {earlierLabel}
    </Link>
  )
  if (loadingMore)
    ledgerHeadRow = <span className="mt-3 block text-xs text-muted-foreground">Loading older messages…</span>
  if (failedOlder)
    ledgerHeadRow = (
      <button
        type="button"
        onClick={() => void refetchMessages()}
        className="mt-3 block w-fit text-xs text-destructive underline underline-offset-2"
      >
        Couldn't load older messages. Retry.
      </button>
    )

  const renderMessage = (message: RenderableMessage, continuation: boolean) => {
    // A ledger line, not a full row: collapsed it carries `data-ledger-row` and no
    // `data-message-row`, so viewport auto-read (which matches the latter) never
    // counts a lead as a read row. Expanding mounts the real MessageItem, which
    // brings the attribute — and the read participation — back with it.
    if (ledgerIds.has(message.id))
      return (
        <LedgerRow
          key={message.id}
          workspaceId={workspaceId}
          streamId={message.streamId ?? streamId}
          message={message}
          authorName={getActorName(message.authorId, message.authorType)}
          currentUserId={currentUserId}
          expanded={expandedRowIds.has(message.id)}
          onToggle={() => toggleLedgerRow(message.id)}
          leadLineLength={leadLineLength}
          conversationId={conversation.id}
          conversationRootStreamId={conversation.streamId}
          onNewSubtopic={
            structuralIndex.threadsByAnchorId.has(message.id)
              ? undefined
              : () => inlineComposer.openNewSubtopic(message.streamId ?? streamId, message.id)
          }
          onMoveToSubtopic={moveToSubtopic.moveHandlerFor(message.id, conversation.id, message.settling)}
        />
      )
    // Mirrors the panel: a deleted row is a tombstone, never a blank MessageItem
    // carrying an author, a timestamp and an action menu. It still carries the
    // row attributes so the reveal anchor can landmark it when it is the first
    // visible reply.
    if (message.deletedAt)
      return (
        <div key={message.id} data-message-row data-message-id={message.id}>
          <DeletedMessageEvent />
        </div>
      )
    // A conversation can span its root + threads (one root); render each row
    // against its own stream so reactions and the permalink target where the
    // message actually lives, falling back to the card's anchor stream.
    const rowStreamId = message.streamId ?? streamId
    // "New sub-topic" only where a fresh branch is valid: hide it once a thread
    // already exists under the message (a populated thread would mix membership —
    // "Split this thread" is the gesture there, adjustment D).
    const canBranch = !structuralIndex.threadsByAnchorId.has(message.id)
    // Adjacency is computed over the raw run, so a full row whose predecessor
    // collapsed to a lead would inherit `continuation` from a row that shows no
    // author — the tail would open headerless. The first full row after any
    // ledger line always carries its own header.
    const isTailHead = message.id === firstFullTailId && ledgerReplies.length > 0
    return (
      <MessageItem
        key={message.id}
        workspaceId={workspaceId}
        streamId={rowStreamId}
        message={message}
        authorName={getActorName(message.authorId, message.authorType)}
        currentUserId={currentUserId}
        continuation={continuation && !isTailHead}
        conversationId={conversation.id}
        conversationRootStreamId={conversation.streamId}
        // Break the row out of the card's p-3/p-4 padding and pad the content back in,
        // so an actor accent fills to the card edges (stream-view look) with rows aligned.
        surfaceClassName="bg-card px-3 sm:px-4"
        rowInsetClassName="-mx-3 sm:-mx-4"
        onNewSubtopic={canBranch ? () => inlineComposer.openNewSubtopic(rowStreamId, message.id) : undefined}
        onMoveToSubtopic={moveToSubtopic.moveHandlerFor(message.id, conversation.id, message.settling)}
      />
    )
  }

  // A nested branch's rows are OUTSIDE this card's conversation: render-only
  // here, so they're wrapped in a null read provider (no mark-read/unread, no
  // auto-read, no unread-dot input — their read state belongs to the child's own
  // surfaces) and identify as the CHILD conversation (copy-link opens its panel).
  const renderBranchMessage = (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => {
    const canBranch = !structuralIndex.threadsByAnchorId.has(message.id)
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
          settlingRailClassName={rail ? BRANCH_ACCENTED_SETTLING_RAIL_CLASS : BRANCH_SETTLING_RAIL_CLASS}
          suppressRowAccent
          onNewSubtopic={
            canBranch
              ? () => inlineComposer.openNewSubtopic(message.streamId ?? branch.threadStreamId, message.id)
              : undefined
          }
          onMoveToSubtopic={
            branch.pending
              ? undefined
              : moveToSubtopic.moveHandlerFor(message.id, branch.conversationId, message.settling)
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
            since the fill delta reads weakly on the charcoal canvas.
            Removed cards use `inert`, not pointer-events-none + aria-hidden: only
            inert also removes the card's buttons and composer from the tab order —
            a keyboard user could otherwise focus into the dead conversation. */}
        <div
          ref={cardRef}
          className={cn(
            "board-card-hover rounded-xl border bg-card p-3 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_14px_-8px_rgb(0_0_0/0.10)] sm:p-4 dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_6px_16px_-8px_rgb(0_0_0/0.5)]",
            flash && "board-post-flash",
            removed && "opacity-60"
          )}
          inert={removed || undefined}
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
                  rows={branchRows(openingMessage ? [openingMessage, ...visibleReplies] : visibleReplies)}
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
                  {ledgerHeadRow}
                  <BranchedBoardRows
                    rows={branchRows(visibleReplies)}
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

            {/* Rendered even when `removed`: the inert layer above kills interaction,
                and dropping the composer would shrink the row — the live→removed swap
                must hold the card's exact footprint. */}
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

/** Head/continuation shape of a placeholder card's message run. */
const CARD_SKELETON_ROWS: { continuation: boolean; width: string }[] = [
  { continuation: false, width: "w-11/12" },
  { continuation: true, width: "w-3/4" },
]

/**
 * The board's loading shape, defined beside the card it stands in for and built
 * from the card's own chrome (`rounded-xl border bg-card p-3 sm:p-4`, the
 * `-mx-3 sm:-mx-4` row break-out, `MESSAGE_ROW_*_PADDING`, the `md` avatar box)
 * so the swap to a real card moves nothing (INV-21).
 */
export function BoardCardSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border bg-card p-3 sm:p-4">
      <div className="-mx-3 -mt-3 px-3 pt-3 pb-2 sm:-mx-4 sm:-mt-4 sm:px-4 sm:pt-4">
        <div className="flex items-center gap-1.5">
          <div className="h-4 w-4 shrink-0" />
          <Skeleton className="h-[18px] w-3/5" />
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      {CARD_SKELETON_ROWS.map((row, i) => (
        <div key={i} className="-mx-3 sm:-mx-4">
          <div
            className={cn(
              "flex items-start gap-3 px-3 sm:px-4",
              row.continuation ? MESSAGE_ROW_CONTINUATION_PADDING : MESSAGE_ROW_HEAD_PADDING
            )}
          >
            {row.continuation ? (
              <div className="h-8 w-8 shrink-0" />
            ) : (
              <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
            )}
            <div className="min-w-0 flex-1">
              {!row.continuation && (
                <div className="mb-0.5 flex items-baseline gap-2">
                  <Skeleton className="h-5 w-28" />
                </div>
              )}
              <Skeleton className={cn("h-[22px]", row.width)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
