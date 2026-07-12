import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { type JSONContent } from "@threa/types"
import { MessageComposer, StreamTargetPicker } from "@/components/composer"
import { OverlayComposerShell } from "@/components/composer/overlay-composer-shell"
import { useDraftComposer } from "@/hooks"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useCreateBoardPost } from "@/hooks/use-conversations"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import { isPostableStream, targetForValue, NEW_SCRATCHPAD, NEW_QUICK_NOTE } from "@/lib/board-post-target"
import { readTargetMru, pushTargetMru, readDraftTarget, writeDraftTarget } from "@/lib/board-target-store"

// One durable draft for the overlay composer body, shared across every entry
// point (board button, global shortcut) so an in-progress post survives closing
// and reopening the overlay from anywhere.
const OVERLAY_DRAFT_KEY = "board:new-post"

export interface BoardOverlayComposerProps {
  workspaceId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a successful post so the board can surface the new card. */
  onPosted?: () => void
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
 * Target state lives here (retained across close/reopen); the draft + post hooks
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
  const streams = useWorkspaceStreams(workspaceId)

  // Recents are stable while the overlay is open (the MRU only changes on send,
  // which closes it), so recompute per open rather than every render.
  const recents = useMemo(() => readTargetMru(workspaceId), [workspaceId, open])

  // Seed from the persisted in-progress draft target first (so a restored draft
  // body pairs with the place it was headed), then the last-posted stream.
  const [targetValue, setTargetValue] = useState(
    () => defaultTarget ?? (readDraftTarget(workspaceId) || readTargetMru(workspaceId)[0] || "")
  )

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
  // target, re-seed from persistence — after a send the draft target is cleared,
  // so this drops a just-used "New scratchpad" sentinel instead of defaulting the
  // next post to minting another.
  const prevOpenRef = useRef(open)
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current
    prevOpenRef.current = open
    if (justOpened && !defaultTarget) {
      setTargetValue(readDraftTarget(workspaceId) || readTargetMru(workspaceId)[0] || "")
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
      <BoardOverlayComposerBody
        workspaceId={workspaceId}
        targetValue={targetValue}
        selectedStream={selectedStream}
        onOpenChange={onOpenChange}
        onPosted={onPosted}
      />
    </OverlayComposerShell>
  )
}

/**
 * The draft editor + board-post machinery, mounted only while the overlay is open
 * (it is the shell's child, which the dialog unmounts on close). Keeping the
 * mutation/draft hooks here means a closed overlay never subscribes to a draft or
 * constructs the post mutation.
 */
function BoardOverlayComposerBody({
  workspaceId,
  targetValue,
  selectedStream,
  onOpenChange,
  onPosted,
}: {
  workspaceId: string
  targetValue: string
  selectedStream: CachedStream | undefined
  onOpenChange: (open: boolean) => void
  onPosted?: () => void
}) {
  const createPost = useCreateBoardPost(workspaceId)
  const streamContext = useMentionStreamContext(workspaceId, selectedStream)
  const composer = useDraftComposer({ workspaceId, draftKey: OVERLAY_DRAFT_KEY, scopeId: OVERLAY_DRAFT_KEY })

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
      await createPost.mutateAsync({
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
      onOpenChange(false)
      // Reveal the just-posted card rather than letting it wait behind its own
      // "N new" pill — the viewer's own action should surface immediately.
      onPosted?.()
    } catch {
      toast.error("Couldn't post to the board. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  return (
    <MessageComposer
      expanded
      hideExpandedClose
      onCollapse={() => onOpenChange(false)}
      content={composer.content}
      onContentChange={composer.handleContentChange}
      pendingAttachments={composer.pendingAttachments}
      onRemoveAttachment={composer.handleRemoveAttachment}
      onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
      workspaceId={workspaceId}
      streamId={selectedStream?.id}
      fileInputRef={composer.fileInputRef}
      onFileSelect={composer.handleFileSelect}
      onFileUpload={composer.uploadFile}
      imageCount={composer.imageCount}
      onSubmit={handleSubmit}
      canSubmit={canPost}
      isSubmitting={composer.isSending}
      hasFailed={composer.hasFailed}
      placeholder={targetValue ? "Write a post…" : "Pick where to post, then write…"}
      scopeId={OVERLAY_DRAFT_KEY}
      streamContext={streamContext}
    />
  )
}
