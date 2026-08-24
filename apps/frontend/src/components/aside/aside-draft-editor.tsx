import { useEffect, useRef } from "react"
import { ArrowLeft, Send, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageComposer, type ComposerControlHandle } from "@/components/composer"
import { appendAgentBlockNode, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { useDraftComposer } from "@/hooks/use-draft-composer"
import { useAsideDraftActions, type AsideDraftHandoff } from "@/hooks/use-aside-draft-actions"
import { ASIDE_LABEL } from "./aside-chrome"

interface AsideDraftEditorProps {
  workspaceId: string
  /** `aside:{asideId}:{draftId}` — the one draft this editor writes. */
  scope: string
  /** One line of the draft's own body, so its bar names the thing it acts on. */
  title?: string
  onClose: () => void
  /**
   * The draft has the whole surface to itself (the phone sheet), so its way
   * out is a way back to what it replaced rather than a close.
   */
  takeover?: boolean
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
 * on every device. Nothing to schedule, no stash pile (the aside's drafts live
 * in its own strip), and no stream/runtime commands in the `/` menu — a command
 * written here would dispatch from wherever the text is sent, not here. An
 * aside draft leaves only through the hand-off, the single path content takes
 * out of a private stream.
 *
 * Its bar sits between the drafts tray and this draft's body, naming the draft
 * it belongs to: Send-to-composer and close act on the words below the bar,
 * never on the tray above it. The composer's own send arrow does the same
 * thing, but only the words say where it goes.
 */
export function AsideDraftEditor({
  workspaceId,
  scope,
  title,
  onClose,
  takeover = false,
  onSendToComposer,
  pendingAgentBlocks,
  onPendingAgentBlocksConsumed,
}: AsideDraftEditorProps) {
  const composer = useDraftComposer({ workspaceId, draftKey: scope, scopeId: scope })
  const controlRef = useRef<ComposerControlHandle | null>(null)
  const { send, leave, busy, canSend } = useAsideDraftActions(composer, {
    onSendToComposer,
    onDone: onClose,
  })

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
      {/* This draft's own bar, directly above this draft's body: every control
          on it acts on the words below it, and nothing on it acts on the tray. */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-y border-border/70 bg-muted/30 px-3">
        {takeover && (
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1.5 h-6 w-6 shrink-0 text-muted-foreground"
            aria-label="Back to drafts"
            disabled={busy}
            onClick={() => void leave()}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
        )}
        <span className={ASIDE_LABEL}>Draft</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{title || "Empty"}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1.5 rounded-full bg-primary/10 px-2.5 text-[11px] font-medium text-primary hover:bg-primary/15 hover:text-primary"
          disabled={!canSend || busy}
          onClick={() => void send()}
        >
          <Send className="h-3 w-3" />
          Send to composer
        </Button>
        {!takeover && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0 text-muted-foreground"
            aria-label="Close draft"
            disabled={busy}
            onClick={() => void leave()}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1.5">
        {/* Expanded: the editor fills the pane like a document, with the
            formatting toolbar always visible and the action bar at the foot —
            a writing surface, not a one-line chat box. */}
        <MessageComposer
          expanded
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
        />
      </div>
    </div>
  )
}
