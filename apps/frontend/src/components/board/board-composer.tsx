import { useMemo, useState } from "react"
import { toast } from "sonner"
import { PenSquare, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MessageComposer } from "@/components/composer"
import { useDraftComposer } from "@/hooks"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useCreateBoardPost } from "@/hooks/use-conversations"
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

// Authored posts land in a stream the user picks. Threads are derived (not
// authored into directly) and system streams aren't user-postable; E2E streams
// need client-side sealing the board composer doesn't do yet, so they're out.
const POSTABLE_TYPES = new Set<string>([StreamTypes.CHANNEL, StreamTypes.SCRATCHPAD, StreamTypes.DM])

// One durable draft for the board's "New post" composer, independent of any
// stream scope (the target stream is separate UI state, chosen per post).
const BOARD_DRAFT_KEY = "board:new-post"

/**
 * Streams a user can author a board post into: live channels, scratchpads, and
 * DMs. Threads are derived (not authored into), system streams aren't
 * user-postable, archived streams are closed, and E2E streams need client-side
 * sealing the board composer doesn't do yet.
 */
export function isPostableStream(stream: Pick<CachedStream, "type" | "archivedAt" | "e2eEnabled">): boolean {
  return POSTABLE_TYPES.has(stream.type) && !stream.archivedAt && stream.e2eEnabled !== true
}

/**
 * The board's "New post" affordance. Collapsed to a single button until the user
 * opens it, so the feed stays the focus; expanding reveals the stream picker +
 * composer. An authored post appears on the board the instant it's created (the
 * mutation prepends it), so there's no success toast (INV-63).
 */
export function BoardComposer({ workspaceId }: { workspaceId: string }) {
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

  return <BoardComposerForm workspaceId={workspaceId} onClose={() => setOpen(false)} />
}

function BoardComposerForm({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const streams = useWorkspaceStreams(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const createPost = useCreateBoardPost(workspaceId)

  const postableStreams = useMemo(() => streams.filter(isPostableStream), [streams])

  const [streamId, setStreamId] = useState("")
  const selectedStream = useMemo<CachedStream | undefined>(
    () => postableStreams.find((s) => s.id === streamId),
    [postableStreams, streamId]
  )
  const streamContext = useMentionStreamContext(workspaceId, selectedStream)

  const composer = useDraftComposer({ workspaceId, draftKey: BOARD_DRAFT_KEY, scopeId: BOARD_DRAFT_KEY })

  const canPost = composer.canSend && !!streamId && !createPost.isPending

  const handleSubmit = async (editorContent?: JSONContent) => {
    if (!streamId || !composer.canSend) return

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const attachmentIds = extractUploadedAttachments(normalizedContent).map((a) => a.id)

    composer.setIsSending(true)
    try {
      await createPost.mutateAsync({
        streamId,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })
      composer.setContent(EMPTY_DOC)
      await composer.resolveDraft()
      composer.clearAttachments()
      onClose()
    } catch {
      toast.error("Couldn't post to the board. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  return (
    <div className="mb-3 rounded-xl border bg-card p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2">
        <Select value={streamId} onValueChange={setStreamId} disabled={postableStreams.length === 0}>
          <SelectTrigger className="h-8 w-auto min-w-[180px] text-sm">
            <SelectValue placeholder="Post to…" />
          </SelectTrigger>
          <SelectContent>
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
        workspaceId={workspaceId}
        streamId={streamId || undefined}
        fileInputRef={composer.fileInputRef}
        onFileSelect={composer.handleFileSelect}
        onFileUpload={composer.uploadFile}
        imageCount={composer.imageCount}
        onSubmit={handleSubmit}
        canSubmit={canPost}
        isSubmitting={composer.isSending}
        hasFailed={composer.hasFailed}
        placeholder={streamId ? "Write a post…" : "Pick a stream, then write a post…"}
        messageSendMode="cmdEnter"
        autoFocus
        scopeId={BOARD_DRAFT_KEY}
        streamContext={streamContext}
      />

      {postableStreams.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">No streams you can post to yet.</p>
      )}
    </div>
  )
}
