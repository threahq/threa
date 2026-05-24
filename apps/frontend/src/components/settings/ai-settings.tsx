import { useEffect, useMemo, useRef, useState } from "react"
import { serializeToMarkdown, parseMarkdown } from "@/components/editor/editor-markdown"
import { EditorActionBar, RichEditor, type RichEditorHandle } from "@/components/editor"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { usePreferences } from "@/contexts"
import { useIsMobile } from "@/hooks/use-mobile"
import { VOICE_TRANSCRIPTION_MODELS, type JSONContent } from "@threa/types"

const VOICE_DEFAULT_OPTION_ID = "default"

const MODIFIER_LABEL =
  typeof navigator !== "undefined" && navigator.platform?.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"

function parsePrompt(markdown: string): JSONContent {
  return parseMarkdown(markdown, undefined, undefined, {
    enableMentions: false,
    enableChannels: false,
    enableSlashCommands: false,
    enableEmoji: false,
  })
}

export function AISettings() {
  const { preferences, updatePreference, isLoading } = usePreferences()
  const isMobile = useIsMobile()
  const editorRef = useRef<RichEditorHandle>(null)
  const savedPrompt = preferences?.scratchpadCustomPrompt ?? ""
  const normalizedSavedPrompt = savedPrompt.trim()
  const [contentJson, setContentJson] = useState<JSONContent>(() => parsePrompt(savedPrompt))
  const [formatOpen, setFormatOpen] = useState(false)

  useEffect(() => {
    setContentJson(parsePrompt(savedPrompt))
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
    setContentJson(parsePrompt(savedPrompt))
    setFormatOpen(false)
  }

  const savedVoiceModel = preferences?.voiceTranscriptionModel ?? null
  const voiceSelection = savedVoiceModel ?? VOICE_DEFAULT_OPTION_ID
  const handleVoiceModelChange = (value: string) => {
    const next = value === VOICE_DEFAULT_OPTION_ID ? null : value
    if (next === savedVoiceModel) {
      return
    }
    void updatePreference("voiceTranscriptionModel", next)
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
              disableSelectionToolbar={isMobile}
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

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Voice Dictation Model</h3>
          <p className="text-sm text-muted-foreground">
            Choose which speech-to-text provider Threa uses when you dictate a message.
          </p>
        </div>
        <RadioGroup
          value={voiceSelection}
          onValueChange={handleVoiceModelChange}
          aria-label="Voice dictation model"
          className="space-y-3"
        >
          <div className="flex items-start space-x-3">
            <RadioGroupItem value={VOICE_DEFAULT_OPTION_ID} id="voice-model-default" className="mt-1" />
            <div className="grid gap-1">
              <Label htmlFor="voice-model-default" className="cursor-pointer">
                Use server default
              </Label>
              <p className="text-sm text-muted-foreground">
                Use whatever provider Threa has configured as the default.
              </p>
            </div>
          </div>
          {VOICE_TRANSCRIPTION_MODELS.map((option) => (
            <div key={option.id} className="flex items-start space-x-3">
              <RadioGroupItem value={option.id} id={`voice-model-${option.id}`} className="mt-1" />
              <div className="grid gap-1">
                <Label htmlFor={`voice-model-${option.id}`} className="cursor-pointer">
                  {option.name}
                </Label>
                <p className="text-sm text-muted-foreground">{option.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
      </section>
    </div>
  )
}
