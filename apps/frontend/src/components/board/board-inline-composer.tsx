import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CornerDownRight, X } from "lucide-react"
import { toast } from "sonner"
import {
  MessageComposer,
  FloatingComposerShell,
  OverlayComposerShell,
  ConversationReplyStrip,
  ScheduledMessagesPicker,
  StashedDraftsPicker,
  useFloatingComposerAnchor,
  FLOATING_COMPOSER_HEIGHT_VAR,
  type ComposerControlHandle,
} from "@/components/composer"
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { appendQuoteReplyNode, type QuoteReplyData } from "@/components/timeline/quote-reply-context"
import { useDraftComposer, useScheduleMessage, useStashComposer } from "@/hooks"
import { relocateLoadedDraft } from "@/hooks/use-draft-message"
import { useOptionalSyncEngine } from "@/sync/sync-engine"
import { usePreferences } from "@/contexts"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useStreamName } from "@/hooks/use-stream-name"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { useStreamFromStore } from "@/stores/stream-store"
import { STREAM_ICONS } from "@/lib/streams"
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
  /**
   * Docked host (the conversation panel footer): the form is permanently
   * mounted and never portals to the mobile floating pill — the footer IS the
   * dock. On mobile the collapsed presentation is `MessageComposer`'s own
   * collapsed bar (timeline parity), so it starts unfocused rather than open.
   */
  docked?: boolean
  /**
   * Dismissible reply-target strip (timeline `conversationReplyStrip` parity):
   * arms this composer to a sub-conversation. The × flushes the live buffer,
   * moves the draft rows from this scope to `moveDraftToKey` (the root reply
   * scope), then calls `onCancel` to disarm — so the typed content survives
   * visibly under the root composer. Takes the place of `contextChip`.
   */
  replyTarget?: { title: string; moveDraftToKey: string; onCancel: () => void }
  /**
   * Restore a roamed/stashed draft when `signal` increments — arming a docked
   * composer to a branch whose advertised draft isn't checked out here has no
   * remount to hang `restoreStashedIdOnMount` on, so the restore is a nonce.
   */
  restoreOnSignal?: { stashId: string | null; signal: number }
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
  /**
   * Enables the schedule-send picker. A scheduled send can't run the call
   * site's live routing at fire time, so the resolved target is declared up
   * front: the stream the fired message posts into plus the conversation it
   * files into (`{ intent: "existing" }`, matching the timeline composer's
   * armed-reply scheduling). Omit where the target doesn't exist until send —
   * a new sub-topic or a still-pending branch — and the affordance is absent.
   */
  scheduleTarget?: { streamId: string; conversationId: string }
  /**
   * Stash row to check out once the composer mounts. Set by a resting
   * affordance that advertised a stashed/roamed draft (the loaded pointer is
   * device-local, so the row won't hydrate by itself) — opening must surface
   * the very draft the affordance showed. Consumed once, on mount.
   */
  restoreStashedIdOnMount?: string | null
  /**
   * Monotonic nonce: each increment focuses the editor. For always-mounted
   * hosts (the desktop conversation panel), where "open the reply composer"
   * requests can't be expressed as a mount.
   */
  focusSignal?: number
  /** Perform the send. Throws to keep the composer open and restore the draft. */
  onSubmit: (input: InlineComposerSubmit) => Promise<void>
  /** Collapse the composer (Escape / after-send / blur-when-empty). */
  onClose: (opts?: { refocus?: boolean }) => void
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
  docked,
  replyTarget,
  restoreOnSignal,
  autoFocus = true,
  pendingQuote,
  onQuoteConsumed,
  rejectE2e,
  scheduleTarget,
  restoreStashedIdOnMount,
  focusSignal,
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
  const syncEngine = useOptionalSyncEngine()
  // "Save for later" pile scoped to this reply target — the same pointer-move
  // stash the timeline composer has, so a half-written inline reply survives
  // switching cards without hijacking the ambient draft slot.
  const stash = useStashComposer(composer, workspaceId, draftKey)
  const scheduleMessage = useScheduleMessage(workspaceId)

  // Check out the advertised stash row once (mount-captured; the guard ref, not
  // the effect deps, enforces once — `stash` is a fresh object every render).
  const restoreOnMountRef = useRef(restoreStashedIdOnMount ?? null)
  useEffect(() => {
    const id = restoreOnMountRef.current
    if (!id || !composer.isLoaded) return
    restoreOnMountRef.current = null
    void stash.handleRestoreStashed(id)
  }, [composer.isLoaded, stash])

  // Focus-on-signal for always-mounted hosts (skip the mount value — focus on
  // mount is `autoFocus`'s job).
  const lastFocusSignalRef = useRef(focusSignal)
  useEffect(() => {
    if (focusSignal === undefined || focusSignal === lastFocusSignalRef.current) return
    lastFocusSignalRef.current = focusSignal
    composerControlRef.current?.focus()
  }, [focusSignal])

  // Restore-on-signal: an always-mounted host arming to a new target whose
  // advertised draft is roamed (not checked out here). No remount fires
  // `restoreStashedIdOnMount`, so the check-out rides a nonce instead. The ref
  // advances only once the restore actually fires (a signal that lands before
  // the composer loads is retried on the next render, not swallowed).
  const lastRestoreSignalRef = useRef(restoreOnSignal?.signal)
  useEffect(() => {
    if (!restoreOnSignal || restoreOnSignal.signal === lastRestoreSignalRef.current) return
    if (!restoreOnSignal.stashId) {
      lastRestoreSignalRef.current = restoreOnSignal.signal
      return
    }
    if (!composer.isLoaded) return
    lastRestoreSignalRef.current = restoreOnSignal.signal
    void stash.handleRestoreStashed(restoreOnSignal.stashId)
  }, [restoreOnSignal, composer.isLoaded, stash])

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

  // Fullscreen expand — the same overlay shell the timeline and the New Post
  // composer use, so a long reply gets the same full-document editor instead of
  // being stuck in the compact card-reply box.
  const [expanded, setExpanded] = useState(false)
  const overlayStreamName = useStreamName(workspaceId, streamId ?? "")
  const OverlayStreamGlyph = hostStream ? STREAM_ICONS[hostStream.type] : null

  const containerRef = useRef<HTMLDivElement>(null)
  const isEmptyRef = useRef(true)
  isEmptyRef.current = isEmptyContent(composer.content) && composer.pendingAttachments.length === 0

  // Mobile: portal the open form into the surface's floating-composer anchor as
  // the stream's floating pill (shared FloatingComposerShell), pinned to the
  // visible bottom above the keyboard, instead of expanding in place mid-scroll.
  // Desktop (or a surface without an anchor) keeps the in-place form. "Mobile"
  // here matches the panel/page full-screen breadth (`useSidebar().isMobile`,
  // the same `useIsMobileOrCoarse` predicate — viewport OR coarse pointer), not
  // bare viewport width: a coarse-pointer tablet ≥640px full-screens the panel,
  // so its inline form must float too rather than render mid-flow under the
  // message. A docked host never floats: the footer is the dock, so it keeps the
  // in-place form on every device.
  const isMobileOrCoarse = useIsMobileOrCoarse()
  const anchor = useFloatingComposerAnchor()
  const floating = isMobileOrCoarse && anchor !== null && !docked
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
    onCloseRef.current()
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

  const handleFloatingClose = useCallback(async () => {
    // Await the flush: the resting bar's draft preview reads the persisted row
    // (Dexie liveQuery), so closing before the write commits would flash the
    // bare placeholder over content typed within the last debounce window.
    await composerRef.current.flushDraft()
    // No refocus: returning focus to the resting button after a touch dismissal
    // would draw a focus ring the user never keyboard-navigated to.
    onCloseRef.current()
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
    const attachments = extractUploadedAttachments(normalizedContent)
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

  /**
   * Schedule the current content for a future send. Mirrors `handleSubmit`
   * (materialize refs, clear up front, restore on failure) but routes to the
   * schedule API against the declared `scheduleTarget` instead of the call
   * site's live routing — the fired message posts into the target stream and
   * the assigner attaches it to the conversation by id.
   */
  const handleSchedule = async (when: Date) => {
    if (!composer.canSend || !scheduleTarget) return

    if (rejectE2e && hostIsE2e) {
      toast.error(rejectE2e)
      return
    }

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const normalizedContent = materializePendingAttachmentReferences(composer.content, pendingAttachments)
    const attachmentIds = extractUploadedAttachments(normalizedContent).map((a) => a.id)

    composer.setIsSending(true)
    composer.setContent(EMPTY_DOC)
    try {
      await scheduleMessage.mutateAsync({
        streamId: scheduleTarget.streamId,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        scheduledFor: when.toISOString(),
        conversation: { intent: "existing", conversationId: scheduleTarget.conversationId },
      })
      await composer.resolveDraft()
      composer.clearAttachments()
      onClose({ refocus: true })
    } catch {
      composer.setContent(normalizedContent)
      toast.error("Couldn't schedule. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  // Inline drafts are plaintext (no `e2eStreamId` on the composer above), so the
  // picker's own `contentJson` fallback previews suffice — no decrypt pass.
  const stashPickerProps = {
    drafts: stash.drafts,
    canStashCurrent: composer.canSend,
    onStashCurrent: stash.handleStashDraft,
    onRestore: stash.handleRestoreStashed,
    onDelete: stash.handleDeleteStashed,
    controlsDisabled: composer.isSending,
  } as const

  const schedulePickerProps = scheduleTarget
    ? ({
        workspaceId,
        streamId: scheduleTarget.streamId,
        canSchedule: composer.canSend,
        onSchedule: handleSchedule,
        controlsDisabled: composer.isSending,
      } as const)
    : null

  const contextChipNode = contextChip ? (
    <div className="flex w-fit min-w-0 max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <CornerDownRight className="h-3 w-3 shrink-0" />
      <span className="truncate">{contextChip}</span>
    </div>
  ) : null

  // Cancel the armed sub-conversation target: relocate the draft (live editor
  // content wins) into the root reply scope, then disarm. `relocateLoadedDraft`
  // deletes the source rather than re-scoping the row — an in-flight push
  // snapshotted under the branch scope would otherwise land last and reinstate
  // it server-side; the delete's tombstone suppresses exactly that. The content
  // re-reads under root via the scope-change rehydrate once `onCancel` flips
  // the draft key.
  const handleCancelReplyTarget = useCallback(async () => {
    if (!replyTarget) return
    // Flush FIRST: `saveDraft` clears the armed typing debounce, whose closure
    // is bound to the branch scope — the composer never unmounts on cancel
    // (only its draftKey flips), so an unfired timer would otherwise outlive
    // the relocate and mint a fresh draft under the vacated scope. In-flight
    // saves past the timer are dropped by the resolve-seq bump inside
    // `relocateLoadedDraft`.
    await composerRef.current.flushDraft()
    await relocateLoadedDraft(workspaceId, draftKey, replyTarget.moveDraftToKey, composer.content)
    syncEngine?.kickOperationQueue()
    replyTarget.onCancel()
  }, [replyTarget, workspaceId, draftKey, syncEngine, composer.content])

  // Armed reply-target strip — the send's only signal that it files into a
  // sub-conversation, matching the timeline's dismissible strip. Replaces the
  // context chip when present (the panel arms; board cards use the chip).
  const replyTargetNode = replyTarget ? (
    <ConversationReplyStrip title={replyTarget.title} onCancel={() => void handleCancelReplyTarget()} />
  ) : null

  // Shared by the inline editor and the fullscreen one below — same draft,
  // same send path, same everything except layout.
  const sharedComposerProps = {
    content: composer.content,
    onContentChange: composer.handleContentChange,
    pendingAttachments: composer.pendingAttachments,
    onRemoveAttachment: composer.handleRemoveAttachment,
    onCancelAttachmentUpload: composer.handleCancelAttachmentUpload,
    workspaceId,
    streamId: hostStream?.id,
    memoAnchorStreamId,
    fileInputRef: composer.fileInputRef,
    onFileSelect: composer.handleFileSelect,
    onFileUpload: composer.uploadFile,
    imageCount: composer.imageCount,
    onSubmit: handleSubmit,
    canSubmit,
    isSubmitting: composer.isSending,
    hasFailed: composer.hasFailed,
    placeholder,
    messageSendMode: preferences?.messageSendMode ?? "enter",
    scopeId: draftKey,
    streamContext,
    onStashDraft: stash.handleStashDraft,
    stashedDraftsTrigger: <StashedDraftsPicker {...stashPickerProps} />,
    stashedDraftsTriggerFab: <StashedDraftsPicker {...stashPickerProps} size="fab" />,
    scheduledMessagesTrigger: schedulePickerProps ? <ScheduledMessagesPicker {...schedulePickerProps} /> : undefined,
    scheduledMessagesTriggerFab: schedulePickerProps ? (
      <ScheduledMessagesPicker {...schedulePickerProps} size="fab" />
    ) : undefined,
  } as const

  const editor = (
    <MessageComposer
      {...sharedComposerProps}
      composerRef={composerControlRef}
      autoFocus={autoFocus}
      // Docked hosts start collapsed on mobile (MessageComposer's own
      // collapsed⇄focused bar — timeline parity); the mount-and-focus floating
      // pill starts open.
      initialMobileChromeOpen={!docked}
      // Gated on `floating`, not bare `isMobile`: the floating form's
      // height-publish effect keys off its mount lifecycle (`holdsFloatingSlot`),
      // which an `expanded` escape hatch would sidestep, leaving a stale
      // reserved-space CSS var behind — so only the floating pill suppresses
      // expand. In-place forms (desktop, and the docked panel footer on every
      // device) keep it.
      onExpandClick={floating ? undefined : () => setExpanded(true)}
      onEscapeBlur={async () => {
        // Awaited for the same reason as handleFloatingClose: a fast
        // type-then-Escape must not flash the bare placeholder while the
        // just-typed draft's row is still being written.
        await composer.flushDraft()
        onClose({ refocus: true })
      }}
    />
  )

  // Fullscreen expand — the same overlay shell the timeline and New Post use, so
  // a reply gets the same full-document editor instead of being stuck in the
  // compact card-reply box. Desktop only (see `editor` above); `OverlayComposerShell`
  // no-ops (renders nothing) while `expanded` is false.
  const fullscreenEditor = (
    <OverlayComposerShell
      open={expanded}
      onOpenChange={setExpanded}
      title="Message editor"
      header={
        <div className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border bg-background px-3 text-sm font-medium">
          {OverlayStreamGlyph && <OverlayStreamGlyph className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{overlayStreamName ?? "This conversation"}</span>
        </div>
      }
    >
      <div className="min-h-0 flex-1">
        <MessageComposer
          {...sharedComposerProps}
          expanded
          hideExpandedClose
          onCollapse={() => setExpanded(false)}
          autoFocus
        />
      </div>
    </OverlayComposerShell>
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
    <div ref={containerRef} className={docked ? undefined : "mt-3"} onBlur={handleBlur}>
      {replyTargetNode ?? (contextChipNode && <div className="mb-1">{contextChipNode}</div>)}
      {fullscreenEditor}
      {!expanded && editor}
    </div>
  )
}
