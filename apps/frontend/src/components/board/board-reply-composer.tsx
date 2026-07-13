import { useCallback, useEffect, useRef, useState } from "react"
import { useQuoteReply, type QuoteReplyData } from "@/components/timeline/quote-reply-context"
import { useReplyToBoardPost } from "@/hooks/use-conversations"
import { useIsMobile } from "@/hooks/use-mobile"
import { InlineComposerForm, type InlineComposerSubmit } from "@/components/board/board-inline-composer"
import { boardReplyDraftKey } from "@/lib/board/draft-keys"
import type { BoardPost } from "@threa/types"

// Resting-affordance state. `draft` signals a persisted-but-collapsed reply, so
// the user knows reopening restores it. Every reply — including a lone post's
// convert-to-thread — joins the same conversation and renders in place on the
// card (board-view-design.md "Convert-to-thread, corrected"), so a successful
// send just returns the affordance to its invitation.
type RestingState = "idle" | "draft"
const RESTING_LABEL: Record<RestingState, string> = {
  idle: "Write a reply…",
  draft: "Continue reply…",
}

interface BoardReplyComposerProps {
  workspaceId: string
  post: BoardPost
  /** Host stream type of the post's conversation, selecting the reply routing. */
  hostStreamType: string | undefined
  /** The conversation's most-recently-active stream, for recency-biased
   *  continuation (a reply follows the conversation into its thread). */
  lastActiveStreamId: string | null
  /**
   * Monotonic nonce: each increment expands the resting affordance into the live
   * composer and focuses it — the conversation panel bumps it after being opened
   * via "Reply in conversation" so the user lands straight in the reply editor. A
   * counter (not a boolean) so a second request re-opens the composer after a
   * manual collapse; `0`/absent leaves it collapsed (board cards open on tap).
   */
  openReplySignal?: number
  /**
   * Names the reply target ("Replying in <topic/stream>") when the mobile
   * composer floats away from its card into the page-level pill — the feed can
   * scroll on under it, so proximity no longer identifies the conversation. The
   * board card passes its topic/locator; the panel omits it (single-conversation
   * surface, the header already names it). Mobile-only: the in-place desktop
   * form keeps its context by position.
   */
  contextChip?: string
}

/**
 * Inline reply affordance on a board card / conversation panel. Collapsed to a
 * single resting line so the feed stays scannable; tapping it mounts the shared
 * {@link InlineComposerForm} in place (the heavy editor mounts only once a card is
 * activated). Routing — a lone channel/DM post converts to a thread, everything
 * else replies flat into the conversation (recency-biased) — lives in
 * {@link useReplyToBoardPost}. The resting affordance flags a persisted draft
 * after an Escape ("Continue reply…") so a collapse never reads as a discard.
 */
export function BoardReplyComposer(props: BoardReplyComposerProps) {
  const [open, setOpen] = useState(false)
  const [resting, setResting] = useState<RestingState>("idle")
  const buttonRef = useRef<HTMLButtonElement>(null)

  const { openReplySignal } = props
  useEffect(() => {
    if (!openReplySignal) return
    setResting("idle")
    setOpen(true)
  }, [openReplySignal])

  // Quote reply from a message row in this conversation lands here. The resting
  // affordance leaves the form unmounted while collapsed, so this always-mounted
  // outer owns the provider registration: it opens the form and stashes the quote
  // for the form to consume on mount.
  const quoteReplyCtx = useQuoteReply()
  const [pendingQuote, setPendingQuote] = useState<QuoteReplyData | null>(null)
  const onQuoteConsumed = useCallback(() => setPendingQuote(null), [])
  useEffect(() => {
    if (!quoteReplyCtx) return
    return quoteReplyCtx.registerHandler((data) => {
      setPendingQuote(data)
      setResting("idle")
      setOpen(true)
    })
  }, [quoteReplyCtx])

  // Return focus to the resting button after an explicit collapse so keyboard
  // navigation isn't dropped onto <body>. A blur-driven collapse passes
  // refocus=false — the user already moved focus elsewhere.
  const refocusOnCollapseRef = useRef(false)
  useEffect(() => {
    if (!open && refocusOnCollapseRef.current) {
      refocusOnCollapseRef.current = false
      buttonRef.current?.focus()
    }
  }, [open])

  const close = useCallback((opts?: { refocus?: boolean; hadContent?: boolean }) => {
    refocusOnCollapseRef.current = opts?.refocus ?? false
    setResting(opts?.hadContent ? "draft" : "idle")
    setOpen(false)
  }, [])

  if (!open) {
    return (
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setResting("idle")
          setOpen(true)
        }}
        className="mt-3 flex w-full min-w-0 items-center rounded-[16px] border border-input bg-card p-3 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* No leading icon: it would misalign the resting text against the open
            composer's placeholder, and a state-dependent icon would shift the
            label (INV-21). */}
        <span className="truncate">{RESTING_LABEL[resting]}</span>
      </button>
    )
  }

  return (
    <BoardReplyComposerForm {...props} onClose={close} pendingQuote={pendingQuote} onQuoteConsumed={onQuoteConsumed} />
  )
}

function BoardReplyComposerForm({
  workspaceId,
  post,
  hostStreamType,
  lastActiveStreamId,
  onClose,
  pendingQuote,
  onQuoteConsumed,
  contextChip,
}: BoardReplyComposerProps & {
  onClose: (opts?: { refocus?: boolean; hadContent?: boolean }) => void
  pendingQuote: QuoteReplyData | null
  onQuoteConsumed: () => void
}) {
  const reply = useReplyToBoardPost(workspaceId)
  const isMobile = useIsMobile()
  const streamId = post.conversation.streamId

  const onSubmit = useCallback(
    async ({ contentJson, attachmentIds, attachments }: InlineComposerSubmit) => {
      await reply.mutateAsync({
        conversation: post.conversation,
        openingMessageId: post.openingMessage?.id ?? null,
        hostStreamType,
        messageCount: post.conversation.messageIds.length,
        lastActiveStreamId,
        contentJson,
        attachmentIds,
        attachments,
      })
    },
    [reply, post.conversation, post.openingMessage, hostStreamType, lastActiveStreamId]
  )

  return (
    <InlineComposerForm
      workspaceId={workspaceId}
      streamId={streamId}
      memoAnchorStreamId={streamId}
      draftKey={boardReplyDraftKey(post.conversation.id)}
      placeholder="Write a reply…"
      contextChip={isMobile && contextChip ? `Replying in ${contextChip}` : undefined}
      pendingQuote={pendingQuote}
      onQuoteConsumed={onQuoteConsumed}
      rejectE2e="Encrypted notes can't be replied to from the board yet — open the note to reply there."
      scheduleTarget={{ streamId, conversationId: post.conversation.id }}
      onSubmit={onSubmit}
      onClose={onClose}
    />
  )
}
