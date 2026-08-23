import { useEffect, useRef } from "react"
import { ArrowLeft, Send, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageComposer, type ComposerControlHandle } from "@/components/composer"
import { appendAgentBlockNode, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { useDraftComposer } from "@/hooks/use-draft-composer"
import { useAsideDraftActions, type AsideDraftHandoff } from "@/hooks/use-aside-draft-actions"

interface AsideDraftEditorProps {
  workspaceId: string
  /** `aside:{asideId}:{draftId}` — the one draft this editor writes. */
  scope: string
  onBack: () => void
  /** Hand the body and files to the host composer: null when refused, else the destination's verdict. */
  onSendToComposer: (handoff: AsideDraftHandoff) => Promise<{ delivered: Promise<boolean> } | null>
  /** Agent replies queued by "Insert into draft"; appended as attributed blocks once the draft has loaded. */
  pendingAgentBlocks?: AgentBlockData[]
  onPendingAgentBlocksConsumed?: () => void
}

/**
 * One aside draft, open for writing: the same composer card the stream
 * composer is — formatting, emoji, mentions, files, dictation — with "Send to
 * composer" as its only way out, in the composer's expanded (document) shape
 * on every device: full-height editor, formatting toolbar, action bar at the
 * foot. Nothing to schedule, no stash pile (the aside's drafts live in its own
 * dock), and no stream/runtime commands in the `/` menu — a command written
 * here would dispatch from wherever the text is sent, not here. An aside draft
 * leaves only through the hand-off, the single path content takes out of a
 * private stream.
 */
export function AsideDraftEditor({
  workspaceId,
  scope,
  onBack,
  onSendToComposer,
  pendingAgentBlocks,
  onPendingAgentBlocksConsumed,
}: AsideDraftEditorProps) {
  const composer = useDraftComposer({ workspaceId, draftKey: scope, scopeId: scope })
  const controlRef = useRef<ComposerControlHandle | null>(null)
  const { send, remove, busy, canSend } = useAsideDraftActions(composer, { onSendToComposer, onDone: onBack })

  const { isLoaded, content, handleContentChange } = composer
  useEffect(() => {
    if (!isLoaded || !pendingAgentBlocks || pendingAgentBlocks.length === 0) return
    let next = content
    for (const block of pendingAgentBlocks) next = appendAgentBlockNode(next, block)
    handleContentChange(next)
    onPendingAgentBlocksConsumed?.()
    controlRef.current?.focusAfterQuoteReply()
  }, [isLoaded, content, handleContentChange, pendingAgentBlocks, onPendingAgentBlocksConsumed])

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="aside-draft-editor" data-draft-scope={scope}>
      <header className="flex h-11 shrink-0 items-center gap-1 border-b pl-2 pr-2">
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Back to drafts" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label="Delete draft"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          disabled={!canSend || busy}
          onClick={() => void send()}
        >
          <Send className="h-4 w-4" />
          Send to composer
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-3 py-2">
        {/* Expanded: the editor fills the pane like a document, with the
            formatting toolbar always visible and the action bar at the foot —
            a writing surface, not a one-line chat box. */}
        <MessageComposer
          expanded
          hideExpandedClose
          composerRef={controlRef}
          content={composer.content}
          onContentChange={composer.handleContentChange}
          pendingAttachments={composer.pendingAttachments}
          onRemoveAttachment={composer.handleRemoveAttachment}
          onCancelAttachmentUpload={composer.handleCancelAttachmentUpload}
          workspaceId={workspaceId}
          commandStreamId={null}
          includeStreamCommands={false}
          fileInputRef={composer.fileInputRef}
          onFileSelect={composer.handleFileSelect}
          onFileUpload={composer.uploadFile}
          imageCount={composer.imageCount}
          onSubmit={() => void send()}
          canSubmit={canSend && !busy}
          isSubmitting={busy}
          submitLabel="Send to composer"
          submittingLabel="Sending to composer…"
          placeholder="Write here, then send it to the composer…"
          messageSendMode="cmdEnter"
          scopeId={scope}
          autoFocus
          initialMobileChromeOpen
        />
      </div>
    </div>
  )
}
