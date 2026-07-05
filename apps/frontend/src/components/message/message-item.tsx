import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Quote } from "lucide-react"
import {
  LabelableResourceTypes,
  type AttachmentSummary,
  type AuthorType,
  type LinkPreviewSummary,
  type StreamType,
} from "@threa/types"
import { ActorAvatar } from "@/components/actor-avatar"
import { actorRowTheme } from "@/components/message/actor-row-theme"
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
import { MessageEditForm } from "@/components/timeline/message-edit-form"
import { DeleteMessageDialog } from "@/components/timeline/delete-message-dialog"
import { EditedIndicator } from "@/components/timeline/edited-indicator"
import { MessageHistoryDialog } from "@/components/timeline/message-history-dialog"
import { ReminderPickerSheet } from "@/components/timeline/reminder-picker-sheet"
import { ShareMessageModal } from "@/components/share/share-message-modal"
import type { MessageActionContext } from "@/components/timeline/message-actions"
import { useConversationRowRead } from "@/components/message/conversation-read-context"
import { useQuoteReply } from "@/components/timeline/quote-reply-context"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks/use-message-reactions"
import { LabelStack } from "@/components/labels/label-stack"
import { LabelPicker } from "@/components/labels/label-picker"
import { useUserProfile } from "@/components/user-profile"
import { useFormattedDate } from "@/hooks/use-formatted-date"
import { useInputMode } from "@/hooks/use-input-mode"
import { useDeleteMessage } from "@/hooks/use-delete-message"
import { useDiscussWithAriadne } from "@/hooks/use-discuss-with-ariadne"
import { useSavedForMessage, useSaveMessage, useDeleteSaved } from "@/hooks/use-saved"
import { parseMarkdown } from "@threa/prosemirror"
import { useTouchCapable } from "@/hooks/use-touch-capable"
import { useLongPress } from "@/hooks/use-long-press"
import { useSwipeAction } from "@/hooks/use-swipe-action"
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
  /** This message's per-stream event `sequence` (bigint-as-string), when the row
   * comes from the live events rail. Gates conversation-surface read state
   * (a row is unread iff its sequence sits past its stream's read frontier and
   * it isn't in the overlay). Absent on projection/backfill rows, which fall
   * back to a timestamp comparison. See docs/sparse-read-overlay-design.md. */
  sequence?: string
  authorId: string
  authorType: AuthorType
  contentMarkdown: string
  reactions: Record<string, string[]>
  createdAt: string | Date
  /** Last edit time, or null/absent if never edited — drives the "(edited)"
   * affordance and the revisions dialog (parity with the timeline row). */
  editedAt?: string | null
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
  /** The conversation's root stream, set alongside `conversationId` by the
   * conversation surfaces. Enables "Discuss with Ariadne" to seed the scratchpad
   * with the whole conversation's span (root + threads) rather than one stream's
   * window. The label page leaves both unset, so the action hides there. */
  conversationRootStreamId?: string
  /** Scroll this row into view and flash it — the conversation panel sets it for
   * the `?m=` deep-link target so a shared message link lands on the right row. */
  isHighlighted?: boolean
  /** Background of the surface this row sits on (`bg-card` on a board card,
   * `bg-background` in the conversation panel). The row is filled with it during a
   * mobile swipe-to-quote so the reveal icon stays hidden behind the row until the
   * content slides off it. Omitted where swipe isn't wired (the label page has no
   * quote provider, so the gesture is disabled). */
  surfaceClassName?: string
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
  conversationRootStreamId,
  isHighlighted,
  surfaceClassName,
}: MessageItemProps) {
  const { formatTime, formatFull } = useFormattedDate()
  const { openUserProfile } = useUserProfile()
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mobilePickerOpen, setMobilePickerOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editingSurfaceTouch, setEditingSurfaceTouch] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  // Touch reaches the actions via long-press → the same `MessageActionDrawer`
  // the timeline uses; the hover overflow button is desktop/keyboard only. This
  // mirrors `SentMessageEvent` rather than exposing a tap-sized dropdown.
  const touchCapable = useTouchCapable()
  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const longPress = useLongPress({
    onLongPress: openDrawer,
    enabled: touchCapable && !isEditing,
    deferToNativeLinks: true,
  })
  const hasReactions = Object.keys(message.reactions).length > 0
  // Users open their profile on click (same as the timeline); other actor types
  // (persona/bot/system) are non-interactive.
  const interactiveName = message.authorType === "user" && Boolean(message.authorId)
  // Per-actor colorization on board surfaces (shared theme): the author-name color
  // + inline badge, plus `cardAccent` — a crisp rounded left bar + whisper tint on
  // the message content, contained/aligned inside the padded card. This is the
  // board's variant; the timeline's full-bleed `rowAccent` (gradient + inset
  // stripe) is for edge-to-edge stream rows and is NOT applied here (it floats and
  // reads muddy on a card).
  const theme = actorRowTheme(message.authorType)
  const attachments = message.attachments ?? []
  const linkPreviews = message.linkPreviews ?? []
  // The row's own stream — only to pick the "View in channel/thread/…" noun.
  const rowStream = useStreamFromStore(streamId)

  // Quote reply routes to the conversation's reply composer through the provider
  // the conversation surfaces (board card, panel) wrap this row in. Absent on the
  // label page (no provider, no composer) → `onQuoteReply` stays undefined and the
  // action hides, the same field-one-side-sets gate as `conversationId`.
  const quoteReplyCtx = useQuoteReply()

  // Conversation-surface read state (board card / panel). Absent on the label
  // page (no provider) → both mark-read actions hide, the same field-one-side-
  // sets gate as `conversationId`. Gate each action by where the row sits
  // relative to the effective read frontier, mirroring the in-stream row
  // (message-event): hide "Mark as read" on read rows, "Mark as unread" on
  // unread rows; an ungated row (no resolvable frontier) shows both.
  const conversationRead = useConversationRowRead()
  const rowRead = conversationRead
    ? conversationRead.state(streamId, message.id, message.sequence, message.createdAt)
    : "ungated"

  // Own-message edit reuses the timeline's `MessageEditForm` (same save/offline
  // path). The row can host it wherever a message shows — the form only needs
  // the app-global message service + query cache, not a timeline. Input mode is
  // latched at edit start so a mid-edit switch can't remount the form and drop
  // unsaved text (mirrors `MessageEvent`).
  const isTouchInput = useInputMode() === "touch"
  const { deleteMessage, isDeleting } = useDeleteMessage(workspaceId)
  const startEditing = useCallback(() => {
    setEditingSurfaceTouch(isTouchInput)
    setIsEditing(true)
  }, [isTouchInput])
  // The editor autofocuses; unlike the timeline (which restores focus to its
  // editor zone) this row has no zone, so return focus to the row itself on
  // exit — otherwise a keyboard user's focus drops to <body> when the form
  // unmounts. Move focus before the state flip so it's off the editor by the
  // time React tears it down. Skip on touch: the drawer owns its own
  // close/return-focus, and grabbing focus mid-close fights it (as MessageEvent).
  const stopEditing = useCallback(() => {
    if (!editingSurfaceTouch) containerRef.current?.focus()
    setIsEditing(false)
    setEditingSurfaceTouch(false)
  }, [editingSurfaceTouch])
  // Clearing a message to empty deletes it — the edit form's intrinsic delete
  // path (see `MessageEditForm.onDelete`), confirmed through the same dialog the
  // timeline uses. This is not the standalone "Delete message" action.
  const handleDelete = useCallback(async () => {
    await deleteMessage(message.id)
    setDeleteDialogOpen(false)
  }, [deleteMessage, message.id])

  // "Discuss with Ariadne" from a conversation surface seeds the scratchpad with
  // the whole conversation's span (root + threads), not one stream's window — a
  // conversation-scoped context ref the backend resolves. Only wired when both
  // the conversation id and its root are known (the conversation surfaces set
  // both); the label page leaves them unset, so the action hides there. The menu
  // invokes fire-and-forget, so swallow after the hook's own error toast (INV-11:
  // the toast is the loud failure, not an unhandled rejection).
  const startDiscussWithAriadne = useDiscussWithAriadne(workspaceId)
  const canDiscussConversation = Boolean(conversationId && conversationRootStreamId)
  const handleDiscussWithAriadne = useCallback(() => {
    if (!conversationId || !conversationRootStreamId) return
    void startDiscussWithAriadne({
      kind: "conversation",
      conversationId,
      rootStreamId: conversationRootStreamId,
      sourceMessageId: message.id,
    }).catch(() => {
      /* toast already surfaced inside the hook */
    })
  }, [startDiscussWithAriadne, conversationId, conversationRootStreamId, message.id])

  // Save / Set reminder — the same shared registry actions the in-stream row
  // exposes (`MessageEvent`). A save from a conversation surface passes
  // `conversationId` so the saved row (and its reminder) deep-links back into
  // the conversation panel; the label page leaves it undefined and the row saves
  // as a plain stream-origin bookmark.
  const savedForMessage = useSavedForMessage(workspaceId, message.id)
  const saveMessageMutation = useSaveMessage(workspaceId)
  const unsaveMessageMutation = useDeleteSaved(workspaceId)
  const isSaved = !!savedForMessage && savedForMessage.status === "saved"
  const handleToggleSave = useCallback(() => {
    if (saveMessageMutation.isPending || unsaveMessageMutation.isPending) return
    if (!savedForMessage) {
      saveMessageMutation.mutate(
        { messageId: message.id, conversationId },
        { onError: () => toast.error("Could not save message") }
      )
      return
    }
    if (savedForMessage.status !== "saved") {
      saveMessageMutation.mutate(
        { messageId: message.id, conversationId },
        { onError: () => toast.error("Could not restore saved item") }
      )
      return
    }
    unsaveMessageMutation.mutate(savedForMessage.id, {
      onError: () => toast.error("Could not remove saved item"),
    })
  }, [savedForMessage, saveMessageMutation, unsaveMessageMutation, message.id, conversationId])
  const handleRequestReminder = useCallback(() => setReminderSheetOpen(true), [])

  // Board/conversation payloads carry only markdown (INV-58 wire format); parse
  // it back to the canonical contentJson the editor edits over. A no-op edit is
  // still detected because the form's baseline re-serializes this same doc.
  const editInitialContentJson = useMemo(() => parseMarkdown(message.contentMarkdown), [message.contentMarkdown])
  const inlineEditing = isEditing && !editingSurfaceTouch
  const editForm = (
    <MessageEditForm
      messageId={message.id}
      workspaceId={workspaceId}
      streamId={streamId}
      initialContentJson={editInitialContentJson}
      onSave={stopEditing}
      onCancel={stopEditing}
      onDelete={() => {
        stopEditing()
        setDeleteDialogOpen(true)
      }}
      authorName={authorName}
    />
  )

  // One guarded builder for both quote entry points (menu action + swipe) so they
  // behave identically — trim the snippet and no-op on empty content (an
  // attachment-only message) rather than emitting a degenerate empty quote node.
  const triggerQuote = useCallback(() => {
    const snippet = message.contentMarkdown.trim()
    if (!snippet || !quoteReplyCtx) return
    quoteReplyCtx.triggerQuoteReply({
      messageId: message.id,
      streamId,
      authorName,
      authorId: message.authorId,
      actorType: message.authorType,
      snippet,
    })
  }, [quoteReplyCtx, message.contentMarkdown, message.id, message.authorId, message.authorType, streamId, authorName])

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
  useEffect(() => {
    if (isHighlighted && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: "smooth", block: "center" })
    }
  }, [isHighlighted])

  // Reactions/copy/label plus copy-link (surface-specific via `conversationId`),
  // "View in channel/thread/…", and quote reply when a conversation composer is in
  // the tree. `isThreadParent: true` suppresses "Reply in thread" (no thread
  // context here); `currentUserId` powers react toggling and gates "Edit message"
  // to the author's own (user-authored) rows.
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
    // Mirror the in-stream surface: hide Edit on E2E messages (no sealed-edit
    // path — a plaintext update is rejected and the offline queue would retry it
    // forever). E2E rows can reach here via the label page.
    e2eEnabled: rowStream?.e2eEnabled === true,
    editedAt: message.editedAt ?? undefined,
    // Defer so the closing menu/drawer doesn't fight the dialog open (as MessageEvent).
    onShowHistory: () => setTimeout(() => setHistoryOpen(true), 0),
    onReact: handleAddReaction,
    onOpenFullPicker: () => setMobilePickerOpen(true),
    onEdit: startEditing,
    // Standalone Delete (the registry's owner-only `delete-message`) opens the
    // same confirm dialog as the edit form's clear-to-empty path — both land on
    // `handleDelete` → `useDeleteMessage`. The action's own gate keeps it to the
    // author's rows, mirroring the timeline row (`MessageEvent`).
    onDelete: () => setDeleteDialogOpen(true),
    onQuoteReply: quoteReplyCtx ? triggerQuote : undefined,
    // Cross-stream Share picker — parity with the in-stream row (`MessageEvent`).
    // A share from a conversation surface stamps `conversationId` on the pointer
    // (see the modal render below) so the shared card deep-links back into the
    // conversation panel. Hidden on E2E rows: there's no plaintext-decrypt path
    // here (that lives on the in-stream row), and a ciphertext pointer share is
    // rejected server-side — so route E2E sharing through the timeline instead.
    onShare: rowStream?.e2eEnabled === true ? undefined : () => setShareModalOpen(true),
    isSaved,
    onToggleSave: handleToggleSave,
    onRequestReminder: handleRequestReminder,
    onDiscussWithAriadne: canDiscussConversation ? handleDiscussWithAriadne : undefined,
    viewInStream: {
      href: `/w/${workspaceId}/s/${streamId}?m=${message.id}`,
      label: viewInStreamLabel(rowStream?.type),
    },
    onLabelMessage: () => setLabelPickerOpen(true),
    onMarkReadUpToHere:
      conversationRead && rowRead !== "read" ? () => conversationRead.markReadUpToHere(message.id) : undefined,
    onMarkUnread: conversationRead && rowRead !== "unread" ? () => conversationRead.markUnread(message.id) : undefined,
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
      {/* Touch edits go in a bottom-sheet drawer (the form portals itself); the
          row stays rendered beneath. Desktop edits replace the body inline. */}
      {isEditing && editingSurfaceTouch && editForm}
      {deleteDialogOpen && (
        <DeleteMessageDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onConfirm={handleDelete}
          isDeleting={isDeleting}
        />
      )}
      {historyOpen && (
        <MessageHistoryDialog
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          messageId={message.id}
          workspaceId={workspaceId}
          messageCreatedAt={String(message.createdAt)}
          currentContent={{
            contentMarkdown: message.contentMarkdown,
            editedAt: message.editedAt ?? undefined,
          }}
        />
      )}
      {reminderSheetOpen && (
        <ReminderPickerSheet
          open={reminderSheetOpen}
          onOpenChange={setReminderSheetOpen}
          workspaceId={workspaceId}
          messageId={message.id}
          conversationId={conversationId}
          saved={savedForMessage ?? null}
        />
      )}
      {shareModalOpen && (
        <ShareMessageModal
          open={shareModalOpen}
          onOpenChange={setShareModalOpen}
          workspaceId={workspaceId}
          attrs={{
            messageId: message.id,
            streamId,
            authorName,
            authorId: message.authorId,
            actorType: message.authorType,
            // Set only on conversation surfaces (undefined on the label page),
            // so the resulting pointer's back-link is conversation-aware exactly
            // where the message was shared from a conversation.
            conversationId,
          }}
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

  // Swipe-left-to-quote on touch, mirroring the stream timeline (message-event).
  // Enabled only where a quote composer exists (board card / conversation panel
  // supply the provider; the label page doesn't → gesture off). The reveal icon
  // sits behind the row and the row slides left over it, so it needs an opaque
  // `surfaceClassName` fill during the swipe.
  const swipe = useSwipeAction({ onSwipe: triggerQuote, enabled: touchCapable && !!quoteReplyCtx && !isEditing })
  const hasSwipe = swipe.offset !== 0
  const swipeStyle = hasSwipe ? { transform: `translateX(${swipe.offset}px)` } : undefined

  // Long-press (→ action drawer) and swipe (→ quote) share the touch surface, so
  // their handlers are fanned out to both. `onContextMenu` comes from long-press.
  const touchHandlers = touchCapable
    ? {
        onTouchStart: (e: React.TouchEvent) => {
          longPress.handlers.onTouchStart(e)
          swipe.handlers.onTouchStart(e)
        },
        onTouchMove: (e: React.TouchEvent) => {
          longPress.handlers.onTouchMove(e)
          swipe.handlers.onTouchMove(e)
        },
        onTouchEnd: () => {
          longPress.handlers.onTouchEnd()
          swipe.handlers.onTouchEnd()
        },
        onTouchCancel: () => {
          longPress.handlers.onTouchCancel()
          swipe.handlers.onTouchCancel()
        },
        onContextMenu: longPress.handlers.onContextMenu,
      }
    : undefined

  // The quote-reveal icon behind the row (right edge), shown only during a swipe;
  // it fills the strip the row uncovers as it slides left.
  const swipeReveal = hasSwipe ? (
    <div className="absolute inset-y-0 right-0 flex items-center pr-4">
      <Quote className={cn("h-5 w-5 transition-colors", swipe.isLocked ? "text-primary" : "text-muted-foreground")} />
    </div>
  ) : null

  if (continuation) {
    const sentAt = new Date(message.createdAt)
    return (
      <div
        ref={containerRef}
        tabIndex={-1}
        data-message-row=""
        data-message-id={message.id}
        data-stream-id={streamId}
        data-author-name={authorName}
        data-author-id={message.authorId}
        data-actor-type={message.authorType}
        className="relative mt-0.5 scroll-mt-12 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:overflow-visible"
        {...touchHandlers}
      >
        {swipeReveal}
        <div
          className={cn(
            "group reveal-host relative flex gap-3",
            surfaceClassName,
            longPress.isPressed && "opacity-70 transition-opacity",
            isHighlighted && "animate-highlight-flash"
          )}
          style={swipeStyle}
        >
          {/* Gutter reveals the message time on hover (desktop), mirroring the
              timeline's grouped-continuation micro-time. */}
          <div
            className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums leading-5 text-transparent transition-colors group-hover:text-muted-foreground/60"
            title={formatFull(sentAt)}
          >
            {formatTime(sentAt)}
          </div>
          <div className={cn("message-content min-w-0 flex-1 pr-14", theme.cardAccent)}>
            {inlineEditing ? (
              editForm
            ) : (
              <>
                {body}
                {labelStack}
              </>
            )}
          </div>
          {!inlineEditing && overflowMenu}
          {overlays}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-message-row=""
      data-message-id={message.id}
      data-stream-id={streamId}
      data-author-name={authorName}
      data-author-id={message.authorId}
      data-actor-type={message.authorType}
      className="relative mt-3 scroll-mt-12 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:overflow-visible"
      {...touchHandlers}
    >
      {swipeReveal}
      <div
        className={cn(
          "group reveal-host relative flex items-start gap-3",
          surfaceClassName,
          longPress.isPressed && "opacity-70 transition-opacity",
          isHighlighted && "animate-highlight-flash"
        )}
        style={swipeStyle}
      >
        <ActorAvatar
          actorId={message.authorId}
          actorType={message.authorType}
          workspaceId={workspaceId}
          size="md"
          alt={authorName}
          showStatus={false}
        />
        <div className="message-content min-w-0 flex-1 pr-14">
          <div className="mb-0.5 flex items-baseline gap-2">
            {interactiveName ? (
              <button
                type="button"
                onClick={() => openUserProfile(message.authorId)}
                className={cn("min-w-0 truncate text-left text-sm font-semibold hover:underline", theme.nameClassName)}
              >
                {authorName}
              </button>
            ) : (
              <span className={cn("min-w-0 truncate text-sm font-semibold", theme.nameClassName)}>{authorName}</span>
            )}
            {theme.badge}
            {/* Permalink to the message in its stream timeline — the body is
              interactive, so navigation lives on the timestamp instead. */}
            <Link
              to={`/w/${workspaceId}/s/${streamId}?m=${message.id}`}
              className="shrink-0 text-xs text-muted-foreground hover:underline"
            >
              <RelativeTime date={message.createdAt} />
            </Link>
            {message.editedAt && (
              <EditedIndicator editedAt={String(message.editedAt)} onShowHistory={() => setHistoryOpen(true)} />
            )}
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
          {inlineEditing ? editForm : body}
        </div>
        {!inlineEditing && overflowMenu}
        {overlays}
      </div>
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
