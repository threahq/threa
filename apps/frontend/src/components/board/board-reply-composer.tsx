import { useMemo, useState } from "react"
import { toast } from "sonner"
import { Reply, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageComposer } from "@/components/composer"
import { useDraftComposer } from "@/hooks"
import { usePreferences } from "@/contexts"
import { useMentionStreamContext } from "@/hooks/use-mentionables"
import { useReplyToBoardPost } from "@/hooks/use-conversations"
import { useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { EMPTY_DOC } from "@/lib/prosemirror-utils"
import { extractUploadedAttachments, materializePendingAttachmentReferences } from "@/components/timeline/message-input"
import type { BoardPost, JSONContent, Message } from "@threa/types"

interface BoardReplyComposerProps {
  workspaceId: string
  post: BoardPost
  /** Host stream type of the post's conversation, selecting the reply routing. */
  hostStreamType: string | undefined
  /** Called with the created reply so the card can show it in place. */
  onReplied: (message: Message) => void
}

/**
 * Inline reply affordance on a board card. Collapsed to a single line so the
 * feed stays scannable; clicking expands the full composer in place (the heavy
 * editor mounts only once a card is activated, so a feed of cards costs one
 * lightweight button each, not one composer each). Routing — channel → thread,
 * everything else → the conversation — lives in {@link useReplyToBoardPost}.
 */
export function BoardReplyComposer(props: BoardReplyComposerProps) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <Reply className="h-3.5 w-3.5 shrink-0" />
        Reply…
      </button>
    )
  }

  return <BoardReplyComposerForm {...props} onClose={() => setOpen(false)} />
}

function BoardReplyComposerForm({
  workspaceId,
  post,
  hostStreamType,
  onReplied,
  onClose,
}: BoardReplyComposerProps & { onClose: () => void }) {
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

  const handleSubmit = async (editorContent?: JSONContent) => {
    if (!composer.canSend) return

    const pendingAttachments = composer.getPendingAttachmentsSnapshot()
    const liveContent = editorContent ?? composer.content
    const normalizedContent = materializePendingAttachmentReferences(liveContent, pendingAttachments)
    const attachmentIds = extractUploadedAttachments(normalizedContent).map((a) => a.id)

    composer.setIsSending(true)
    try {
      const message = await reply.mutateAsync({
        conversation: post.conversation,
        openingMessageId: post.openingMessage?.id ?? null,
        hostStreamType,
        contentJson: normalizedContent,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })
      composer.setContent(EMPTY_DOC)
      await composer.resolveDraft()
      composer.clearAttachments()
      onReplied(message)
      onClose()
    } catch {
      toast.error("Couldn't post your reply. Please try again.")
    } finally {
      composer.setIsSending(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg border bg-background p-2">
      <div className="mb-1 flex items-center justify-end">
        <Button variant="ghost" size="icon" aria-label="Cancel reply" className="h-7 w-7" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <MessageComposer
        content={composer.content}
        onContentChange={composer.handleContentChange}
        pendingAttachments={composer.pendingAttachments}
        onRemoveAttachment={composer.handleRemoveAttachment}
        workspaceId={workspaceId}
        streamId={hostStream?.id}
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
        scopeId={draftKey}
        streamContext={streamContext}
      />
    </div>
  )
}
