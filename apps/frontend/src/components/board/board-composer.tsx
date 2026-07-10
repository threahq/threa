import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { PenSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MessageComposer } from "@/components/composer"
import { useDraftComposer } from "@/hooks"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useCreateBoardPost, type BoardPostTarget } from "@/hooks/use-conversations"
import {
  useWorkspaceStreams,
  useWorkspaceUsers,
  useWorkspaceDmPeers,
  type CachedStream,
} from "@/stores/workspace-store"
import { resolveStreamName } from "@/lib/streams"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import { StreamTypes, type JSONContent } from "@threa/types"

// Existing streams a board post can target: live channels and DMs. Scratchpads
// are deliberately excluded — you don't post into an existing one, you create a
// new one (the two "New …" options below). Threads are derived (not authored
// into), system streams aren't user-postable, archived streams are closed, and
// E2E streams need client-side sealing the board composer doesn't do yet.
const POSTABLE_TYPES = new Set<string>([StreamTypes.CHANNEL, StreamTypes.DM])

// Sentinel target values for the two "create a new scratchpad" options, kept
// distinct from any stream id (which is what the rest of the Select holds).
const NEW_SCRATCHPAD = "new:scratchpad"
const NEW_QUICK_NOTE = "new:quick-note"

// One durable draft for the board's "New post" composer body.
const BOARD_DRAFT_KEY = "board:new-post"

// The chosen target is persisted alongside the body draft so reopening the
// composer (or reloading the page) restores the whole in-progress post, not just
// the text — a restored body with a silently-cleared target would leave the send
// disabled with no explanation. Cleared once the post is sent.
const boardTargetStorageKey = (workspaceId: string) => `board:new-post:target:${workspaceId}`

function readStoredTarget(workspaceId: string): string {
  try {
    return localStorage.getItem(boardTargetStorageKey(workspaceId)) ?? ""
  } catch {
    return ""
  }
}

function writeStoredTarget(workspaceId: string, value: string): void {
  // Best-effort: localStorage can throw (private mode / quota). The target falls
  // back to in-memory state, so a failure just means it won't survive a reload.
  try {
    if (value) localStorage.setItem(boardTargetStorageKey(workspaceId), value)
    else localStorage.removeItem(boardTargetStorageKey(workspaceId))
  } catch {
    /* ignore */
  }
}

/**
 * Existing streams a board post can target: live channels and DMs. Scratchpads
 * are created via a post (the "New scratchpad" / "New quick note" options), not
 * appended to from the board (user ruling). Threads/system are not user-authored
 * surfaces; archived and E2E streams are excluded.
 */
export function isPostableStream(stream: Pick<CachedStream, "type" | "archivedAt" | "e2eEnabled">): boolean {
  return POSTABLE_TYPES.has(stream.type) && !stream.archivedAt && stream.e2eEnabled !== true
}

/** Map a Select value to the API target. Stream ids fall through to a stream target. */
function targetForValue(value: string): BoardPostTarget | null {
  if (!value) return null
  if (value === NEW_SCRATCHPAD) return { type: "newScratchpad", companionMode: "on" }
  if (value === NEW_QUICK_NOTE) return { type: "newScratchpad", companionMode: "off" }
  return { type: "stream", streamId: value }
}

/**
 * The board's "New post" affordance. Collapsed to a single button until the user
 * opens it, so the feed stays the focus; expanding reveals the target picker +
 * composer. The composer closes on a successful post and the feed refreshes to
 * show it, so the result is visible without a success toast (INV-63).
 */
export function BoardComposer({ workspaceId, onPosted }: { workspaceId: string; onPosted?: () => void }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 flex w-full items-center gap-2 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground hover:bg-accent/40"
      >
        <PenSquare className="h-4 w-4 shrink-0" />
        Write a post…
      </button>
    )
  }

  return <BoardComposerForm workspaceId={workspaceId} onClose={() => setOpen(false)} onPosted={onPosted} />
}

function BoardComposerForm({
  workspaceId,
  onClose,
  onPosted,
}: {
  workspaceId: string
  onClose: () => void
  onPosted?: () => void
}) {
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const createPost = useCreateBoardPost(workspaceId)

  const postableStreams = useMemo(() => streams.filter(isPostableStream), [streams])

  // The selected Select value: a sentinel ("new:…") or a stream id. Seeded from
  // (and written back to) localStorage so it stays in sync with the durable body
  // draft across reopen/reload.
  const [targetValue, setTargetValue] = useState(() => readStoredTarget(workspaceId))
  const handleTargetChange = useCallback(
    (value: string) => {
      setTargetValue(value)
      writeStoredTarget(workspaceId, value)
    },
    [workspaceId]
  )

  // A persisted stream-id target can go stale (archived, left, deleted). Once the
  // postable list has loaded, drop a target that's no longer selectable so the
  // composer can't post to a stream the user can't see. Sentinels are always valid.
  useEffect(() => {
    if (!targetValue || targetValue === NEW_SCRATCHPAD || targetValue === NEW_QUICK_NOTE) return
    if (streams.length > 0 && !postableStreams.some((s) => s.id === targetValue)) {
      setTargetValue("")
      writeStoredTarget(workspaceId, "")
    }
  }, [targetValue, postableStreams, streams.length, workspaceId])

  // Only an existing-stream target has a stream object for mention context; a
  // "new scratchpad" target has no stream yet.
  const selectedStream = useMemo<CachedStream | undefined>(
    () => postableStreams.find((s) => s.id === targetValue),
    [postableStreams, targetValue]
  )
  const streamContext = useMentionStreamContext(workspaceId, selectedStream)

  const composer = useDraftComposer({ workspaceId, draftKey: BOARD_DRAFT_KEY, scopeId: BOARD_DRAFT_KEY })

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
      writeStoredTarget(workspaceId, "")
      onClose()
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
    <div className="mb-3 rounded-xl border bg-card p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2">
        <Select value={targetValue} onValueChange={handleTargetChange}>
          <SelectTrigger className="h-8 min-w-0 flex-1 text-sm">
            <SelectValue placeholder="Post to…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_SCRATCHPAD}>New scratchpad</SelectItem>
            <SelectItem value={NEW_QUICK_NOTE}>New quick note</SelectItem>
            {postableStreams.length > 0 && <SelectSeparator />}
            {postableStreams.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {resolveStreamName(s.id, { streams, users, dmPeers }, "generic") ?? "Untitled stream"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" aria-label="Cancel post" className="ml-auto h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <MessageComposer
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
        messageSendMode="cmdEnter"
        autoFocus
        scopeId={BOARD_DRAFT_KEY}
        streamContext={streamContext}
      />
    </div>
  )
}
