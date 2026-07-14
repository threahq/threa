import { useCallback, useEffect, useRef, useState } from "react"
import { Paperclip, Pencil } from "lucide-react"
import { useQuoteReply, type QuoteReplyData } from "@/components/timeline/quote-reply-context"
import { useReplyToBoardPost } from "@/hooks/use-conversations"
import { useIsMobile } from "@/hooks/use-mobile"
import { useScopeDraftPreview, type ScopeDraftPreview } from "@/hooks"
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

/**
 * The resting affordance's content when the scope holds an unsent draft: the
 * draft's own first line, mirroring the mobile composer's collapsed preview
 * bar — the draft is visible in place instead of hiding behind a generic
 * label (discoverability ruling, Kris 2026-07-13). Shared by the bottom-reply
 * button here and the branch-tail affordance.
 */
export function DraftRestingPreview({ draft }: { draft: ScopeDraftPreview }) {
  return (
    <span className="flex w-full min-w-0 items-center gap-2">
      <Pencil aria-label="Unsent draft" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {draft.preview ? (
        <span className="min-w-0 flex-1 truncate text-foreground">{draft.preview}</span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1 truncate text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5 shrink-0" />
          {draft.attachmentCount} attachment{draft.attachmentCount === 1 ? "" : "s"}
        </span>
      )}
    </span>
  )
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
  /**
   * Docked-composer semantics for a dedicated conversation view (the panel):
   * the composer is permanently mounted on BOTH platforms — desktop stays
   * expanded, mobile shows `MessageComposer`'s own collapsed⇄focused bar
   * (timeline parity). No resting "Write a reply…" button, no draft-pill
   * button (Kris's composer ruling, 2026-07-13). Off (the default) for board
   * cards, which keep the resting-button model, and the inline
   * sub-conversation affordances.
   */
  alwaysDocked?: boolean
  /**
   * Arms the docked composer to a sub-conversation (branch) instead of the
   * conversation root: its draft scope, host stream, schedule target, and send
   * routing switch to the branch, and a dismissible "Replying in <title>"
   * strip shows. Panel only; the × moves the draft back to the root scope and
   * disarms. Ignored unless `alwaysDocked`.
   */
  armedReply?: ArmedReply
}

/** A sub-conversation the docked panel composer is armed to reply into. */
export interface ArmedReply {
  /** The branch's draft persistence scope (per-target). */
  draftKey: string
  /** Names the branch in the dismissible strip ("Replying in <title>"). */
  title: string
  /** The branch thread stream (mention context, E2E gate) + conversation id. */
  scheduleTarget: { streamId: string; conversationId: string }
  /** Roamed draft to check out on arm, and a nonce that fires the check-out. */
  restoreStashedId: string | null
  restoreSignal: number
  onSubmit: (input: InlineComposerSubmit) => Promise<void>
  onCancel: () => void
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
  const alwaysDocked = props.alwaysDocked ?? false

  // The scope's unsent draft, advertised on the resting button and — when it
  // isn't checked out on this device (stashed / roamed) — checked out by the
  // opening form so the click surfaces exactly what the button showed.
  const scopeDraft = useScopeDraftPreview(props.workspaceId, boardReplyDraftKey(props.post.conversation.id))
  const restoreStashedId = scopeDraft && !scopeDraft.isCheckedOut ? scopeDraft.draftId : null

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

  // Always-docked (the conversation panel): the form never collapses to a
  // button — after a send / Escape / blur the editor simply stays, docked at
  // the footer, on both platforms (mobile shows MessageComposer's own collapsed
  // bar). Open-requests become focus requests, and the drafts-explorer `?stash=`
  // restore is consumed by the mounted form's own URL effect (no mount to hang
  // it on).
  const noopClose = useCallback(() => {}, [])
  if (alwaysDocked) {
    return (
      <BoardReplyComposerForm
        {...props}
        docked
        onClose={noopClose}
        pendingQuote={pendingQuote}
        onQuoteConsumed={onQuoteConsumed}
        restoreStashedId={null}
        autoFocus={false}
        focusSignal={openReplySignal}
      />
    )
  }

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
        {/* With a draft: the draft's own first line (mobile collapsed-composer
            presentation). Without: the plain invitation — no leading icon, so
            the resting text aligns with the open composer's placeholder. */}
        {scopeDraft ? (
          <DraftRestingPreview draft={scopeDraft} />
        ) : (
          <span className="truncate">{RESTING_LABEL[resting]}</span>
        )}
      </button>
    )
  }

  return (
    <BoardReplyComposerForm
      {...props}
      onClose={close}
      pendingQuote={pendingQuote}
      onQuoteConsumed={onQuoteConsumed}
      restoreStashedId={restoreStashedId}
    />
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
  restoreStashedId,
  autoFocus,
  focusSignal,
  docked,
  armedReply,
}: BoardReplyComposerProps & {
  onClose: (opts?: { refocus?: boolean; hadContent?: boolean }) => void
  pendingQuote: QuoteReplyData | null
  onQuoteConsumed: () => void
  restoreStashedId: string | null
  autoFocus?: boolean
  focusSignal?: number
  docked?: boolean
}) {
  const reply = useReplyToBoardPost(workspaceId)
  const isMobile = useIsMobile()
  const rootStreamId = post.conversation.streamId
  const rootReplyKey = boardReplyDraftKey(post.conversation.id)

  const onRootSubmit = useCallback(
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

  // When armed the composer targets the branch: its own draft scope + host
  // stream + schedule target + send routing, plus the dismissible strip whose
  // × moves the draft back to the root reply scope. Unarmed it is the root
  // conversation composer.
  const streamId = armedReply ? armedReply.scheduleTarget.streamId : rootStreamId

  return (
    <InlineComposerForm
      workspaceId={workspaceId}
      streamId={streamId}
      memoAnchorStreamId={streamId}
      draftKey={armedReply ? armedReply.draftKey : rootReplyKey}
      placeholder="Write a reply…"
      contextChip={isMobile && contextChip ? `Replying in ${contextChip}` : undefined}
      docked={docked}
      replyTarget={
        armedReply
          ? { title: armedReply.title, moveDraftToKey: rootReplyKey, onCancel: armedReply.onCancel }
          : undefined
      }
      restoreOnSignal={
        armedReply ? { stashId: armedReply.restoreStashedId, signal: armedReply.restoreSignal } : undefined
      }
      pendingQuote={pendingQuote}
      onQuoteConsumed={onQuoteConsumed}
      rejectE2e="Encrypted notes can't be replied to from the board yet — open the note to reply there."
      scheduleTarget={
        armedReply ? armedReply.scheduleTarget : { streamId: rootStreamId, conversationId: post.conversation.id }
      }
      restoreStashedIdOnMount={restoreStashedId}
      autoFocus={autoFocus}
      focusSignal={focusSignal}
      onSubmit={armedReply ? armedReply.onSubmit : onRootSubmit}
      onClose={onClose}
    />
  )
}
