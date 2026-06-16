import { useEffect, useRef, useState } from "react"
import { FileCode2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { SNIPPET_FALLBACK_FILENAME } from "./snippet-paste"

interface SnippetEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pasted text the editor is seeded with each time it opens. */
  initialText: string
  /** Suggested filename (e.g. `snippet-1.txt`); the user can rename it. */
  defaultFilename: string
  /** Save the (possibly edited) snippet as a `.txt` attachment. */
  onSave: (args: { text: string; filename: string }) => void
}

/**
 * A deliberately plain editor for text that's too large to sit inline in a
 * message. It's a native `<textarea>` — not ProseMirror — so the browser
 * handles arbitrarily large content and scrolling natively (the "infinite
 * scroller" requirement); a rich editor would choke on a multi-megabyte blob.
 * Monospace, no syntax highlighting, no wrapping — just enough to glance over
 * and tweak before it becomes a snippet attachment.
 *
 * `disableSnapPoints`: this is a keyboard form, so on mobile it rides above the
 * keyboard as a content-height drawer rather than the h-[100dvh] snap drawer
 * (see ResponsiveDialog docs / SavedEditDialog).
 */
export function SnippetEditorDialog({
  open,
  onOpenChange,
  initialText,
  defaultFilename,
  onSave,
}: SnippetEditorDialogProps) {
  const [text, setText] = useState(initialText)
  const [filename, setFilename] = useState(defaultFilename)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wasOpenRef = useRef(false)

  // Re-seed from the incoming paste only on the closed→open transition, then
  // focus the body so the user lands on their pasted content (Radix would
  // otherwise focus the filename input, the first tabbable element). Keying on
  // the transition rather than the prop values means a re-render while the
  // dialog is open can't clobber in-progress edits.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setText(initialText)
      setFilename(defaultFilename)
      // Defer past Radix's open-focus so the move to the textarea wins.
      const raf = requestAnimationFrame(() => textareaRef.current?.focus())
      wasOpenRef.current = true
      return () => cancelAnimationFrame(raf)
    }
    if (!open) wasOpenRef.current = false
  }, [open, initialText, defaultFilename])

  const trimmedFilename = filename.trim()
  const canSave = text.length > 0 && trimmedFilename.length > 0

  const handleSave = () => {
    if (!canSave) return
    onSave({ text, filename: trimmedFilename })
  }

  // Cmd/Ctrl+Enter saves — plain Enter has to stay free for newlines in a
  // code-style editor.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      handleSave()
    }
  }

  const charCount = text.length
  const lineCount = text ? (text.match(/\n/g)?.length ?? 0) + 1 : 0

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="max-w-[760px] gap-0 p-0 overflow-hidden"
        drawerClassName="flex max-h-[92dvh] flex-col gap-0 p-0 overflow-hidden"
      >
        <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
          <ResponsiveDialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10">
                <FileCode2 className="h-4.5 w-4.5 text-primary" />
              </div>
              <div>
                <ResponsiveDialogTitle className="text-base">Add as snippet</ResponsiveDialogTitle>
                <ResponsiveDialogDescription className="text-xs mt-0.5">
                  This is too long to paste inline — it'll be attached as a file you can edit first.
                </ResponsiveDialogDescription>
              </div>
            </div>
          </ResponsiveDialogHeader>
        </div>

        <div className="border-t border-border" />

        {/* overflow-y-auto so a shrunken visual viewport (mobile keyboard) can
            scroll the fields into reach instead of clipping them off-screen,
            per the ResponsiveDialog disableSnapPoints contract. */}
        <div className="flex-1 min-h-0 flex flex-col gap-3 px-4 sm:px-6 py-4 overflow-y-auto">
          <Input
            aria-label="Snippet filename"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            placeholder={SNIPPET_FALLBACK_FILENAME}
            className="text-sm font-mono"
          />
          {/* wrap="off": long lines scroll horizontally so code keeps its
              column layout rather than reflowing. */}
          <Textarea
            ref={textareaRef}
            aria-label="Snippet contents"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="flex-1 min-h-[280px] sm:min-h-[360px] resize-none font-mono text-xs leading-relaxed whitespace-pre overflow-auto"
          />
        </div>

        <div className="border-t border-border px-4 sm:px-6 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] flex items-center justify-between gap-3 bg-muted/30">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {charCount.toLocaleString()} chars · {lineCount.toLocaleString()} lines
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave} className="min-w-20">
              Attach snippet
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
