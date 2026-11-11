import { useEffect, useMemo, useRef, useState } from "react"
import { StreamTypes, type JSONContent, type Stream, type StreamType } from "@threahq/types"
import { useCommittedText } from "@/components/settings/committed-field"
import { settingIds, SaveError, SaveIndicator } from "@/components/settings/setting-primitives"
import { SETTING_INPUT_FRAME } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import { RichEditor, type RichEditorHandle } from "@/components/editor"
import { parseMarkdown, serializeToMarkdown } from "@/components/editor/editor-markdown"
import { useUpdateStream, useWorkspaceEmoji } from "@/hooks"
import { useInputMode } from "@/hooks/use-input-mode"

function descriptionPlaceholder(streamType: StreamType): string {
  if (streamType === StreamTypes.CHANNEL) return "What is this channel about?"
  if (streamType === StreamTypes.SCRATCHPAD) return "What is this scratchpad for?"
  return "Add a description…"
}

const DESCRIPTION_ERROR_ID = settingIds("stream-description").error

/**
 * Rich-text description editor for a stream's settings. Reuses the message
 * editor (`RichEditor`) so descriptions get the same formatting, paste-markdown,
 * mentions and emoji as messages — minus image upload and slash commands, which
 * don't belong on a description. It reads as a form field: no composer toolbar,
 * so formatting comes from markdown typing, shortcuts and the selection toolbar.
 *
 * Seeds from the canonical ProseMirror (`stream.descriptionJson`) and saves the
 * editor's JSON back (INV-58) — the same edit-from-JSON path message editing
 * uses. Markdown (`stream.description`) is only the wire/integrator projection;
 * it's the seed fallback only for rows cached before `descriptionJson` existed.
 *
 * Saves like every other typed setting (`useCommittedText`): on blur or
 * ⌘/Ctrl+Enter, Escape reverts, and the outcome shows in place.
 */
export function DescriptionSection({
  workspaceId,
  stream,
  locked = false,
}: {
  workspaceId: string
  stream: Stream
  locked?: boolean
}) {
  const updateMutation = useUpdateStream(workspaceId, stream.id)
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  // Selection toolbar is a hover/mouse affordance; suppress it on touch.
  const disableSelectionToolbar = useInputMode() === "touch"
  const editorRef = useRef<RichEditorHandle>(null)

  // Serialized on this side too, so a server-side markdown difference never reads as an edit.
  const savedMarkdown = useMemo(
    () => (stream.descriptionJson ? serializeToMarkdown(stream.descriptionJson) : (stream.description ?? "")).trim(),
    [stream.descriptionJson, stream.description]
  )
  // Seed from the canonical ProseMirror; markdown is only the legacy fallback.
  const seedContent = (): JSONContent =>
    stream.descriptionJson ??
    parseMarkdown(stream.description ?? "", undefined, toEmoji, { enableSlashCommands: false })
  const [contentJson, setContentJson] = useState<JSONContent>(seedContent)
  const latestJson = useRef(contentJson)
  const editorMarkdown = useRef(savedMarkdown)

  const field = useCommittedText<HTMLDivElement>({
    saved: savedMarkdown,
    commit: () => updateMutation.mutateAsync({ descriptionJson: latestJson.current }),
    failureMessage: "Couldn't save the description",
  })

  // The editor follows the saved description when there's no draft to keep:
  // after Escape, or a change from another device. Keyed on the markdown, not
  // the descriptionJson object, whose identity churns on unrelated cache writes.
  // While a save shows its outcome the saved value may still be catching up.
  useEffect(() => {
    if (field.dirty || field.state.kind !== "idle" || editorMarkdown.current === savedMarkdown) return
    const seed = seedContent()
    editorMarkdown.current = savedMarkdown
    latestJson.current = seed
    setContentJson(seed)
    // `seedContent` reads the same stream render as `savedMarkdown`.
  }, [field.dirty, field.state.kind, savedMarkdown])

  const onEditorChange = (next: JSONContent) => {
    latestJson.current = next
    editorMarkdown.current = serializeToMarkdown(next).trim()
    setContentJson(next)
    field.onChange(editorMarkdown.current)
  }

  return (
    <div className="space-y-1.5">
      <div
        ref={field.fieldRef}
        className={cn("relative", SETTING_INPUT_FRAME)}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          editorRef.current?.getEditor()?.commands.commitEmoticon()
          void field.save()
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) return
          editorRef.current?.focus()
        }}
      >
        {/* TipTap ignores a changed `editable` after creation, so a lock change remounts the editor. */}
        <RichEditor
          key={String(locked)}
          ref={editorRef}
          value={contentJson}
          onChange={onEditorChange}
          onSubmit={() => void field.save()}
          placeholder={descriptionPlaceholder(stream.type)}
          messageSendMode="cmdEnter"
          disableSelectionToolbar={disableSelectionToolbar}
          ariaLabel="Stream description editor"
          ariaErrorMessage={field.state.kind === "error" ? DESCRIPTION_ERROR_ID : undefined}
          disabled={locked}
          className="min-h-0 pr-6 [&_.tiptap]:min-h-[100px] [&_.tiptap]:max-h-[320px]"
          enableCommands={false}
          enableMemoEmbed={false}
        />
        <span className="pointer-events-none absolute right-3 top-3">
          <SaveIndicator state={field.state} />
        </span>
      </div>
      <SaveError state={field.state} id={DESCRIPTION_ERROR_ID} />
    </div>
  )
}
