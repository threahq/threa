import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import {
  LabelableResourceTypes,
  type AttachmentSummary,
  type AuthorType,
  type LinkPreviewSummary,
  type StreamType,
} from "@threa/types"
import { ActorAvatar } from "@/components/actor-avatar"
import { RelativeTime } from "@/components/relative-time"
import { MarkdownContent, AttachmentProvider } from "@/components/ui/markdown-content"
import { LinkPreviewProvider } from "@/lib/markdown/link-preview-context"
import { AttachmentList } from "@/components/timeline/attachment-list"
import { LinkPreviewList } from "@/components/timeline/link-preview-list"
import { MemoPreviewList } from "@/components/timeline/memo-preview-list"
import { GiphyPreviewList } from "@/components/timeline/giphy-preview-list"
import { MessageReactions } from "@/components/timeline/message-reactions"
import { MessageContextMenu } from "@/components/timeline/message-context-menu"
import { MessageActionDrawer } from "@/components/timeline/message-action-drawer"
import { ReactionEmojiPicker } from "@/components/timeline/reaction-emoji-picker"
import type { MessageActionContext } from "@/components/timeline/message-actions"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks/use-message-reactions"
import { LabelStack } from "@/components/labels/label-stack"
import { LabelPicker } from "@/components/labels/label-picker"
import { useUserProfile } from "@/components/user-profile"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"
import { useStreamFromStore } from "@/stores/stream-store"
import { STREAM_ICONS, streamFallbackLabel } from "@/lib/streams"
import { cn } from "@/lib/utils"

/** Label for the "View in …" jump action. Uses the shared stream-type noun
 * ("channel"/"thread"/"DM"/"scratchpad") when the row's stream is cached; a
 * type-neutral phrase otherwise, so an uncached thread row never mislabels as
 * "channel". */
function viewInStreamLabel(type: StreamType | undefined): string {
  return type ? `View in ${streamFallbackLabel(type, "noun")}` : "Go to message"
}

/** Same-author messages within this window collapse into a continuation (no
 * repeated header) — matches the timeline's grouping. */
export const GROUP_WINDOW_MS = 5 * 60_000

/**
 * The fields {@link MessageItem} reads. A lean rendering shape satisfied by the
 * board feed payload (`BoardPostMessage`), a labeled message (`LabeledMessage`),
 * and a full `Message` alike — anything that can show a message outside the
 * stream timeline.
 */
export interface RenderableMessage {
  id: string
  /** The stream this message lives in. A board conversation can span its root +
   * threads (one root), so a card renders each row against its own stream — the
   * caller passes `message.streamId ?? <card stream>` to {@link MessageItem}. */
  streamId?: string
  authorId: string
  authorType: AuthorType
  contentMarkdown: string
  reactions: Record<string, string[]>
  createdAt: string | Date
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
}

export function isContinuation(prev: RenderableMessage, cur: RenderableMessage): boolean {
  return (
    prev.authorId === cur.authorId &&
    prev.authorType === cur.authorType &&
    Math.abs(new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime()) < GROUP_WINDOW_MS
  )
}

interface MessageItemProps {
  workspaceId: string
  streamId: string
  message: RenderableMessage
  authorName: string
  currentUserId: string | null
  /** A same-author follow-up: drop the avatar/header and align the body under
   * the head row's content (matches the timeline's grouped continuations). */
  continuation?: boolean
  /** Opt-in origin-stream chip in the header, right of the timestamp. Set on the
   * label page (messages span streams, so each row names its origin); the board
   * leaves it off because it shows the stream at the card level. */
  streamLabel?: { name: string; type: StreamType }
  /** The conversation this row belongs to, set by the conversation surfaces
   * (board card, conversation panel). Makes "Copy link" emit a conversation-panel
   * link instead of the stream permalink; the label page leaves it unset. */
  conversationId?: string
  /** Scroll this row into view and flash it — the conversation panel sets it for
   * the `?m=` deep-link target so a shared message link lands on the right row. */
  isHighlighted?: boolean
}

/**
 * One message rendered outside the stream timeline — the unit shared by the
 * board feed and the label landing page. Uses the same primitives as the
 * timeline (`ActorAvatar`, `MarkdownContent`, `MessageReactions`, same
 * same-author grouping) so a board/label message is indistinguishable from a
 * real one. Carries its own labels (`LabelStack`, renders nothing until there's
 * one) and the timeline's action surface: a hover overflow menu on desktop and
 * a long-press action drawer on touch. The timestamp permalinks back into the
 * message's own stream context.
 */
export function MessageItem({
  workspaceId,
  streamId,
  message,
  authorName,
  currentUserId,
  continuation,
  streamLabel,
  conversationId,
  isHighlighted,
}: MessageItemProps) {
  const { formatTime, formatFull } = useFormattedDate()
  const { openUserProfile } = useUserProfile()
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false)
  // Touch reaches the actions via long-press → the same `MessageActionDrawer`
  // the timeline uses; the hover overflow button is desktop/keyboard only. This
  // mirrors `SentMessageEvent` rather than exposing a tap-sized dropdown.
  const touchCapable = useTouchCapable()
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({ onLongPress: openDrawer, enabled: touchCapable, deferToNativeLinks: true })
  const hasReactions = Object.keys(message.reactions).length > 0
  // Users open their profile on click (same as the timeline); other actor types
  // (persona/bot/system) are non-interactive.
  const interactiveName = message.authorType === "user" && Boolean(message.authorId)
  const attachments = message.attachments ?? []
  const linkPreviews = message.linkPreviews ?? []
  // The row's own stream — only to pick the "View in channel/thread/…" noun.
  const rowStream = useStreamFromStore(streamId)

  // Reactions are self-contained on any surface (no thread/composer context),
  // so the out-of-stream row gets the same add/toggle path the timeline uses.
  const { toggleByEmoji } = useMessageReactions(workspaceId, message.id)
  const handleAddReaction = useCallback(
    (emoji: string) => toggleByEmoji(emoji, message.reactions, currentUserId),
    [toggleByEmoji, message.reactions, currentUserId]
  )
  const activeReactionShortcodes = useMemo(() => {
    if (!currentUserId) return new Set<string>()
    const active = new Set<string>()
    for (const [shortcode, userIds] of Object.entries(message.reactions)) {
      if (userIds.includes(currentUserId)) active.add(stripColons(shortcode))
    }
    return active
  }, [currentUserId, message.reactions])
  const allReactionShortcodes = useMemo(() => reactionShortcodes(message.reactions), [message.reactions])

  // Scroll + flash the `?m=` deep-link target (conversation panel sets
  // `isHighlighted`). Mirrors the timeline's highlight effect.
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (isHighlighted && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [isHighlighted])

  // Reactions/copy/label plus copy-link (surface-specific via `conversationId`)
  // and "View in channel/thread/…". `isThreadParent: true` suppresses "Reply in
  // thread" (no thread context here); `currentUserId` powers react toggling —
  // edit/delete stay hidden because this surface supplies no edit/delete handler
  // (their `when` gates require one). Quote/reply are deferred (no composer
  // context on board/conversation surfaces yet).
  const menuContext: MessageActionContext = {
    contentMarkdown: message.contentMarkdown,
    actorType: message.authorType,
    authorId: message.authorId,
    currentUserId: currentUserId ?? undefined,
    isThreadParent: true,
    replyUrl: "",
    messageId: message.id,
    workspaceId,
    streamId,
    conversationId,
    reactions: message.reactions,
    onReact: handleAddReaction,
    onOpenFullPicker: () => setMobilePickerOpen(true),
    viewInStream: {
      href: `/w/${workspaceId}/s/${streamId}?m=${message.id}`,
      label: viewInStreamLabel(rowStream?.type),
    },
    onLabelMessage: () => setLabelPickerOpen(true),
  }

  // Desktop/keyboard only via the shared input-mode reveal model: the row is the
  // `reveal-host`, and `reveal-actions-hover-only` keeps this cluster
  // opacity-0 + pointer-events-none for touch (so a tap can't trigger the
  // invisible button — it passes through), revealing it on mouse hover / focus.
  // Touch reaches the same actions through the long-press drawer below. The body
  // columns carry `pr-14` so this absolute react+overflow cluster never overlays
  // the row's top-right content (INV-21).
  const overflowMenu = (
    <div className="reveal-actions-hover-only absolute right-0 top-0 flex items-center gap-0.5">
      <ReactionEmojiPicker
        workspaceId={workspaceId}
        onSelect={handleAddReaction}
        activeShortcodes={activeReactionShortcodes}
        allReactionShortcodes={allReactionShortcodes}
      />
      <MessageContextMenu context={menuContext} />
    </div>
  )

  const overlays = (
    <>
      {labelPickerOpen && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.MESSAGE}
          resourceId={message.id}
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
        />
      )}
      {touchCapable && (
        <MessageActionDrawer
          open={drawerOpen}
          onOpenChange={setDrawerOpen}
          context={menuContext}
          authorName={authorName}
        />
      )}
      {mobilePickerOpen && (
        <ReactionEmojiPicker
          workspaceId={workspaceId}
          onSelect={handleAddReaction}
          activeShortcodes={activeReactionShortcodes}
          allReactionShortcodes={allReactionShortcodes}
          open={mobilePickerOpen}
          onOpenChange={setMobilePickerOpen}
        />
      )}
    </>
  )

  const richBody = (
    <>
      <MarkdownContent content={message.contentMarkdown} messageId={message.id} className="text-sm leading-relaxed" />
      {attachments.length > 0 && <AttachmentList attachments={attachments} workspaceId={workspaceId} />}
      {linkPreviews.length > 0 && (
        <LinkPreviewList
          messageId={message.id}
          workspaceId={workspaceId}
          previews={linkPreviews}
          hydrateFromApi={false}
        />
      )}
      {/* Memo + giphy embeds are parsed from the markdown, so they render here
          just like the timeline — no extra payload needed. */}
      <MemoPreviewList contentMarkdown={message.contentMarkdown} />
      <GiphyPreviewList contentMarkdown={message.contentMarkdown} />
    </>
  )
  // The body renders real message content (mentions, attachments, link previews),
  // so it gets the same markdown context wrappers the timeline uses. Attachments
  // open the media gallery / download via AttachmentList.
  const body = (
    <>
      <LinkPreviewProvider>
        {attachments.length > 0 ? (
          <AttachmentProvider workspaceId={workspaceId} attachments={attachments}>
            {richBody}
          </AttachmentProvider>
        ) : (
          richBody
        )}
      </LinkPreviewProvider>
      {hasReactions && (
        <MessageReactions
          reactions={message.reactions}
          workspaceId={workspaceId}
          messageId={message.id}
          currentUserId={currentUserId}
        />
      )}
    </>
  )

  // The message's own labels. On a standalone row they ride in the header next
  // to the timestamp; a continuation has no header, so they trail the body
  // there (renders nothing until the message is actually labeled).
  const labelStack = (
    <LabelStack workspaceId={workspaceId} resourceType={LabelableResourceTypes.MESSAGE} resourceId={message.id} />
  )

  const touchHandlers = touchCapable ? longPress.handlers : undefined

  if (continuation) {
    const sentAt = new Date(message.createdAt)
    return (
      <div
        ref={containerRef}
        className={cn(
          "group reveal-host relative mt-0.5 flex scroll-mt-12 gap-3",
          longPress.isPressed && "opacity-70 transition-opacity",
          isHighlighted && "animate-highlight-flash"
        )}
        {...touchHandlers}
      >
        {/* Gutter reveals the message time on hover (desktop), mirroring the
            timeline's grouped-continuation micro-time. */}
        <div
          className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums leading-5 text-transparent transition-colors group-hover:text-muted-foreground/60"
          title={formatFull(sentAt)}
        >
          {formatTime(sentAt)}
        </div>
        <div className="min-w-0 flex-1 pr-14">
          {body}
          {labelStack}
        </div>
        {overflowMenu}
        {overlays}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "group reveal-host relative mt-3 flex scroll-mt-12 items-start gap-3",
        longPress.isPressed && "opacity-70 transition-opacity",
        isHighlighted && "animate-highlight-flash"
      )}
      {...touchHandlers}
    >
      <ActorAvatar
        actorId={message.authorId}
        actorType={message.authorType}
        workspaceId={workspaceId}
        size="md"
        alt={authorName}
        showStatus={false}
      />
      <div className="min-w-0 flex-1 pr-14">
        <div className="mb-0.5 flex items-baseline gap-2">
          {interactiveName ? (
            <button
              type="button"
              onClick={() => openUserProfile(message.authorId)}
              className="min-w-0 truncate text-left text-sm font-semibold hover:underline"
            >
              {authorName}
            </button>
          ) : (
            <span className="min-w-0 truncate text-sm font-semibold">{authorName}</span>
          )}
          {/* Permalink to the message in its stream timeline — the body is
              interactive, so navigation lives on the timestamp instead. */}
          <Link
            to={`/w/${workspaceId}/s/${streamId}?m=${message.id}`}
            className="shrink-0 text-xs text-muted-foreground hover:underline"
          >
            <RelativeTime date={message.createdAt} />
          </Link>
          {labelStack}
          {streamLabel && (
            <MessageStreamByline
              workspaceId={workspaceId}
              streamId={streamId}
              name={streamLabel.name}
              type={streamLabel.type}
            />
          )}
        </div>
        {body}
      </div>
      {overflowMenu}
      {overlays}
    </div>
  )
}

/**
 * Origin-stream chip for the header metadata line — the stream glyph + name,
 * linking into the stream (INV-40). Sits right of the timestamp and shares its
 * muted `text-xs` treatment so it reads as metadata, not a heading; the name
 * truncates so a long stream can't push the row.
 */
function MessageStreamByline({
  workspaceId,
  streamId,
  name,
  type,
}: {
  workspaceId: string
  streamId: string
  name: string
  type: StreamType
}) {
  const Icon = STREAM_ICONS[type]
  return (
    <Link
      to={`/w/${workspaceId}/s/${streamId}`}
      title={name}
      className="flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </Link>
  )
}
