import { useSearchParams } from "react-router-dom"
import { useContext, useMemo, useCallback, useEffect, useState, useRef, type RefObject } from "react"
import { createPortal } from "react-dom"
import { MessageSquare, ChevronLeft } from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import {
  useStreamBootstrap,
  useThreadAnchorEvent,
  useDraftComposer,
  getDraftMessageKey,
  useThreadAncestors,
  useQueueDraftMessage,
  useComposerHeightPublish,
  useStashComposer,
  useDecryptedDraftPreviews,
  useStashedDraftOrigins,
  useWorkspaceUserId,
  useExternalThreadDraftPromotion,
  useVisibleStreams,
} from "@/hooks"
import { useCoordinatedLoading, usePanel, isDraftPanel, parseDraftPanel, useSidebar } from "@/contexts"
import { useStreamEvents } from "@/stores/stream-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { onDraftPromoted } from "@/lib/draft-promotions"
import { StreamLoadingIndicator } from "@/components/loading"
import {
  EventList,
  groupTimelineItems,
  materializePendingAttachmentReferences,
  extractUploadedAttachments,
} from "@/components/timeline"
import { AsideCoversPanesContext } from "@/components/aside/aside-presentation"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { FloatingComposerShell, MessageComposer } from "@/components/composer"
import { ComposerEncryptionNotice } from "@/components/encryption/stream-encryption-affordance"
import { SidebarToggle } from "@/components/layout"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { ThreadParentEvent } from "./thread-parent-event"
import { matchesDeepLinkTarget } from "@/lib/stream-links"
import { ResponsiveBreadcrumbs } from "./responsive-breadcrumbs"
import { LabelableResourceTypes, StreamTypes } from "@threahq/types"
import { useMentionStreamContext, type MentionStreamContext } from "@/hooks/use-mentionables"
import { LabelStack } from "@/components/labels/label-stack"
import { PaneFocusToggle, PanelTabStrip, usePaneCovered, usePanelCloseFocusLanding } from "@/components/panes"
import { StreamPane } from "@/components/panes/stream-pane"
import { isServerStreamId } from "@/lib/stream-ids"
import { cn } from "@/lib/utils"

interface StreamPanelProps {
  workspaceId: string
  onClose: () => void
  className?: string
}

/** A stream tab: the stream's own pane with the tab's controls, or a thread not yet started. */
export function StreamPanel({ workspaceId, onClose, className }: StreamPanelProps) {
  const { isMobile } = useSidebar()
  const [searchParams] = useSearchParams()
  const covered = usePaneCovered()
  const { panelId, tabbed, openPanel, ownsCover, inFirstColumn, canClosePanel } = usePanel()
  const closeRef = usePanelCloseFocusLanding()
  // Under an aside, an overview opened from here would land out of sight.
  const offersContext = !useContext(AsideCoversPanesContext)
  useVisibleStreams(workspaceId, !covered && panelId && isServerStreamId(panelId) ? [panelId] : [])
  // Only a pane beside the first column shows it; the first column's stream would re-render on each load step for nothing.
  const isLoading = useCoordinatedLoading(
    (loading) => !inFirstColumn && !!panelId && loading.getStreamState(panelId) === "loading"
  )
  // Set by a draft thread's own send: the real thread's composer is a different
  // element, so a focused draft composer hands its focus over explicitly — on
  // mobile this is what keeps the keyboard up through the switch. Lives here
  // because the promotion keeps this component and swaps what it renders.
  const [focusPromotedComposer, setFocusPromotedComposer] = useState(false)
  const handlePromoted = useCallback(
    (realStreamId: string, focusComposer: boolean) => {
      setFocusPromotedComposer(focusComposer)
      // Replaces the draft panel rather than stacking on it — back must not
      // return to a draft id that no longer resolves.
      openPanel(realStreamId, { replace: true })
    },
    [openPanel]
  )

  if (!panelId) return null

  if (isDraftPanel(panelId)) {
    return (
      <DraftThreadPanel
        workspaceId={workspaceId}
        panelId={panelId}
        onClose={onClose}
        onPromoted={handlePromoted}
        closeRef={closeRef}
        className={className}
      />
    )
  }

  return (
    <StreamPane
      workspaceId={workspaceId}
      streamId={panelId}
      // The deep link is the front pane's: a background tab, or a pane beside the
      // one that opened it, leaves it be.
      highlightMessageId={ownsCover && !covered ? searchParams.get("m") : null}
      autoFocus={!isMobile || focusPromotedComposer}
      offersContext={offersContext}
      className={cn(!inFirstColumn && "sm:border-l", "bg-background", className)}
      chrome={{
        // The first column holds the page's own stream, which keeps the page's sidebar toggle and has nothing to go back to.
        leading: inFirstColumn ? (
          <SidebarToggle location="page" />
        ) : (
          <>
            <StreamLoadingIndicator isLoading={isLoading} />
            {isMobile && <PanelBackControls onClose={onClose} closeRef={closeRef} />}
          </>
        ),
        tabs: tabbed ? (
          <PanelTabStrip
            workspaceId={workspaceId}
            className={isMobile ? undefined : "-ml-2"}
            labels={
              <LabelStack workspaceId={workspaceId} resourceType={LabelableResourceTypes.STREAM} resourceId={panelId} />
            }
          />
        ) : undefined,
        focusToggle: <PaneFocusToggle />,
        close: !isMobile && !tabbed && canClosePanel && <SidePanelClose onClose={onClose} ref={closeRef} />,
      }}
    />
  )
}

/** On a phone the tab takes the screen: the sidebar toggle stays reachable, and back replaces the close. */
function PanelBackControls({
  onClose,
  closeRef,
}: {
  onClose: () => void
  closeRef: RefObject<HTMLButtonElement | null>
}) {
  return (
    <>
      <SidebarToggle location="page" />
      <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose} ref={closeRef}>
        <ChevronLeft className="h-4 w-4" />
        <span className="sr-only">Back</span>
      </Button>
    </>
  )
}

interface DraftThreadPanelProps {
  workspaceId: string
  panelId: string
  onClose: () => void
  onPromoted: (realStreamId: string, focusComposer: boolean) => void
  closeRef: RefObject<HTMLButtonElement | null>
  className?: string
}

function DraftThreadPanel({ workspaceId, panelId, onClose, onPromoted, closeRef, className }: DraftThreadPanelProps) {
  const { isMobile } = useSidebar()
  const covered = usePaneCovered()
  const { tabbed, getNavigateUrl } = usePanel()
  const { queueDraftMessage, currentUserId } = useQueueDraftMessage(workspaceId)
  const draftInfo = parseDraftPanel(panelId)
  const idbStreams = useWorkspaceStreams(workspaceId)
  const currentWorkspaceUserId = useWorkspaceUserId(workspaceId)

  // Fetch the parent stream to get the parent message
  const idbParentStream = useMemo(
    () => (draftInfo ? idbStreams.find((candidate) => candidate.id === draftInfo.parentStreamId) : undefined),
    [draftInfo, idbStreams]
  )
  const parentCachedEvents = useStreamEvents(workspaceId, draftInfo?.parentStreamId)
  // Pending events for the draft thread (the panel id is its synthetic streamId)
  const draftThreadPendingEvents = useStreamEvents(workspaceId, panelId)
  const hasDraftThreadPendingEvents = !!draftThreadPendingEvents && draftThreadPendingEvents.length > 0
  const draftThreadTimelineItems = useMemo(
    () =>
      hasDraftThreadPendingEvents
        ? groupTimelineItems(draftThreadPendingEvents!, currentWorkspaceUserId ?? undefined)
        : [],
    [hasDraftThreadPendingEvents, draftThreadPendingEvents, currentWorkspaceUserId]
  )
  const cachedAnchorEvent = useMemo(() => {
    if (!draftInfo || !parentCachedEvents) return null
    return parentCachedEvents.find((event) => matchesDeepLinkTarget(event, draftInfo.anchorId))
  }, [draftInfo, parentCachedEvents])
  const { data: parentBootstrap } = useStreamBootstrap(workspaceId, draftInfo?.parentStreamId ?? "", {
    enabled: !!draftInfo && (!idbParentStream || !cachedAnchorEvent),
  })

  // Fetch the parent stream's ancestors to build the full breadcrumb trail
  const parentStream = idbParentStream ?? parentBootstrap?.stream
  const { ancestors } = useThreadAncestors(
    workspaceId,
    parentStream?.id ?? "",
    parentStream?.parentStreamId ?? null,
    parentStream?.rootStreamId ?? null
  )

  const localAnchorEvent = useMemo(() => {
    if (cachedAnchorEvent) return cachedAnchorEvent
    if (!draftInfo) return null
    return parentBootstrap?.events.find((event) => matchesDeepLinkTarget(event, draftInfo.anchorId)) ?? null
  }, [cachedAnchorEvent, parentBootstrap?.events, draftInfo])
  const { event: anchorEvent } = useThreadAnchorEvent(
    workspaceId,
    draftInfo?.parentStreamId,
    draftInfo?.anchorId,
    localAnchorEvent
  )

  // Auto-convert draft to real thread when created externally (e.g., agent eager
  // thread creation). The healed threadId lands on the anchor's payload for both
  // message and card anchors (chunk-2 healing) — one accessor covers both.
  //
  // This panel's own send writes the same slot: the draft panel id at queue
  // time, the real id on promotion. Neither is external — the queue's
  // `emitDraftPromoted` moves this panel over, and running the external path
  // alongside it relocates the just-sent draft out from under `resolveDraft`
  // and re-opens the panel from a late callback after the user closed it.
  const [ownReplyQueued, setOwnReplyQueued] = useState(false)
  const externalThreadId = useMemo(() => {
    if (!anchorEvent || ownReplyQueued) return null
    const threadId = (anchorEvent.payload as { threadId?: string }).threadId ?? null
    return threadId && !isDraftPanel(threadId) ? threadId : null
  }, [anchorEvent, ownReplyQueued])

  // Draft composer
  const draftKey = draftInfo ? getDraftMessageKey({ type: "thread", anchorId: draftInfo.anchorId }) : ""
  // A draft thread has no stream row of its own yet — its E2E state is the
  // parent's (threads inherit the root's SSK server-side, INV-E1), so the
  // composer encrypts attachments before upload and seals the draft body to the
  // root's key — exactly as it would in the sealed thread.
  const e2eRoot = parentStream?.e2eEnabled ? (parentStream.rootStreamId ?? parentStream.id) : undefined
  const composer = useDraftComposer({
    workspaceId,
    draftKey,
    scopeId: draftInfo?.anchorId ?? "",
    e2eStreamId: e2eRoot,
  })
  useExternalThreadDraftPromotion({
    workspaceId,
    isDraft: true,
    anchorId: draftInfo?.anchorId,
    externalThreadId,
    flushDraft: composer.flushDraft,
    setIsSending: composer.setIsSending,
    onPromoted: (realStreamId: string) => onPromoted(realStreamId, false),
  })

  // Stashed drafts for this thread. `draftKey` is "" until the panel resolves
  // a draft, so we pass `undefined` as the scope in that case — the hook
  // returns an empty list and silently no-ops.
  const stashScope = draftKey || undefined
  // Stash + restore are pointer moves, so they work for plaintext and E2E alike.
  const stash = useStashComposer(composer, workspaceId, stashScope)
  // Decrypt-on-read previews for the pile (sealed rows via the shared cache,
  // plaintext from contentJson); every entry shares this thread's encrypted root.
  const stashPreviewInputs = useMemo(
    () => stash.drafts.map((draft) => ({ draft, rootStreamId: e2eRoot })),
    [stash.drafts, e2eRoot]
  )
  const stashPreviews = useDecryptedDraftPreviews(workspaceId, stashPreviewInputs)
  const stashOrigins = useStashedDraftOrigins(workspaceId, stash.originByDraftId)

  const stashedDrafts = stashScope
    ? {
        workspaceId,
        drafts: stash.drafts,
        previewById: stashPreviews,
        originById: stashOrigins,
        canStashCurrent: composer.canSend,
        onStashCurrent: stash.handleStashDraft,
        onRestore: stash.handleRestoreStashed,
        onDelete: stash.handleDeleteStashed,
        onOpenChange: stash.setPileOpen,
        controlsDisabled: composer.isSending,
      }
    : undefined

  // Reply composer placeholder: surface an E2E draft's decrypt state so the
  // briefly-empty editor doesn't read as "no draft", and a failed decrypt says
  // so plainly instead of leaving a permanent spinner.
  let replyPlaceholder = "Write your reply..."
  if (composer.decryptFailed) replyPlaceholder = "Couldn't decrypt your saved draft"
  else if (composer.isDecrypting) replyPlaceholder = "Decrypting your draft…"

  const [draftExpanded, setDraftExpanded] = useState(false)
  const draftExpandedRef = useRef<HTMLDivElement>(null)
  const draftPortalTargetRef = useRef<HTMLElement | null>(null)

  const setDraftPortalTarget = useCallback((el: HTMLElement | null) => {
    draftPortalTargetRef.current = el
  }, [])

  // Measured height of the draft composer pill; consumed by the scroll area
  // below it (padding-bottom) so messages sit offset above the floating pill.
  const draftScrollRef = useRef<HTMLDivElement | null>(null)
  const handleDraftComposerHeightChange = useCallback((_px: number, opts: { initial: boolean }) => {
    const scroller = draftScrollRef.current
    if (!scroller) return
    const rePin = () => {
      // Only snap if already at the bottom; if the user has scrolled up to
      // read older draft context, composer growth should not yank them back.
      if (opts.initial || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10) {
        scroller.scrollTop = scroller.scrollHeight
      }
    }
    if (opts.initial) {
      rePin()
    } else {
      requestAnimationFrame(rePin)
    }
  }, [])
  const draftComposerRef = useComposerHeightPublish({
    active: !draftExpanded,
    onHeightChange: handleDraftComposerHeightChange,
  })

  // Collapse expanded overlay when viewport crosses to mobile (expand is desktop-only)
  useEffect(() => {
    if (isMobile) setDraftExpanded(false)
  }, [isMobile])

  // Escape to close — only when focus is inside this expanded editor
  useEffect(() => {
    if (!draftExpanded || covered) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key !== "Escape") return

      const expandedElement = draftExpandedRef.current
      if (!expandedElement) return

      const activeElement = document.activeElement as HTMLElement | null
      const focusedEditor = activeElement?.closest<HTMLElement>('[contenteditable="true"]')
      if (focusedEditor && expandedElement.contains(focusedEditor)) return

      e.preventDefault()
      setDraftExpanded(false)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [draftExpanded, covered])

  const handleDraftExpand = useCallback(() => {
    if (!draftPortalTargetRef.current) {
      console.warn("DraftThreadPanel: draft portal target not available — expand disabled")
      return
    }
    setDraftExpanded(true)
  }, [])
  const handleDraftCollapse = useCallback(() => setDraftExpanded(false), [])

  // A draft thread takes its parent's mention context in a thread's shape, so its
  // first reply offers what the promoted thread's composer will.
  const parentMentionContext = useMentionStreamContext(workspaceId, parentStream)
  const draftStreamContext = useMemo<MentionStreamContext | undefined>(() => {
    if (!parentStream || !parentMentionContext) return undefined
    // The draft IS a thread; use the parent's type (or root type) as rootStreamType
    const rootType = parentStream.rootStreamId
      ? ancestors.find((a) => a.id === parentStream.rootStreamId)?.type
      : parentStream.type
    // While ancestors are loading, rootType is undefined — return undefined so
    // filterBroadcastMentions falls back to ALL_BROADCAST_MENTIONS (show all)
    // rather than incorrectly filtering to "thread" (show none).
    if (parentStream.rootStreamId && rootType === undefined) return undefined
    return { ...parentMentionContext, streamType: StreamTypes.THREAD, rootStreamType: rootType }
  }, [parentStream, ancestors, parentMentionContext])

  useEffect(() => {
    return onDraftPromoted((promotion) => {
      if (promotion.draftId === panelId && promotion.workspaceId === workspaceId) {
        onPromoted(promotion.realStreamId, draftPortalTargetRef.current?.contains(document.activeElement) === true)
      }
    })
  }, [panelId, workspaceId, onPromoted])

  // Handle draft thread submission
  const handleSubmit = useCallback(async () => {
    if (!draftInfo || !composer.canSend || !currentUserId) return
    // Fail closed: until the parent resolves we can't tell whether this thread
    // inherits an encrypted root, and queuing a plaintext reply into a stream
    // the server seals would jam the outbox on INV-E1 (400, retried forever).
    // The parent loads from cache almost immediately; the user just retries.
    if (!parentStream) return

    composer.setIsSending(true)
    const pendingAttachments = composer.getPendingAttachmentsSnapshot()

    // Materialize temp attachment IDs → uploaded IDs at the JSONContent level
    const contentJson = materializePendingAttachmentReferences(composer.content, pendingAttachments)

    // Extract attachment info from the materialized content
    const attachments = extractUploadedAttachments(contentJson)
    const attachmentIds = attachments.map((a) => a.id)

    setDraftExpanded(false)
    setOwnReplyQueued(true)

    try {
      // Clear input optimistically inside try so we can restore on failure
      composer.setContent(EMPTY_DOC)
      composer.clearAttachments()

      // Seal the reply under the encrypted root when the parent is E2E — the
      // promoted thread inherits the root's SSK, so a plaintext send would be
      // rejected by the backend's INV-E1 gate. The root is the parent's root
      // (or the parent itself when it is the root).
      const rootStreamId = parentStream.rootStreamId ?? parentStream.id
      const e2e =
        parentStream.e2eEnabled === true
          ? { rootStreamId, hasActors: (parentStream.e2eActors?.length ?? 0) > 0 }
          : undefined

      await queueDraftMessage(
        {
          contentJson,
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        {
          workspaceId,
          streamId: panelId,
          streamCreation: {
            type: StreamTypes.THREAD,
            parentStreamId: draftInfo.parentStreamId,
            parentAnchorId: draftInfo.anchorId,
          },
          draftId: panelId,
          e2e,
        }
      )

      // AFTER the queue write, never before: the anchor's thread slot indicates
      // this draft, and `queueDraftMessage` is what bumps the anchor's
      // replyCount — resolving first leaves a frame with neither, collapsing the
      // slot and replaying its grow-in on the way back. Failure is handled
      // apart from the queue's: the reply IS queued at this point, so the
      // composer must stay cleared and no retry prompt is warranted — the only
      // symptom is a stale draft row.
      try {
        await composer.resolveDraft()
      } catch (err) {
        console.error("Failed to resolve draft after queueing thread reply", err)
      }
    } catch {
      // Restore content so the user can retry
      composer.setContent(contentJson)
      setOwnReplyQueued(false)
    } finally {
      composer.setIsSending(false)
    }
  }, [draftInfo, composer, currentUserId, panelId, workspaceId, queueDraftMessage, parentStream])

  // Build the full ancestor chain for draft breadcrumbs: hook ancestors + parent stream
  const fullChain = useMemo(() => {
    if (!draftInfo || !parentStream) return []

    const parentItem = {
      id: draftInfo.parentStreamId,
      displayName: parentStream.displayName,
      slug: parentStream.slug,
      type: parentStream.type,
      parentStreamId: parentStream.parentStreamId,
    }

    return [...ancestors, parentItem]
  }, [ancestors, draftInfo, parentStream])

  if (!draftInfo) return null

  // With more than one tab open, the tab row stands in for the title and each
  // tab carries its own close.
  let headerContent: React.ReactNode
  if (tabbed) {
    headerContent = <PanelTabStrip workspaceId={workspaceId} className={isMobile ? undefined : "-ml-2"} />
  } else if (parentStream) {
    headerContent = (
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden pr-2">
        {!isMobile && (
          <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <ResponsiveBreadcrumbs ancestors={fullChain} currentLabel="New thread" getNavigationUrl={getNavigateUrl} />
      </div>
    )
  } else {
    headerContent = <SidePanelTitle className="flex-1">Stream</SidePanelTitle>
  }

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <SidePanelHeader className="relative">
        {isMobile && <PanelBackControls onClose={onClose} closeRef={closeRef} />}
        {headerContent}
        <PaneFocusToggle />
        {!isMobile && !tabbed && <SidePanelClose onClose={onClose} ref={closeRef} />}
      </SidePanelHeader>

      <SidePanelContent className="relative flex flex-col" data-editor-zone="panel" ref={setDraftPortalTarget}>
        {/* Expanded overlay — portaled into the SidePanel */}
        {draftExpanded &&
          draftPortalTargetRef.current &&
          createPortal(
            <div ref={draftExpandedRef} className="absolute inset-0 z-30 bg-background">
              <MessageComposer
                content={composer.content}
                onContentChange={composer.handleContentChange}
                pendingAttachments={composer.pendingAttachments}
                onRemoveAttachment={composer.handleRemoveAttachment}
                onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
                fileInputRef={composer.fileInputRef}
                onFileSelect={composer.handleFileSelect}
                onFileUpload={composer.uploadFile}
                imageCount={composer.imageCount}
                onSubmit={handleSubmit}
                canSubmit={composer.canSend}
                isSubmitting={composer.isSending}
                hasFailed={composer.hasFailed}
                submitLabel="Reply"
                submittingLabel="Creating..."
                placeholder={replyPlaceholder}
                workspaceId={workspaceId}
                scopeId={panelId}
                memoAnchorStreamId={draftInfo.parentStreamId}
                expanded
                onCollapse={handleDraftCollapse}
                autoFocus
                streamContext={draftStreamContext}
                onStashDraft={stash.handleStashDraft}
                stashedDrafts={stashedDrafts}
              />
            </div>,
            draftPortalTargetRef.current
          )}
        <div
          ref={draftScrollRef}
          className={draftExpanded ? "hidden flex-1 flex-col overflow-y-auto" : "flex flex-1 flex-col overflow-y-auto"}
          style={{ paddingBottom: "var(--composer-height, 0px)" }}
        >
          {anchorEvent && (
            <ThreadParentEvent
              event={anchorEvent}
              workspaceId={workspaceId}
              streamId={draftInfo.parentStreamId}
              replyCount={
                hasDraftThreadPendingEvents
                  ? draftThreadPendingEvents!.filter((e) => e.eventType === "message_created").length
                  : 0
              }
            />
          )}
          {hasDraftThreadPendingEvents ? (
            <EventList
              timelineItems={draftThreadTimelineItems}
              isLoading={false}
              workspaceId={workspaceId}
              streamId={panelId}
            />
          ) : (
            <Empty className="min-h-[16rem] flex-none border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquare />
                </EmptyMedia>
                <EmptyTitle>Start a new thread</EmptyTitle>
                <EmptyDescription>Write your reply below to create this thread.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <FloatingComposerShell ref={draftComposerRef} hidden={draftExpanded}>
          <ComposerEncryptionNotice workspaceId={workspaceId} encrypted={!!e2eRoot} streamId={e2eRoot} />
          {!draftExpanded && (
            <MessageComposer
              content={composer.content}
              onContentChange={composer.handleContentChange}
              pendingAttachments={composer.pendingAttachments}
              onRemoveAttachment={composer.handleRemoveAttachment}
              onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
              fileInputRef={composer.fileInputRef}
              onFileSelect={composer.handleFileSelect}
              onFileUpload={composer.uploadFile}
              imageCount={composer.imageCount}
              onSubmit={handleSubmit}
              canSubmit={composer.canSend}
              isSubmitting={composer.isSending}
              hasFailed={composer.hasFailed}
              submitLabel="Reply"
              submittingLabel="Creating..."
              placeholder={replyPlaceholder}
              autoFocus={!isMobile}
              workspaceId={workspaceId}
              scopeId={panelId}
              memoAnchorStreamId={draftInfo.parentStreamId}
              onExpandClick={handleDraftExpand}
              streamContext={draftStreamContext}
              onStashDraft={stash.handleStashDraft}
              stashedDrafts={stashedDrafts}
            />
          )}
        </FloatingComposerShell>
      </SidePanelContent>
    </SidePanel>
  )
}
