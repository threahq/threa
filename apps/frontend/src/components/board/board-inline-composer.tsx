import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react"
import { createPortal } from "react-dom"
import { CornerDownRight, X } from "lucide-react"
import { toast } from "sonner"
import {
  MessageComposer,
  FloatingComposerShell,
  useFloatingComposerAnchor,
  FLOATING_COMPOSER_HEIGHT_VAR,
  type ComposerControlHandle,
} from "@/components/composer"
import { useIsMobile } from "@/hooks/use-mobile"
import { appendQuoteReplyNode, type QuoteReplyData } from "@/components/timeline/quote-reply-context"
import { useDraftComposer } from "@/hooks"
import { usePreferences } from "@/contexts"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { EMPTY_DOC, isEmptyContent } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import type { AttachmentSummary } from "@/hooks/create-optimistic-bootstrap"
import type { JSONContent } from "@threa/types"

// Focus moving into one of these means a composer popover is open (inline
// suggestion lists are `[role="listbox"]`; emoji/format/link popovers are Radix
// poppers; the mobile drawer is a dialog) — all portal outside the composer
// subtree, so blur-to-collapse treats them as "still editing" rather than a
// dismissal. Shared by every inline composer surface.
const COMPOSER_POPOVER_SELECTOR = '[role="listbox"],[data-radix-popper-content-wrapper],[role="dialog"]'

export interface InlineComposerSubmit {
  contentJson: JSONContent
  attachmentIds?: string[]
  attachments?: AttachmentSummary[]
}

interface InlineComposerFormProps {
  workspaceId: string
  /** Host stream backing mention autocomplete + attachment uploads. A thread host
   *  may be absent from the workspace cache; the composer degrades (no mention
   *  context) rather than failing. */
  streamId: string | undefined
  /** Memo/attachment anchor — the conversation's own stream. */
  memoAnchorStreamId: string
  /** Draft persistence key (per target), so an escaped draft survives a reopen. */
  draftKey: string
  placeholder: string
  /** Chip above the editor naming the reply target (e.g. "Replying in GPU
   *  budget") — the inline forms all look alike, so the target must be legible
   *  at the composer itself, not inferred from indentation. */
  contextChip?: string
  autoFocus?: boolean
  pendingQuote?: QuoteReplyData | null
  onQuoteConsumed?: () => void
  /**
   * When the resolved host is end-to-end-encrypted, block the send with this
   * message instead of queuing a doomed plaintext write (the backend rejects a
   * sealed send — INV-E1 — and the extractor skips E2E streams). The draft is
   * kept so nothing typed is lost.
   */
  rejectE2e?: string
  /** Perform the send. Throws to keep the composer open and restore the draft. */
  onSubmit: (input: InlineComposerSubmit) => Promise<void>
  /** Collapse the composer (Escape / after-send / blur-when-empty). */
  onClose: (opts?: { refocus?: boolean; hadContent?: boolean }) => void
}

/**
 * The shared inline-composer core (INV-35): a compact `MessageComposer` with
 * draft persistence, blur-when-empty collapse, Escape collapse, quote-reply
 * insertion, and clear-on-send — with the *send itself* left to `onSubmit`. The
 * board card's bottom reply, a branch group's tail reply, and the "new sub-topic"
 * gesture all mount this and supply their own routing, so the editor mechanics
 * live in exactly one place.
 */
export function InlineComposerForm({
  workspaceId,
  streamId,
  memoAnchorStreamId,
  draftKey,
  placeholder,
  contextChip,
  autoFocus = true,
  pendingQuote,
  onQuoteConsumed,
  rejectE2e,
  onSubmit,
  onClose,
}: InlineComposerFormProps) {
  const { preferences } = usePreferences()
  const streams = useWorkspaceStreams(workspaceId)
  const hostStream = useMemo<CachedStream | undefined>(
    () => (streamId ? streams.find((s) => s.id === streamId) : undefined),
    [streams, streamId]
  )
  const streamContext = useMentionStreamContext(workspaceId, hostStream)
  // E2E state from the synced IDB row as authority (a thread host is absent from
  // the workspace cache but the board syncs its row), OR the workspace cache.
  const idbHostStream = useStreamFromStore(streamId)
  const hostIsE2e = hostStream?.e2eEnabled === true || idbHostStream?.e2eEnabled === true

  const composer = useDraftComposer({ workspaceId, draftKey, scopeId: draftKey })

  const composerControlRef = useRef<ComposerControlHandle | null>(null)
  const composerRef = useRef(composer)
  composerRef.current = composer
  // Append a quote once the composer exists; defer a frame so a saved draft's
  // late hydrate lands first (else our setContent would clobber it), matching the
  // board reply composer's insertion timing.
  useEffect(() => {
    if (!pendingQuote || !composer.isLoaded) return
    const raf = requestAnimationFrame(() => {
      composerRef.current.setContent(appendQuoteReplyNode(composerRef.current.content, pendingQuote))
      composerControlRef.current?.focusAfterQuoteReply()
      onQuoteConsumed?.()
    })
    return () => cancelAnimationFrame(raf)
  }, [pendingQuote, composer.isLoaded, onQuoteConsumed])

  const canSubmit = composer.canSend

  const containerRef = useRef<HTMLDivElement>(null)
  const isEmptyRef = useRef(true)
  isEmptyRef.current = isEmptyContent(composer.content) && composer.pendingAttachments.length === 0

  // Mobile: portal the open form into the surface's floating-composer anchor as
  // the stream's floating pill (shared FloatingComposerShell), pinned to the
  // visible bottom above the keyboard, instead of expanding in place mid-scroll.
  // Desktop (or a surface without an anchor) keeps the in-place form.
  const isMobile = useIsMobile()
  const anchor = useFloatingComposerAnchor()
  const floating = isMobile && anchor !== null
  const formId = useId()
  const anchorEl = anchor?.el
  const claim = anchor?.claim
  const release = anchor?.release
  const claimantId = anchor?.claimantId
  // The portal renders only while the slot is free or held by this form. Two
  // forms are briefly mounted during a hand-off (the loser closes via a passive
  // effect, one commit after the winner's claim lands) — gating the render, not
  // just the close, is what keeps two pills from ever stacking in the anchor.
  // `null` renders immediately so the common single-open case doesn't flash a
  // frame of nothing while its own claim effect is still pending.
  const holdsFloatingSlot = floating && (claimantId === null || claimantId === formId)

  useEffect(() => {
    if (!floating || !claim || !release) return
    claim(formId)
    return () => release(formId)
  }, [floating, claim, release, formId])

  // The anchor's floating slot is exclusive: when another form claims it,
  // collapse back to the resting affordance. Only after having *held* the claim
  // — on mount this effect runs before our own claim lands, and closing on that
  // stale claimant would collapse the form the instant it opens.
  const wasClaimantRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!floating) return
    if (claimantId === formId) {
      wasClaimantRef.current = true
      return
    }
    if (!wasClaimantRef.current) return
    void composerRef.current.flushDraft()
    onCloseRef.current({ hadContent: !isEmptyRef.current })
  }, [floating, claimantId, formId])

  // Publish the shell's height so the anchor's scrollable content can reserve
  // bottom space while the composer floats over it. Ownership-tagged: during a
  // slot hand-off the outgoing form unmounts after the incoming one has already
  // measured, and must not wipe the incoming form's value.
  const shellRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!holdsFloatingSlot || !anchorEl) return
    const shell = shellRef.current
    if (!shell) return
    const write = () => {
      anchorEl.style.setProperty(FLOATING_COMPOSER_HEIGHT_VAR, `${Math.ceil(shell.getBoundingClientRect().height)}px`)
      anchorEl.dataset.floatingComposerOwner = formId
    }
    write()
    const ro = new ResizeObserver(write)
    ro.observe(shell)
    return () => {
      ro.disconnect()
      if (anchorEl.dataset.floatingComposerOwner === formId) {
        anchorEl.style.removeProperty(FLOATING_COMPOSER_HEIGHT_VAR)
        delete anchorEl.dataset.floatingComposerOwner
      }
    }
  }, [holdsFloatingSlot, anchorEl, formId])

  // Keep the reply target visible: the marker sits where the form would render
  // in place, so scrolling it into view parks the tail of the conversation above
  // the floating pill. Re-centered on anchor shrink for the opening beat only —
  // the keyboard resizes the layout viewport shortly after focus, hiding the
  // bottom of the scroller — then scrolling is the user's.
  const markerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!holdsFloatingSlot || !anchorEl) return
    const center = () => markerRef.current?.scrollIntoView({ block: "center" })
    const raf = requestAnimationFrame(center)
    const deadline = performance.now() + 2000
    let lastHeight = anchorEl.clientHeight
    const ro = new ResizeObserver(() => {
      const height = anchorEl.clientHeight
      if (height < lastHeight && performance.now() < deadline) center()
      lastHeight = height
    })
    ro.observe(anchorEl)
    const timer = setTimeout(() => ro.disconnect(), 2200)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [holdsFloatingSlot, anchorEl])

  const handleFloatingClose = useCallback(() => {
    void composerRef.current.flushDraft()
    // No refocus: returning focus to the resting button after a touch dismissal
    // would draw a focus ring the user never keyboard-navigated to.
    onCloseRef.current({ hadContent: !isEmptyRef.current })
  }, [])

  const handleBlur = useCallback(() => {
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container) return
      if (!document.hasFocus()) return
      const active = document.activeElement
      if (active && (container.contains(active) || active.closest(COMPOSER_POPOVER_SELECTOR))) return
      if (!isEmptyRef.current) return
      onClose()
    })
  }, [onClose])

  const handleSubmit = async (editorContent?: JSONContent) => {
    if (!composer.canSend) return

    if (rejectE2e && hostIsE2e) {
      toast.error(rejectE2e)
      return
    }

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const attachments = extractUploadedAttachments(normalizedContent, pendingAttachments)
    const attachmentIds = attachments.map((a) => a.id)

    composer.setIsSending(true)
    // Clear the editor up front so it empties in the same frame the optimistic
    // row appears; restored on failure so nothing typed is lost.
    composer.setContent(EMPTY_DOC)
    try {
      await onSubmit({
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
      await composer.resolveDraft()
      composer.clearAttachments()
      onClose({ refocus: true })
    } catch {
      composer.setContent(normalizedContent)
      toast.error("Couldn't post. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  const contextChipNode = contextChip ? (
    <div className="flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <CornerDownRight className="h-3 w-3 shrink-0" />
      <span className="truncate">{contextChip}</span>
    </div>
  ) : null

  const editor = (
    <MessageComposer
      composerRef={composerControlRef}
      content={composer.content}
      onContentChange={composer.handleContentChange}
      pendingAttachments={composer.pendingAttachments}
      onRemoveAttachment={composer.handleRemoveAttachment}
      onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
      workspaceId={workspaceId}
      streamId={hostStream?.id}
      memoAnchorStreamId={memoAnchorStreamId}
      fileInputRef={composer.fileInputRef}
      onFileSelect={composer.handleFileSelect}
      onFileUpload={composer.uploadFile}
      imageCount={composer.imageCount}
      onSubmit={handleSubmit}
      canSubmit={canSubmit}
      isSubmitting={composer.isSending}
      hasFailed={composer.hasFailed}
      placeholder={placeholder}
      messageSendMode={preferences?.messageSendMode ?? "enter"}
      autoFocus={autoFocus}
      initialMobileChromeOpen
      scopeId={draftKey}
      streamContext={streamContext}
      onEscapeBlur={() => {
        const hadContent = !isEmptyRef.current
        void composer.flushDraft()
        onClose({ refocus: true, hadContent })
      }}
    />
  )

  if (floating && anchorEl) {
    return (
      <>
        {/* In-place marker: the scroll target that stands in for the portaled
            form, keeping the reply target in view above the floating pill. */}
        <div ref={markerRef} data-floating-composer-marker aria-hidden />
        {holdsFloatingSlot &&
          createPortal(
            <FloatingComposerShell ref={shellRef}>
              <div ref={containerRef} onBlur={handleBlur}>
                <div className="mb-1 flex items-center gap-2">
                  {contextChipNode}
                  <button
                    type="button"
                    aria-label="Close composer"
                    onClick={handleFloatingClose}
                    className="ml-auto shrink-0 rounded-full bg-muted p-2 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {editor}
              </div>
            </FloatingComposerShell>,
            anchorEl
          )}
      </>
    )
  }

  return (
    <div ref={containerRef} className="mt-3" onBlur={handleBlur}>
      {contextChipNode && <div className="mb-1">{contextChipNode}</div>}
      {editor}
    </div>
  )
}
