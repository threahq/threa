import { useEffect, useRef, type ReactNode } from "react"
import { ChevronUp, Send, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MessageComposer, type ComposerControlHandle } from "@/components/composer"
import { appendAgentBlockNode, type AgentBlockData } from "@/components/timeline/agent-block-context"
import { useDraftComposer } from "@/hooks/use-draft-composer"
import { useAsideDraftActions, type AsideDraftHandoff } from "@/hooks/use-aside-draft-actions"
import { ASIDE_LABEL, ASIDE_PANE_HEAD } from "./aside-chrome"

interface AsideDraftEditorProps {
  workspaceId: string
  /** `aside:{asideId}:{draftId}` — the one draft this editor writes. */
  scope: string
  /** The draft strip, rendered into this pane's head so the drafts stay one row. */
  tabs: ReactNode
  onClose: () => void
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
 * One head, one foot: the strip and this draft's controls share the head, and
 * the composer's own action bar is the foot. Send is that bar's submit — a
 * second Send button beside it would be two doors to one room.
 */
export function AsideDraftEditor({
  workspaceId,
  scope,
  tabs,
  onClose,
  onSendToComposer,
  pendingAgentBlocks,
  onPendingAgentBlocksConsumed,
}: AsideDraftEditorProps) {
  const composer = useDraftComposer({ workspaceId, draftKey: scope, scopeId: scope })
  const controlRef = useRef<ComposerControlHandle | null>(null)
  const { send, leave, remove, busy, canSend } = useAsideDraftActions(composer, {
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
      <div className={ASIDE_PANE_HEAD}>
        <span className={ASIDE_LABEL}>Draft</span>
        {tabs}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-label="Delete draft"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground"
          aria-label="Close draft"
          disabled={busy}
          onClick={() => void leave()}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        {/* The one way content leaves an aside, said in words — the composer's
            own send arrow carries the same action but nothing on screen would
            tell you where it goes. */}
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
          initialMobileChromeOpen
        />
      </div>
    </div>
  )
}
