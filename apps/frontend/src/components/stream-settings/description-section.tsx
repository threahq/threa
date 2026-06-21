import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { StreamTypes, type JSONContent, type Stream, type StreamType } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RichEditor, EditorActionBar, type RichEditorHandle } from "@/components/editor"
import { parseMarkdown, serializeToMarkdown } from "@/components/editor/editor-markdown"
import { useUpdateStream, useWorkspaceEmoji } from "@/hooks"
import { useInputMode } from "@/hooks/use-input-mode"

function descriptionPlaceholder(streamType: StreamType): string {
  if (streamType === StreamTypes.CHANNEL) return "What is this channel about?"
  if (streamType === StreamTypes.SCRATCHPAD) return "What is this scratchpad for?"
  return "Add a description…"
}

/**
 * Rich-text description editor for a stream's settings. Reuses the message
 * editor (`RichEditor`) so descriptions get the same formatting, paste-markdown,
 * mentions and emoji as messages — minus image upload and slash commands, which
 * don't belong on a description.
 *
 * Seeds from the stored markdown projection (`stream.description`) and saves the
 * editor's ProseMirror JSON (`descriptionJson`). The canonical store is JSON
 * (the backend derives markdown); parsing the markdown back reconstructs an
 * equivalent doc, so this is the same store-markdown / edit-rich split messages
 * use (INV-58).
 */
export function DescriptionSection({ workspaceId, stream }: { workspaceId: string; stream: Stream }) {
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  // Selection toolbar is a hover/mouse affordance; suppress it on touch.
  const disableSelectionToolbar = useInputMode() === "touch"
  const editorRef = useRef<RichEditorHandle>(null)

  const savedMarkdown = (stream.description ?? "").trim()
  const seed = useCallback<() => JSONContent>(
    () => parseMarkdown(stream.description ?? "", undefined, toEmoji, { enableSlashCommands: false }),
    [stream.description, toEmoji]
  )
  const [contentJson, setContentJson] = useState<JSONContent>(seed)
  const [formatOpen, setFormatOpen] = useState(false)

  // Re-seed when the saved description changes underneath us (another device,
  // a socket update). Mirrors AISettings' re-seed-on-saved-change.
  useEffect(() => {
    setContentJson(seed())
    setFormatOpen(false)
  }, [seed])

  const currentMarkdown = useMemo(() => serializeToMarkdown(contentJson).trim(), [contentJson])
  const isDirty = currentMarkdown !== savedMarkdown

  const handleSave = () => {
    if (!isDirty || updateMutation.isPending) return
    updateMutation.mutate(
      { descriptionJson: contentJson },
      { onError: () => toast.error("Failed to update description") }
    )
  }

  const handleReset = () => {
    setContentJson(seed())
    setFormatOpen(false)
  }

  return (
    <div className="space-y-3">
      <Label className="text-sm font-medium">Description</Label>
      <div
        className="rounded-lg border border-input bg-card p-3"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) return
          editorRef.current?.focus()
        }}
      >
        <RichEditor
          ref={editorRef}
          value={contentJson}
          onChange={setContentJson}
          onSubmit={handleSave}
          placeholder={descriptionPlaceholder(stream.type)}
          messageSendMode="cmdEnter"
          staticToolbarOpen={formatOpen}
          disableSelectionToolbar={disableSelectionToolbar}
          ariaLabel="Stream description editor"
          className="min-h-0 [&_.tiptap]:min-h-[100px] [&_.tiptap]:max-h-[320px]"
          enableCommands={false}
          enableMemoEmbed={false}
        />
        <div className="mt-2 border-t pt-2" onMouseDown={(event) => event.preventDefault()}>
          <EditorActionBar
            editorHandle={editorRef.current}
            disabled={updateMutation.isPending}
            formatOpen={formatOpen}
            onFormatOpenChange={setFormatOpen}
            showAttach={false}
            trailingContent={
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={handleReset} disabled={!isDirty}>
                  Reset
                </Button>
                <Button type="button" size="sm" onClick={handleSave} disabled={!isDirty || updateMutation.isPending}>
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            }
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Delete everything and save to clear the description.</p>
    </div>
  )
}
