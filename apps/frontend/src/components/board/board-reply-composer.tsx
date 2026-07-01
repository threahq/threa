import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { MessageComposer, type ComposerControlHandle } from "@/components/composer"
import { useQuoteReply, appendQuoteReplyNode, type QuoteReplyData } from "@/components/timeline/quote-reply-context"
import { useDraftComposer } from "@/hooks"
import { usePreferences } from "@/contexts"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useReplyToBoardPost } from "@/hooks/use-conversations"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { EMPTY_DOC, isEmptyContent } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import type { BoardPost, JSONContent } from "@threa/types"

// Focus moving into one of these means a composer popover is open (the inline
// suggestion lists render as `[role="listbox"]`; emoji/format/link popovers are
// Radix poppers; the mobile drawer is a dialog) — all portal outside the
// composer subtree, so blur-to-collapse must treat them as "still editing"
// rather than a dismissal. document-editor-modal.tsx guards its suggestion
// popover the same way (`[role="listbox"]`); this set is broader to also cover
// the Radix poppers and dialog.
const COMPOSER_POPOVER_SELECTOR = '[role="listbox"],[data-radix-popper-content-wrapper],[role="dialog"]'

// Resting-affordance state. `draft` signals a persisted-but-collapsed reply, so
// the user knows reopening restores it. Every reply — including a lone post's
// convert-to-thread — now joins the same conversation and renders in place on the
// card (board-view-design.md "Convert-to-thread, corrected"), so there is no card
// swap to bridge: a successful send just returns the affordance to its invitation.
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
}

/**
 * Inline reply affordance on a board card. Collapsed to a single resting line
 * so the feed stays scannable; tapping it mounts the real composer in place (the
 * heavy editor mounts only once a card is activated, so a feed of cards costs one
 * lightweight button each, not one composer each). The button deliberately
 * mirrors the composer's own container — same radius, border, surface, padding,
 * and placeholder — and the composer mounts already open (`initialMobileChromeOpen`)
 * so the tap lands straight in the toolbar view instead of stepping through the
 * mobile compacted phase. Routing — a lone channel/DM post converts to a thread,
 * everything else replies flat into the conversation (recency-biased — into the
 * thread the conversation moved to) — lives in {@link useReplyToBoardPost}.
 *
 * The resting affordance carries state (best-effort, in-session): it flags a
 * persisted draft after an Escape ("Continue reply…") so a collapse never reads
 * as an accidental discard.
 */
export function BoardReplyComposer(props: BoardReplyComposerProps) {
  const [open, setOpen] = useState(false)
  const [resting, setResting] = useState<RestingState>("idle")
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Quote reply from a message row in this conversation lands here. The resting
  // affordance leaves the form unmounted while collapsed, so this always-mounted
  // outer owns the provider registration: it opens the form and stashes the quote
  // for the form to consume on mount (or immediately, if already open). Scoped by
  // the per-conversation QuoteReplyProvider the card/panel wraps around its rows +
  // this composer.
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
  // Return focus to the resting button after an explicit collapse (Escape /
  // after-send) so keyboard navigation isn't dropped onto <body> when the form
  // unmounts. A blur-driven collapse passes refocus=false — the user already
  // moved focus elsewhere, so we leave it where they put it.
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
}: BoardReplyComposerProps & {
  onClose: (opts?: { refocus?: boolean; hadContent?: boolean }) => void
  pendingQuote: QuoteReplyData | null
  onQuoteConsumed: () => void
}) {
  const { preferences } = usePreferences()
  const streams = useWorkspaceStreams(workspaceId)
  const reply = useReplyToBoardPost(workspaceId)

  const streamId = post.conversation.streamId
  // The host stream backs mention autocomplete + attachment uploads. A thread
  // card's host may not be in the workspace stream cache; the composer degrades
  // gracefully (no mention context) when it isn't.
  const hostStream = useMemo<CachedStream | undefined>(
    () => streams.find((s) => s.id === streamId),
    [streams, streamId]
  )
  const streamContext = useMentionStreamContext(workspaceId, hostStream)

  // Whether the host is end-to-end-encrypted. Read from the synced IDB stream row
  // (`useStreamFromStore`) as the authority, NOT just the workspace cache: a
  // thread card's host is absent from `useWorkspaceStreams` (it holds sidebar
  // streams) but the board syncs every on-screen card's host into `db.streams`
  // (useBoardStreamSubscriptions), so the IDB row carries `e2eEnabled` where the
  // workspace cache has no row. Falling back to the cache alone would skip the
  // block below for thread hosts.
  const idbHostStream = useStreamFromStore(streamId)
  const hostIsE2e = hostStream?.e2eEnabled === true || idbHostStream?.e2eEnabled === true

  const draftKey = `board:reply:${post.conversation.id}`
  const composer = useDraftComposer({ workspaceId, draftKey, scopeId: draftKey })

  // Imperative handle for post-quote focus. A ref to the composer keeps the
  // insertion off the un-memoized composer object (a fresh identity every render),
  // so it fires only when a new quote arrives.
  const composerControlRef = useRef<ComposerControlHandle | null>(null)
  const composerRef = useRef(composer)
  composerRef.current = composer
  // Append the quote once its target composer exists. Gate on `isLoaded` and defer
  // a frame: a quote from a collapsed card mounts this form fresh, and a saved
  // draft late-hydrates into the empty editor on the load commit. Inserting in that
  // same flush would run last and clobber the draft (our setContent wins over the
  // hydrate's), so we wait for the draft body to land, then append onto it — the
  // same preserve-what's-there append the stream composer does.
  useEffect(() => {
    if (!pendingQuote || !composer.isLoaded) return
    const raf = requestAnimationFrame(() => {
      composerRef.current.setContent(appendQuoteReplyNode(composerRef.current.content, pendingQuote))
      composerControlRef.current?.focusAfterQuoteReply()
      onQuoteConsumed()
    })
    return () => cancelAnimationFrame(raf)
  }, [pendingQuote, composer.isLoaded, onQuoteConsumed])

  const canSubmit = composer.canSend && !reply.isPending

  // Collapse back to the one-line affordance when focus leaves an empty reply —
  // the native composer feel. A draft with content (text or a pending upload)
  // stays open and persists; abandoning means clearing it. The latest emptiness
  // is read through a ref so the deferred check sees current state without
  // re-binding the handler each keystroke.
  const containerRef = useRef<HTMLDivElement>(null)
  const isEmptyRef = useRef(true)
  isEmptyRef.current = isEmptyContent(composer.content) && composer.pendingAttachments.length === 0

  const handleBlur = useCallback(() => {
    // Defer past the focusout: focus may be landing on a sibling control, or on
    // a popover that portals out of this subtree (guarded above). Collapse only
    // once focus has truly left and the draft is empty.
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      // The page itself lost focus — a native file picker opened or the user
      // switched tab/app. Keep the draft open; they're mid-action.
      if (!document.hasFocus()) return
      const active = document.activeElement
      if (active && (container.contains(active) || active.closest(COMPOSER_POPOVER_SELECTOR))) return
      if (!isEmptyRef.current) return
      onClose()
    })
  }, [onClose])

  const handleSubmit = async (editorContent?: JSONContent) => {
    if (!composer.canSend) return

    // Board replies into an end-to-end-encrypted host aren't supported: the send
    // path here is plaintext (a sealed send is rejected by INV-E1), and the
    // boundary extractor skips E2E streams so the reply couldn't be assigned to
    // this conversation anyway. Surface it instead of queuing a doomed send —
    // E2E board replies belong to the encrypted-streams workstream. The draft is
    // kept so nothing the user typed is lost.
    if (hostIsE2e) {
      toast.error("Encrypted notes can't be replied to from the board yet — open the note to reply there.")
      return
    }

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const attachments = extractUploadedAttachments(normalizedContent)
    const attachmentIds = attachments.map((a) => a.id)

    composer.setIsSending(true)
    // Clear the editor up front so it empties in the same frame the optimistic
    // reply appears on the card — otherwise the just-sent text lingers in the
    // composer for a frame next to its own posted copy. Restored on failure so
    // nothing the user typed is lost.
    composer.setContent(EMPTY_DOC)
    try {
      // Eager + offline-first: the reply is enqueued as an optimistic event and
      // the send drains in the background, so there's no created message to await.
      // Every reply joins the same conversation and rides the card's own (merged)
      // rail — an `intoConversation` reply shows in place, and a `convertToThread`
      // reply shows in place too now that it stays one conversation (no card swap),
      // so a successful send just collapses the affordance.
      await reply.mutateAsync({
        conversation: post.conversation,
        openingMessageId: post.openingMessage?.id ?? null,
        hostStreamType,
        messageCount: post.conversation.messageIds.length,
        lastActiveStreamId,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
      await composer.resolveDraft()
      composer.clearAttachments()
      onClose({ refocus: true })
    } catch {
      composer.setContent(normalizedContent)
      toast.error("Couldn't post your reply. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  // The composer carries its own bordered, collapse-on-focus chrome and toolbar,
  // so it sits directly on the card — no wrapper frame, which would double the
  // border and leave an empty header strip. Dismissal instead of a cancel
  // control: an empty reply collapses on blur (handleBlur); Escape collapses
  // even a non-empty draft and returns focus to the trigger (onEscapeBlur).
  return (
    <div ref={containerRef} className="mt-3" onBlur={handleBlur}>
      <MessageComposer
        composerRef={composerControlRef}
        content={composer.content}
        onContentChange={composer.handleContentChange}
        pendingAttachments={composer.pendingAttachments}
        onRemoveAttachment={composer.handleRemoveAttachment}
        workspaceId={workspaceId}
        streamId={hostStream?.id}
        memoAnchorStreamId={streamId}
        fileInputRef={composer.fileInputRef}
        onFileSelect={composer.handleFileSelect}
        onFileUpload={composer.uploadFile}
        imageCount={composer.imageCount}
        onSubmit={handleSubmit}
        canSubmit={canSubmit}
        isSubmitting={composer.isSending}
        hasFailed={composer.hasFailed}
        placeholder="Write a reply…"
        messageSendMode={preferences?.messageSendMode ?? "enter"}
        autoFocus
        initialMobileChromeOpen
        scopeId={draftKey}
        streamContext={streamContext}
        // Escape (when no @/emoji/slash popup is open) collapses the reply and
        // returns focus to the trigger — a keyboard cancel even with a draft,
        // which the empty-only blur-collapse doesn't cover. Flush the draft to
        // IDB FIRST: collapsing unmounts the form, which cancels the in-flight
        // debounced save, so without this the just-typed draft would live only
        // in localStorage (reconciled at startup) and a mid-session reopen would
        // read an empty editor — a false "Continue reply…".
        onEscapeBlur={() => {
          const hadContent = !isEmptyRef.current
          void composer.flushDraft()
          onClose({ refocus: true, hadContent })
        }}
      />
    </div>
  )
}
