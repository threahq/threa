import { useEffect, useMemo, useRef, useState } from "react"
import { serializeToMarkdown, parsePromptMarkdown } from "@/components/editor/editor-markdown"
import { EditorActionBar, RichEditor, type RichEditorHandle } from "@/components/editor"
import { EncryptedScratchpadsSection } from "@/components/encryption"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { usePreferences } from "@/contexts"
import { useInputMode } from "@/hooks/use-input-mode"
import { type JSONContent } from "@threa/types"

const MODIFIER_LABEL =
  typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"

export function AISettings() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  // Selection toolbar is a hover/mouse affordance — suppress it only when a
  // finger is the active input, so a mouse on a touchscreen laptop keeps it.
  const disableSelectionToolbar = useInputMode() === "touch"
  const editorRef = useRef<RichEditorHandle>(null)
  const savedPrompt = preferences?.scratchpadCustomPrompt ?? ""
  const normalizedSavedPrompt = savedPrompt.trim()
  const [contentJson, setContentJson] = useState<JSONContent>(() => parsePromptMarkdown(savedPrompt))
  const [formatOpen, setFormatOpen] = useState(false)

  useEffect(() => {
    setContentJson(parsePromptMarkdown(savedPrompt))
    setFormatOpen(false)
  }, [savedPrompt])

  const currentMarkdown = useMemo(() => serializeToMarkdown(contentJson).trim(), [contentJson])
  const isDirty = currentMarkdown !== normalizedSavedPrompt

  const handleSave = async () => {
    if (!isDirty || isLoading) {
      return
    }

    await updatePreference("scratchpadCustomPrompt", currentMarkdown.length > 0 ? currentMarkdown : null)
  }

  const handleReset = () => {
    setContentJson(parsePromptMarkdown(savedPrompt))
    setFormatOpen(false)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Scratchpad Instructions</h3>
          <p className="text-sm text-muted-foreground">
            Add standing guidance that Ariadne should follow in your personal scratchpads. This is injected after the
            base system prompt for scratchpads and scratchpad-root threads only.
          </p>
        </div>

        <div className="input-glow-wrapper">
          <div
            className="rounded-lg border border-input bg-card p-3"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("button,a,input,textarea,[contenteditable],[role='button']")) {
                return
              }
              editorRef.current?.focus()
            }}
          >
            <RichEditor
              ref={editorRef}
              value={contentJson}
              onChange={setContentJson}
              onSubmit={handleSave}
              placeholder="Tell Ariadne how to think and help in your scratchpads..."
              messageSendMode="cmdEnter"
              staticToolbarOpen={formatOpen}
              disableSelectionToolbar={disableSelectionToolbar}
              ariaLabel="Scratchpad custom prompt editor"
              className="min-h-0 [&_.tiptap]:min-h-[180px] [&_.tiptap]:max-h-[320px]"
              enableMentions={false}
              enableChannels={false}
              enableCommands={false}
              enableEmoji={false}
            />

            <div className="mt-2 border-t pt-2" onMouseDown={(event) => event.preventDefault()}>
              <EditorActionBar
                editorHandle={editorRef.current}
                disabled={isLoading}
                formatOpen={formatOpen}
                onFormatOpenChange={setFormatOpen}
                showAttach={false}
                showMention={false}
                showEmoji={false}
                trailingContent={
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleReset}
                      disabled={!isDirty || isLoading}
                    >
                      Reset
                    </Button>
                    <Button type="button" size="sm" onClick={handleSave} disabled={!isDirty || isLoading}>
                      Save
                    </Button>
                  </div>
                }
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Delete everything and save to remove the custom prompt.</span>
          <span>{MODIFIER_LABEL}+Enter to save</span>
        </div>
      </section>

      <Separator />

      <EncryptedScratchpadsSection />
    </div>
  )
}
