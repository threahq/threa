import { useSearchParams, useParams } from "react-router-dom"
import { useMemo, useCallback, useEffect, useState, useRef } from "react"
import { createPortal } from "react-dom"
import { MessageSquare, ChevronLeft, MoreHorizontal, CornerDownRight, Paperclip, Settings, Tag } from "lucide-react"
import {
  SidePanel,
  SidePanelHeader,
  SidePanelTitle,
  SidePanelClose,
  SidePanelContent,
} from "@/components/ui/side-panel"
import { Button } from "@/components/ui/button"
import {
  SidebarActionDrawer,
  SidebarActionMenu,
  type SidebarActionItem,
} from "@/components/layout/sidebar/sidebar-actions"
import {
  useStreamBootstrap,
  useDraftComposer,
  getDraftMessageKey,
  useThreadAncestors,
  useQueueDraftMessage,
  useComposerHeightPublish,
  useStashComposer,
  useWorkspaceUserId,
} from "@/hooks"
import { useCoordinatedLoading, usePanel, isDraftPanel, parseDraftPanel, useSidebar } from "@/contexts"
import { useStreamEvents } from "@/stores/stream-store"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { onDraftPromoted } from "@/lib/draft-promotions"
import { dispatchStartBatchSelect } from "@/lib/batch-selection-events"
import { useStreamSettings } from "@/components/stream-settings/use-stream-settings"
import { useExplorerUrlState } from "@/components/attachment-explorer"
import { StreamLoadingIndicator } from "@/components/loading"
import {
  StreamContent,
  EventList,
  groupTimelineItems,
  materializePendingAttachmentReferences,
  extractUploadedAttachments,
} from "@/components/timeline"
import { StreamErrorBoundary } from "@/components/stream-error-boundary"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { FloatingComposerShell, MessageComposer, StashedDraftsPicker } from "@/components/composer"
import { SidebarToggle } from "@/components/layout"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { ThreadParentMessage } from "./thread-parent-message"
import { ThreadHeader } from "./thread-header"
import { ResponsiveBreadcrumbs } from "./responsive-breadcrumbs"
import { LabelableResourceTypes, StreamTypes } from "@threa/types"
import type { MentionStreamContext } from "@/hooks/use-mentionables"
import { streamLabel } from "@/lib/streams"
import { LabelPicker } from "@/components/labels/label-picker"

interface StreamPanelProps {
  workspaceId: string
  onClose: () => void
}

export function StreamPanel({ workspaceId, onClose }: StreamPanelProps) {
  const { isMobile } = useSidebar()
  const { getStreamState } = useCoordinatedLoading()
  const [searchParams] = useSearchParams()
  const highlightMessageId = searchParams.get("m")
  const { panelId, openPanel, getPanelUrl, closePanel } = usePanel()
  const { queueDraftMessage, currentUserId } = useQueueDraftMessage(workspaceId)
  const { openStreamSettings } = useStreamSettings()
  const { open: openExplorer } = useExplorerUrlState()
  const { streamId: mainViewStreamId } = useParams<{ streamId: string }>()

  const isMainViewStream = (streamId: string) => {
    return mainViewStreamId === streamId
  }

  // Check if this is a draft panel
  const isDraft = panelId ? isDraftPanel(panelId) : false
  const draftInfo = isDraft ? parseDraftPanel(panelId!) : null
  const idbStreams = useWorkspaceStreams(workspaceId)
  const idbPanelStream = useMemo(
    () => (!isDraft && panelId ? idbStreams.find((candidate) => candidate.id === panelId) : undefined),
    [idbStreams, isDraft, panelId]
  )

  // For real streams, fetch bootstrap
  const { data: bootstrap, error } = useStreamBootstrap(workspaceId, isDraft ? "" : (panelId ?? ""), {
    enabled: !!panelId && !isDraft && !idbPanelStream,
  })
  const stream = idbPanelStream ?? bootstrap?.stream
  const isThread = stream?.type === StreamTypes.THREAD
  const currentWorkspaceUserId = useWorkspaceUserId(workspaceId)

  // Show loading indicator only for real streams (not drafts) and only when actively loading after initial data
  const showLoadingIndicator = !isDraft && !!panelId && getStreamState(panelId) === "loading"

  // For draft threads, fetch parent stream to get the parent message
  const idbParentStream = useMemo(
    () => (draftInfo ? idbStreams.find((candidate) => candidate.id === draftInfo.parentStreamId) : undefined),
    [draftInfo, idbStreams]
  )
  const parentCachedEvents = useStreamEvents(draftInfo?.parentStreamId)
  // Query pending events for the draft thread panel (uses panelId as synthetic streamId)
  const draftThreadPendingEvents = useStreamEvents(isDraft ? (panelId ?? undefined) : undefined)
  const hasDraftThreadPendingEvents = isDraft && draftThreadPendingEvents && draftThreadPendingEvents.length > 0
  const draftThreadTimelineItems = useMemo(
    () =>
      hasDraftThreadPendingEvents
        ? groupTimelineItems(draftThreadPendingEvents!, currentWorkspaceUserId ?? undefined)
        : [],
    [hasDraftThreadPendingEvents, draftThreadPendingEvents, currentWorkspaceUserId]
  )
  const cachedParentMessage = useMemo(() => {
    if (!draftInfo || !parentCachedEvents) return null
    return parentCachedEvents.find(
      (event) =>
        event.eventType === "message_created" &&
        (event.payload as { messageId?: string })?.messageId === draftInfo.parentMessageId
    )
  }, [draftInfo, parentCachedEvents])
  const { data: parentBootstrap } = useStreamBootstrap(workspaceId, draftInfo?.parentStreamId ?? "", {
    enabled: !!draftInfo && (!idbParentStream || !cachedParentMessage),
  })

  // For draft threads, fetch parent stream's ancestors to build full breadcrumb trail
  const parentStream = idbParentStream ?? parentBootstrap?.stream
  const { ancestors } = useThreadAncestors(
    workspaceId,
    parentStream?.id ?? "",
    parentStream?.parentStreamId ?? null,
    parentStream?.rootStreamId ?? null
  )

  const parentMessage = useMemo(() => {
    if (cachedParentMessage) return cachedParentMessage
    if (!draftInfo || !parentBootstrap?.events) return null
    return parentBootstrap.events.find(
      (e) =>
        e.eventType === "message_created" &&
        (e.payload as { messageId?: string })?.messageId === draftInfo.parentMessageId
    )
  }, [cachedParentMessage, parentBootstrap, draftInfo])

  // Auto-convert draft to real thread when created externally (e.g., agent eager thread creation)
  const externalThreadId = useMemo(() => {
    if (!parentMessage) return null
    return (parentMessage.payload as { threadId?: string }).threadId ?? null
  }, [parentMessage])

  useEffect(() => {
    if (!isDraft || !externalThreadId) return
    openPanel(externalThreadId)
  }, [isDraft, externalThreadId, openPanel])

  // Draft composer
  const draftKey = draftInfo ? getDraftMessageKey({ type: "thread", parentMessageId: draftInfo.parentMessageId }) : ""
  const composer = useDraftComposer({
    workspaceId,
    draftKey,
    scopeId: draftInfo?.parentMessageId ?? "",
  })

  // Stashed drafts for this thread. `draftKey` is "" until the panel resolves
  // a draft, so we pass `undefined` as the scope in that case — the hook
  // returns an empty list and silently no-ops.
  const stashScope = draftKey || undefined
  const stash = useStashComposer(composer, workspaceId, stashScope)

  const stashedDraftsTrigger = stashScope ? (
    <StashedDraftsPicker
      drafts={stash.drafts}
      canStashCurrent={composer.canSend}
      onStashCurrent={stash.handleStashDraft}
      onRestore={stash.handleRestoreStashed}
      onDelete={stash.handleDeleteStashed}
      controlsDisabled={composer.isSending}
    />
  ) : undefined

  const stashedDraftsTriggerFab = stashScope ? (
    <StashedDraftsPicker
      drafts={stash.drafts}
      canStashCurrent={composer.canSend}
      onStashCurrent={stash.handleStashDraft}
      onRestore={stash.handleRestoreStashed}
      onDelete={stash.handleDeleteStashed}
      controlsDisabled={composer.isSending}
      size="fab"
    />
  ) : undefined

  // Draft thread expand state
  const [draftExpanded, setDraftExpanded] = useState(false)
  const [isMenuDrawerOpen, setIsMenuDrawerOpen] = useState(false)
  const [labelPickerOpen, setLabelPickerOpen] = useState(false)
  const draftExpandedRef = useRef<HTMLDivElement>(null)
  const draftPortalTargetRef = useRef<HTMLElement | null>(null)

  const handleSelectMessages = useCallback(() => {
    if (!panelId) return
    dispatchStartBatchSelect(panelId)
  }, [panelId])

  const panelMenuActions: SidebarActionItem[] = []
  panelMenuActions.push({
    id: "stream-settings",
    label: "Settings",
    icon: Settings,
    onSelect: () => {
      if (panelId) openStreamSettings(panelId)
    },
  })
  panelMenuActions.push({
    id: "labels",
    label: "Labels…",
    icon: Tag,
    onSelect: () => setLabelPickerOpen(true),
  })
  panelMenuActions.push({
    id: "move-messages",
    label: "Move messages…",
    icon: CornerDownRight,
    onSelect: handleSelectMessages,
    separatorBefore: true,
  })
  panelMenuActions.push({
    id: "browse-files",
    label: "Browse files…",
    icon: Paperclip,
    onSelect: () => {
      if (panelId) openExplorer({ streamIds: [panelId] })
    },
  })
  const setDraftPortalTarget = useCallback((el: HTMLElement | null) => {
    draftPortalTargetRef.current = el
  }, [])

  // Measured height of the draft composer pill; consumed by the scroll area
  // below it (padding-bottom) so messages sit offset above the floating pill.
  const draftComposerRef = useRef<HTMLDivElement>(null)
  useComposerHeightPublish(draftComposerRef, { active: !draftExpanded })

  // Reset expand state when panel changes
  useEffect(() => {
    setDraftExpanded(false)
  }, [panelId])

  // Collapse expanded overlay when viewport crosses to mobile (expand is desktop-only)
  useEffect(() => {
    if (isMobile) setDraftExpanded(false)
  }, [isMobile])

  // Escape to close — only when focus is inside this expanded editor
  useEffect(() => {
    if (!draftExpanded) return
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
  }, [draftExpanded])

  const handleDraftExpand = useCallback(() => {
    if (!draftPortalTargetRef.current) {
      console.warn("StreamPanel: draft portal target not available — expand disabled")
      return
    }
    setDraftExpanded(true)
  }, [])
  const handleDraftCollapse = useCallback(() => setDraftExpanded(false), [])

  // Stream context for draft thread broadcast mention filtering.
  // A draft thread lives under parentStream — its root type determines eligibility.
  const draftStreamContext = useMemo<MentionStreamContext | undefined>(() => {
    if (!parentStream) return undefined
    // The draft IS a thread; use the parent's type (or root type) as rootStreamType
    const rootType = parentStream.rootStreamId
      ? ancestors.find((a) => a.id === parentStream.rootStreamId)?.type
      : parentStream.type
    // While ancestors are loading, rootType is undefined — return undefined so
    // filterBroadcastMentions falls back to ALL_BROADCAST_MENTIONS (show all)
    // rather than incorrectly filtering to "thread" (show none).
    if (parentStream.rootStreamId && rootType === undefined) return undefined
    return { streamType: StreamTypes.THREAD, rootStreamType: rootType }
  }, [parentStream, ancestors])

  // Listen for draft thread promotion and navigate to the real thread panel
  useEffect(() => {
    if (!isDraft || !panelId) return
    return onDraftPromoted((promotion) => {
      if (promotion.draftId === panelId && promotion.workspaceId === workspaceId) {
        openPanel(promotion.realStreamId)
      }
    })
  }, [isDraft, panelId, workspaceId, openPanel])

  // Handle draft thread submission
  const handleSubmit = useCallback(async () => {
    if (!draftInfo || !composer.canSend || !currentUserId || !panelId) return

    composer.setIsSending(true)
    const pendingAttachments = composer.getPendingAttachmentsSnapshot()

    // Materialize temp attachment IDs → uploaded IDs at the JSONContent level
    const contentJson = materializePendingAttachmentReferences(composer.content, pendingAttachments)

    // Extract attachment info from the materialized content
    const attachments = extractUploadedAttachments(contentJson)
    const attachmentIds = attachments.map((a) => a.id)

    setDraftExpanded(false)

    try {
      // Clear input optimistically inside try so we can restore on failure
      composer.setContent(EMPTY_DOC)
      composer.clearDraft()
      composer.clearAttachments()

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
            parentMessageId: draftInfo.parentMessageId,
          },
          draftId: panelId,
        }
      )
    } catch {
      // Restore content so the user can retry
      composer.setContent(contentJson)
    } finally {
      composer.setIsSending(false)
    }
  }, [draftInfo, composer, currentUserId, panelId, workspaceId, queueDraftMessage])

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

  if (!panelId) return null

  let headerContent: React.ReactNode
  if (isDraft && parentStream) {
    headerContent = (
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-hidden pr-2">
        {!isMobile && (
          <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <ResponsiveBreadcrumbs
          ancestors={fullChain}
          currentLabel="New thread"
          isMainViewStream={isMainViewStream}
          onClosePanel={closePanel}
          getNavigationUrl={getPanelUrl}
        />
      </div>
    )
  } else if (isThread && stream) {
    headerContent = <ThreadHeader workspaceId={workspaceId} stream={stream} inPanel />
  } else {
    headerContent = <SidePanelTitle className="flex-1">{stream ? streamLabel(stream) : "Stream"}</SidePanelTitle>
  }

  return (
    <SidePanel data-editor-zone="panel">
      <SidePanelHeader className="relative">
        <StreamLoadingIndicator isLoading={showLoadingIndicator} />
        {/* Mobile: thread view takes over the full screen, so the sidebar
             toggle needs to be reachable from here too. */}
        {isMobile && <SidebarToggle location="page" />}
        {/* Mobile back button — replaces X close on small screens */}
        {isMobile && (
          <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" onClick={onClose}>
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Back</span>
          </Button>
        )}
        {headerContent}
        {!isDraft &&
          stream &&
          !stream.archivedAt &&
          (isMobile ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                aria-label="Stream actions"
                onClick={() => setIsMenuDrawerOpen(true)}
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
              <SidebarActionDrawer
                open={isMenuDrawerOpen}
                onOpenChange={setIsMenuDrawerOpen}
                actions={panelMenuActions}
                title="Stream actions"
                description="Choose an action for this stream."
                header={
                  <div className="px-4 pt-2 pb-3">
                    <p className="truncate text-base font-semibold text-foreground">{streamLabel(stream)}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {stream.type === StreamTypes.THREAD ? "Thread" : "Stream"} actions
                    </p>
                  </div>
                }
              />
            </>
          ) : (
            <SidebarActionMenu
              actions={panelMenuActions}
              ariaLabel="Stream actions"
              trigger={
                <Button variant="ghost" size="icon" className="h-8 w-8 flex-shrink-0" aria-label="Stream actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              }
            />
          ))}
        {/* Hide X close button on mobile (back button used instead) */}
        {!isMobile && <SidePanelClose onClose={onClose} />}
      </SidePanelHeader>

      <SidePanelContent className="relative flex flex-col" data-editor-zone="panel" ref={setDraftPortalTarget}>
        {isDraft && draftInfo ? (
          // Draft thread UI
          <>
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
                    placeholder="Write your reply..."
                    workspaceId={workspaceId}
                    scopeId={panelId}
                    memoAnchorStreamId={draftInfo.parentStreamId}
                    expanded
                    onCollapse={handleDraftCollapse}
                    autoFocus
                    streamContext={draftStreamContext}
                    onStashDraft={stash.handleStashDraft}
                    stashedDraftsTrigger={stashedDraftsTrigger}
                    stashedDraftsTriggerFab={stashedDraftsTriggerFab}
                  />
                </div>,
                draftPortalTargetRef.current
              )}
            <div
              className={
                draftExpanded ? "hidden flex-1 flex-col overflow-y-auto" : "flex flex-1 flex-col overflow-y-auto"
              }
              style={{ paddingBottom: "var(--composer-height, 0px)" }}
            >
              {parentMessage && (
                <ThreadParentMessage
                  event={parentMessage}
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
                  streamId={panelId!}
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
              {!draftExpanded && (
                <MessageComposer
                  content={composer.content}
                  onContentChange={composer.handleContentChange}
                  pendingAttachments={composer.pendingAttachments}
                  onRemoveAttachment={composer.handleRemoveAttachment}
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
                  placeholder="Write your reply..."
                  autoFocus={!isMobile}
                  workspaceId={workspaceId}
                  scopeId={panelId}
                  memoAnchorStreamId={draftInfo.parentStreamId}
                  onExpandClick={handleDraftExpand}
                  streamContext={draftStreamContext}
                  onStashDraft={stash.handleStashDraft}
                  stashedDraftsTrigger={stashedDraftsTrigger}
                  stashedDraftsTriggerFab={stashedDraftsTriggerFab}
                />
              )}
            </FloatingComposerShell>
          </>
        ) : (
          // Regular stream UI
          <StreamErrorBoundary streamId={panelId} queryError={error}>
            <StreamContent
              workspaceId={workspaceId}
              streamId={panelId}
              highlightMessageId={highlightMessageId}
              stream={stream}
              autoFocus={isThread && !isMobile}
            />
          </StreamErrorBoundary>
        )}
      </SidePanelContent>
      {!isDraft && stream && panelId && (
        <LabelPicker
          workspaceId={workspaceId}
          resourceType={LabelableResourceTypes.STREAM}
          resourceId={panelId}
          open={labelPickerOpen}
          onOpenChange={setLabelPickerOpen}
        />
      )}
    </SidePanel>
  )
}
