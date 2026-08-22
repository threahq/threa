import { useCallback, useRef } from "react"
import { ArrowLeft, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { JSONContent } from "@threa/types"
import { Button } from "@/components/ui/button"
import { RichEditor, type RichEditorHandle } from "@/components/editor"
import { useDraftComposer } from "@/hooks/use-draft-composer"
import { isEmptyContent } from "@/lib/prosemirror-utils"

interface AsideDraftEditorProps {
  workspaceId: string
  /** `aside:{asideId}:{draftId}` — the one draft this editor writes. */
  scope: string
  onBack: () => void
  /** Hand the body to the host composer. Resolves false when it couldn't be delivered. */
  onSendToComposer: (content: JSONContent[]) => Promise<boolean>
}

/**
 * One aside draft, open for writing. Deliberately not a composer host: no send
 * pipeline, no attachments, no commands — an aside draft is written here and
 * leaves only through the hand-off, which is the single path content takes out
 * of a private stream.
 */
export function AsideDraftEditor({ workspaceId, scope, onBack, onSendToComposer }: AsideDraftEditorProps) {
  const composer = useDraftComposer({ workspaceId, draftKey: scope, scopeId: scope })
  const editorRef = useRef<RichEditorHandle>(null)

  const handleSend = useCallback(async () => {
    const content = composer.content
    if (isEmptyContent(content)) return
    // Persist before handing off: the hand-off is a copy into another composer,
    // so the draft must survive it even if the destination refuses.
    await composer.flushDraft()
    if (!(await onSendToComposer(content.content ?? []))) {
      toast.error("Couldn't hand this draft to the composer.")
      return
    }
    onBack()
  }, [composer, onSendToComposer, onBack])

  const handleDelete = useCallback(async () => {
    await composer.clearDraft()
    onBack()
  }, [composer, onBack])

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
          onClick={() => void handleDelete()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          disabled={isEmptyContent(composer.content)}
          onClick={() => void handleSend()}
        >
          <Send className="h-4 w-4" />
          Send to composer
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <RichEditor
          ref={editorRef}
          value={composer.content}
          onChange={composer.handleContentChange}
          onSubmit={() => void handleSend()}
          messageSendMode="cmdEnter"
          placeholder="Write here, then send it to the composer…"
          ariaLabel="Aside draft"
          autoFocus
          scopeId={scope}
        />
      </div>
    </div>
  )
}
