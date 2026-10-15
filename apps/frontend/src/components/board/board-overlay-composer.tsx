import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { toast } from "sonner"
import { type JSONContent } from "@threahq/types"
import { MessageComposer, StreamTargetPicker } from "@/components/composer"
import { OverlayComposerShell } from "@/components/composer/overlay-composer-shell"
import { useComposePaneLinks } from "@/components/composer/compose-pane"
import { PaneHeader } from "@/components/panes"
import { SidePanel, SidePanelContent } from "@/components/ui/side-panel"
import { createComposePanelId, usePanel, useRevealReady } from "@/contexts"
import { useDraftComposer } from "@/hooks"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useCreateBoardPost } from "@/hooks/use-conversations"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import { isPostableStream, targetForValue, NEW_SCRATCHPAD, NEW_QUICK_NOTE } from "@/lib/board-post-target"
import { readTargetMru, pushTargetMru, readDraftTarget, writeDraftTarget } from "@/lib/board-target-store"
import { BOARD_NEW_POST_DRAFT_KEY } from "@/lib/board/draft-keys"
import { notifyComposePosted, openCompose } from "@/stores/compose-overlay-store"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { useIsMobile } from "@/hooks/use-mobile"

export interface BoardOverlayComposerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful post so the board can surface the new card. */
  onPosted?: (conversationId?: string) => void
  /** Pre-selected target (a stream id or `new:*` sentinel) to open on. */
  defaultTarget?: string
}

/**
 * The board/global authoring overlay: a target picker + fullscreen document
 * editor in the shared {@link OverlayComposerShell}. Reuses `MessageComposer`
 * in `expanded` mode (INV-35) and the board post path (`useCreateBoardPost`,
 * which declares a new-topic conversation). The timeline fullscreen editor is a
 * sibling host on the same shell — see step 4.
 *
 * Phones write a new post here, and desktops in {@link BoardNewPostPanel}. Target
 * state lives at this level (retained across close/reopen); the draft + post hooks
 * live in the body, which the shell mounts only while open — so an unopened
 * overlay costs nothing and never runs the mutation/draft machinery.
 */
export function BoardOverlayComposer({
  workspaceId,
  open,
  onOpenChange,
  onPosted,
  defaultTarget,
}: BoardOverlayComposerProps) {
  const { targetValue, changeTarget, recents, selectedStream } = useBoardPostTarget(workspaceId, open, defaultTarget)

  return (
    <OverlayComposerShell
      open={open}
      onOpenChange={onOpenChange}
      title="New post"
      header={
        <StreamTargetPicker
          workspaceId={workspaceId}
          value={targetValue}
          onChange={changeTarget}
          includeNewOptions
          recents={recents}
        />
      }
    >
      <BoardPostComposer
        workspaceId={workspaceId}
        targetValue={targetValue}
        selectedStream={selectedStream}
        onClose={() => onOpenChange(false)}
        onPosted={onPosted}
      />
    </OverlayComposerShell>
  )
}

/** Where the new post goes: persisted beside its draft, so a reload restores both. */
function useBoardPostTarget(workspaceId: string, open: boolean, defaultTarget?: string) {
  const streams = useWorkspaceStreams(workspaceId)

  // Recents are stable while the overlay is open (the MRU only changes on send,
  // which closes it), so recompute per open rather than every render.
  const recents = useMemo(() => readTargetMru(workspaceId), [workspaceId, open])

  // Seed from the persisted in-progress draft target only — so a restored draft
  // body pairs with the place it was headed. A successful post clears this (see
  // handleSubmit), so a fresh "New post" always starts with no target selected.
  const [targetValue, setTargetValue] = useState(() => defaultTarget ?? readDraftTarget(workspaceId))

  // Persist the target alongside the draft body so a reload restores both.
  const changeTarget = useCallback(
    (value: string) => {
      setTargetValue(value)
      writeDraftTarget(workspaceId, value)
    },
    [workspaceId]
  )

  // Adopt an explicit defaultTarget each time the overlay is (re)opened with one
  // — e.g. a global "post to #here" entry. Only on the opening edge so it never
  // overrides a choice the user makes while the overlay is open.
  useEffect(() => {
    if (open && defaultTarget) changeTarget(defaultTarget)
  }, [open, defaultTarget, changeTarget])

  // The overlay is a persistent app-level singleton (never remounts), so a stale
  // in-memory target survives close→reopen. On each open without an explicit
  // target, re-seed from persistence only — after a send the draft target is
  // cleared, so this drops a just-used "New scratchpad" sentinel (or wherever the
  // last post went) instead of defaulting the next post to it.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current
    prevOpenRef.current = open
    if (justOpened && !defaultTarget) {
      setTargetValue(readDraftTarget(workspaceId))
    }
  }, [open, defaultTarget, workspaceId])

  const postableStreams = useMemo(() => streams.filter(isPostableStream), [streams])

  // Drop a stream target that's gone stale (archived / left / deleted) once the
  // list has loaded, so the composer can't post somewhere unselectable. Sentinels
  // are always valid.
  useEffect(() => {
    if (!targetValue || targetValue === NEW_SCRATCHPAD || targetValue === NEW_QUICK_NOTE) return
    if (streams.length > 0 && !postableStreams.some((s) => s.id === targetValue)) changeTarget("")
  }, [targetValue, postableStreams, streams.length, changeTarget])

  // Only an existing-stream target has a stream object for mention context.
  const selectedStream = useMemo<CachedStream | undefined>(
    () => postableStreams.find((s) => s.id === targetValue),
    [postableStreams, targetValue]
  )

  return { targetValue, changeTarget, recents, selectedStream }
}

/**
 * The draft editor + board-post machinery, mounted only while the overlay is open
 * (it is the shell's child, which the dialog unmounts on close). Keeping the
 * mutation/draft hooks here means a closed overlay never subscribes to a draft or
 * constructs the post mutation.
 */
function BoardPostComposer({
  workspaceId,
  targetValue,
  selectedStream,
  onClose,
  onPosted,
}: {
  workspaceId: string
  targetValue: string
  selectedStream: CachedStream | undefined
  onClose: () => void
  onPosted?: (conversationId?: string) => void
}) {
  const createPost = useCreateBoardPost(workspaceId)
  const streamContext = useMentionStreamContext(workspaceId, selectedStream)
  const composer = useDraftComposer({
    workspaceId,
    draftKey: BOARD_NEW_POST_DRAFT_KEY,
    scopeId: BOARD_NEW_POST_DRAFT_KEY,
  })

  const canPost = composer.canSend && !!targetValue && !createPost.isPending

  const handleSubmit = async (editorContent?: JSONContent) => {
    const target = targetForValue(targetValue)
    if (!target || !composer.canSend) return

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const uploadedAttachments = extractUploadedAttachments(normalizedContent)
    const attachmentIds = uploadedAttachments.map((a) => a.id)

    composer.setIsSending(true)
    try {
      const postedConversationId = await createPost.mutateAsync({
        target,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        // Full summaries so the optimistic board card renders thumbnails at once.
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      })
      composer.setContent(EMPTY_DOC)
      await composer.resolveDraft()
      composer.clearAttachments()
      // The draft is resolved — clear its persisted target so a later reload
      // doesn't restore a target with no matching draft body.
      writeDraftTarget(workspaceId, "")
      // Only real streams enter Recents / seed the next default — a "New scratchpad"
      // sentinel shouldn't make minting-another the default on the next open.
      if (target.type === "stream") pushTargetMru(workspaceId, targetValue)
      onClose()
      // Reveal + flash the just-posted card rather than letting it wait behind its
      // own "N new" pill — the viewer's own action should surface immediately.
      onPosted?.(postedConversationId)
    } catch {
      toast.error("Couldn't post to the board. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  return (
    <MessageComposer
      expanded
      onCollapse={onClose}
      content={composer.content}
      onContentChange={composer.handleContentChange}
      pendingAttachments={composer.pendingAttachments}
      onRemoveAttachment={composer.handleRemoveAttachment}
      onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
      workspaceId={workspaceId}
      streamId={selectedStream?.id}
      // The overlay's target is decoupled from the route, so `null` keeps it
      // from inheriting the route stream's runtime commands. It offers only the
      // workspace list (pre-existing: those still post as text — the overlay has
      // no dispatch path), and the whole palette stays on for /giphy, /snippet
      // and memo search, which ride the same flag.
      commandStreamId={null}
      fileInputRef={composer.fileInputRef}
      onFileSelect={composer.handleFileSelect}
      onFileUpload={composer.uploadFile}
      imageCount={composer.imageCount}
      onSubmit={handleSubmit}
      canSubmit={canPost}
      isSubmitting={composer.isSending}
      hasFailed={composer.hasFailed}
      placeholder={targetValue ? "Write a post…" : "Pick where to post, then write…"}
      scopeId={BOARD_NEW_POST_DRAFT_KEY}
      streamContext={streamContext}
    />
  )
}

/** The new post in a pane of its own (`compose:board:new-post`), its target picker in the pane's header. */
export function BoardNewPostPanel({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const { closeTab } = usePanel()
  const { targetValue, changeTarget, recents, selectedStream } = useBoardPostTarget(workspaceId, true)
  useRevealReady(true)

  return (
    <SidePanel className={className} data-editor-zone="panel">
      <PaneHeader
        workspaceId={workspaceId}
        name="New post"
        title={<span className="truncate font-medium">New post</span>}
      >
        <StreamTargetPicker
          workspaceId={workspaceId}
          value={targetValue}
          onChange={changeTarget}
          includeNewOptions
          recents={recents}
        />
      </PaneHeader>
      <SidePanelContent className="flex flex-col">
        <BoardPostComposer
          workspaceId={workspaceId}
          targetValue={targetValue}
          selectedStream={selectedStream}
          onClose={() => closeTab(createComposePanelId(BOARD_NEW_POST_DRAFT_KEY))}
          onPosted={notifyComposePosted}
        />
      </SidePanelContent>
    </SidePanel>
  )
}

/** Where "New post" opens: its pane, in focus, on a desktop that lays panes out, and the overlay on a phone. */
export function useNewPost(): { href: string | undefined; open: () => void } {
  const { expandHref } = useComposePaneLinks(BOARD_NEW_POST_DRAFT_KEY, !useIsMobile())
  const navigate = useNavigate()
  const open = useStableCallback(() => (expandHref ? navigate(expandHref) : openCompose()))
  return { href: expandHref, open }
}
