import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { Hash, FileEdit, User, MessageSquareText, ChevronDown, PanelRight, type LucideIcon } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { MessageItem, type RenderableMessage } from "@/components/message/message-item"
import { buildBoardRows, BoardEventRowItem } from "@/components/board/board-row-item"
import { resolveBoardEventRows } from "@/lib/board/board-event-rows"
import { ConversationReadProvider, useConversationReadController } from "@/components/message/conversation-read-context"
import { useConversationAutoRead } from "@/components/message/use-conversation-auto-read"
import { BoardReplyComposer } from "@/components/board/board-reply-composer"
import { QuoteReplyProvider } from "@/components/timeline/quote-reply-context"
import { TextSelectionQuote } from "@/components/timeline/text-selection-quote"
import { useActors, useVisibleStreams } from "@/hooks"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useConversationService, usePanel, createConversationPanelId } from "@/contexts"
import { conversationKeys } from "@/hooks/use-conversations"
import { useBoardCardMessages, useStableReplyWindow } from "@/hooks/use-board-card-messages"
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
  const { openPanel } = usePanel()
  const [expanded, setExpanded] = useState(false)
  // Scopes text-selection quoting to this card so a selection routes into this
  // card's composer, not a sibling card's provider.
  const cardRef = useRef<HTMLDivElement>(null)

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
  } = useBoardCardMessages(post, streamType)

  const streamId = conversation.streamId
  const ContextGlyph = (streamType && TYPE_GLYPH[streamType]) || MessageSquareText

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
  const cardVisibleStreamIds = useMemo(
    () => (cardInViewport ? [...new Set([streamId, ...(post.streamIds ?? [])])] : []),
    [cardInViewport, streamId, post.streamIds]
  )
  useVisibleStreams(cardVisibleStreamIds)

  const renderMessage = (message: RenderableMessage, continuation: boolean) => (
    <MessageItem
      key={message.id}
      workspaceId={workspaceId}
      // A conversation can span its root + threads (one root); render each row
      // against its own stream so reactions and the permalink target where the
      // message actually lives, falling back to the card's anchor stream.
      streamId={message.streamId ?? streamId}
      message={message}
      authorName={getActorName(message.authorId, message.authorType)}
      currentUserId={currentUserId}
      continuation={continuation}
      conversationId={conversation.id}
      conversationRootStreamId={conversation.streamId}
      surfaceClassName="bg-card"
    />
  )

  return (
    // Scope quote reply to this card: a message row's "Quote reply" routes into
    // this card's own reply composer, not another card's.
    <ConversationReadProvider value={conversationReadValue}>
      <QuoteReplyProvider>
        {/* Desktop text-selection → floating "Quote" button, scoped to this card. */}
        <TextSelectionQuote streamId={streamId} containerRef={cardRef} />
        <div ref={cardRef} className="rounded-xl border bg-card p-3 sm:p-4">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
          </div>

          <div className="mt-3 [&>*:first-child]:mt-0">
            {contiguous ? (
              buildBoardRows(openingMessage ? [openingMessage, ...displayedReplies] : displayedReplies, eventRows).map(
                (row) =>
                  row.kind === "message" ? (
                    renderMessage(row.message, row.continuation)
                  ) : (
                    <BoardEventRowItem key={row.key} row={row.row} workspaceId={workspaceId} />
                  )
              )
            ) : (
              <>
                {openingMessage && renderMessage(openingMessage, false)}
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
                {buildBoardRows(displayedReplies, eventRows).map((row) =>
                  row.kind === "message" ? (
                    renderMessage(row.message, row.continuation)
                  ) : (
                    <BoardEventRowItem key={row.key} row={row.row} workspaceId={workspaceId} />
                  )
                )}
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
        </div>
      </QuoteReplyProvider>
    </ConversationReadProvider>
  )
}
