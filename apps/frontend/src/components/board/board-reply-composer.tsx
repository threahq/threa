import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { MessageComposer } from "@/components/composer"
import { useDraftComposer } from "@/hooks"
import { usePreferences } from "@/contexts"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useReplyToBoardPost } from "@/hooks/use-conversations"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { EMPTY_DOC, isEmptyContent } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import type { BoardPost, JSONContent, Message } from "@threa/types"

// Focus moving into one of these means a composer popover is open (the inline
// suggestion lists render as `[role="listbox"]`; emoji/format/link popovers are
// Radix poppers; the mobile drawer is a dialog) — all portal outside the
// composer subtree, so blur-to-collapse must treat them as "still editing"
// rather than a dismissal. document-editor-modal.tsx guards its suggestion
// popover the same way (`[role="listbox"]`); this set is broader to also cover
// the Radix poppers and dialog.
const COMPOSER_POPOVER_SELECTOR = '[role="listbox"],[data-radix-popper-content-wrapper],[role="dialog"]'

// Resting-affordance state. `draft` signals a persisted-but-collapsed reply (so
// the user knows reopening restores it); `posted` is a transient confirmation
// that a new-thread reply went through — it stands in for the in-place echo a
// same-conversation reply gets, since a new-thread reply lands in its own
// conversation and only surfaces on the next board load.
type RestingState = "idle" | "draft" | "posted"
const RESTING_LABEL: Record<RestingState, string> = {
  idle: "Write a reply…",
  draft: "Continue reply…",
  posted: "Posted to a new thread",
}
// How long the transient "posted" confirmation stays before the affordance
// returns to its normal invitation.
const POSTED_NOTE_MS = 4000

interface BoardReplyComposerProps {
  workspaceId: string
  post: BoardPost
  /** Host stream type of the post's conversation, selecting the reply routing. */
  hostStreamType: string | undefined
  /** Called with the created reply so the card can show it in place. */
  onReplied: (message: Message) => void
}

/**
 * Inline reply affordance on a board card. Collapsed to a single resting line
 * so the feed stays scannable; tapping it mounts the real composer in place (the
 * heavy editor mounts only once a card is activated, so a feed of cards costs one
 * lightweight button each, not one composer each). The button deliberately
 * mirrors the composer's own container — same radius, border, surface, padding,
 * and placeholder — and the composer mounts already open (`initialMobileChromeOpen`)
 * so the tap lands straight in the toolbar view instead of stepping through the
 * mobile compacted phase. Routing — channel → thread, everything else → the
 * conversation — lives in {@link useReplyToBoardPost}.
 *
 * The resting affordance carries state (best-effort, in-session): it flags a
 * persisted draft after an Escape ("Continue reply…") and a transient "Posted to
 * a new thread" confirmation after a new-thread send, so a collapse never reads
 * as a no-op or an accidental discard.
 */
export function BoardReplyComposer(props: BoardReplyComposerProps) {
  const [open, setOpen] = useState(false)
  const [resting, setResting] = useState<RestingState>("idle")
  const buttonRef = useRef<HTMLButtonElement>(null)
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

  // Let the transient "posted" confirmation fade back to the normal invitation.
  useEffect(() => {
    if (resting !== "posted") return
    const timer = window.setTimeout(() => setResting("idle"), POSTED_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [resting])

  const close = useCallback((opts?: { refocus?: boolean; hadContent?: boolean; posted?: boolean }) => {
    refocusOnCollapseRef.current = opts?.refocus ?? false
    if (opts?.posted) setResting("posted")
    else if (opts?.hadContent) setResting("draft")
    else setResting("idle")
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
        {/* Label-only confirmation: the text IS the in-place signal. No leading
            icon — adding one only in the "posted" state would shift the label
            (INV-21) and misalign the resting text against the open composer's. */}
        <span className="truncate">{RESTING_LABEL[resting]}</span>
      </button>
    )
  }

  return <BoardReplyComposerForm {...props} onClose={close} />
}

function BoardReplyComposerForm({
  workspaceId,
  post,
  hostStreamType,
  onReplied,
  onClose,
}: BoardReplyComposerProps & {
  onClose: (opts?: { refocus?: boolean; hadContent?: boolean; posted?: boolean }) => void
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

  const draftKey = `board:reply:${post.conversation.id}`
  const composer = useDraftComposer({ workspaceId, draftKey, scopeId: draftKey })

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

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const attachmentIds = extractUploadedAttachments(normalizedContent).map((a) => a.id)

    composer.setIsSending(true)
    try {
      const { message, plan } = await reply.mutateAsync({
        conversation: post.conversation,
        openingMessageId: post.openingMessage?.id ?? null,
        hostStreamType,
        messageCount: post.conversation.messageIds.length,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })
      composer.setContent(EMPTY_DOC)
      await composer.resolveDraft()
      composer.clearAttachments()
      // Only an `intoConversation` reply belongs under this card; a `newThread`
      // reply lives in its own thread conversation and surfaces as its own board
      // post on the next load, so showing it here would render it under the wrong
      // card with stream-mismatched action links. The visible in-place reply IS
      // the feedback for the former; the latter gets a transient resting note
      // instead, since nothing changes on this card.
      if (plan.kind === "intoConversation") onReplied(message)
      onClose({ refocus: true, posted: plan.kind === "newThread" })
    } catch {
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
