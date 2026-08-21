import { useEffect, useState } from "react"
import { Check, Copy, WrapText, X } from "lucide-react"
import { formatCodeLanguage, resolveCodeBlockWrap, type CodeBlockWrap } from "@threa/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { ensureHighlight, tryHighlightSync } from "@/lib/markdown/highlighter"

export interface CodeViewerItem {
  code: string
  languageId: string
}

interface CodeViewerProps {
  item: CodeViewerItem
  onClose: () => void
}

// The body is the scroll container for both axes, so the <pre> itself never
// scrolls: in scroll mode it just keeps its lines unbroken and the body pans.
const SCROLL_PRE_CLASSES = "[&>pre]:whitespace-pre [&>pre]:w-max [&>pre]:min-w-full"
const WRAP_PRE_CLASSES = "[&>pre]:whitespace-pre-wrap [&>pre]:[overflow-wrap:anywhere]"

function escapeHtml(code: string): string {
  return code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/**
 * Full-screen reader for one code block: same Dialog sizing as the media
 * gallery (full-bleed on phones), larger type than the inline block, a
 * session-local wrap toggle seeded from the user's preference, copy, close.
 * Mobile back and Escape come from Dialog.
 */
export function CodeViewer({ item, onClose }: CodeViewerProps) {
  const { code, languageId } = item
  const preferences = usePreferencesOptional()?.preferences
  const [wrap, setWrap] = useState<CodeBlockWrap>(() => resolveCodeBlockWrap(preferences ?? {}, languageId))
  const [copied, setCopied] = useState(false)
  const [html, setHtml] = useState<string | null>(() => tryHighlightSync(code, languageId))

  useEffect(() => {
    if (html) return
    let cancelled = false
    ensureHighlight(code, languageId).then((result) => {
      if (cancelled) return
      setHtml(result ?? `<pre><code>${escapeHtml(code)}</code></pre>`)
    })
    return () => {
      cancelled = true
    }
  }, [html, code, languageId])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const label = formatCodeLanguage(languageId)
  const lineCount = code.split("\n").length

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        hideCloseButton
        className="p-0 max-sm:p-0 gap-0 max-sm:gap-0 overflow-hidden max-sm:overflow-hidden sm:flex sm:flex-col sm:max-w-[90vw] sm:h-[90dvh]"
      >
        <DialogTitle className="sr-only">{label} code</DialogTitle>
        <DialogDescription className="sr-only">
          {lineCount} line{lineCount === 1 ? "" : "s"}
        </DialogDescription>

        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {label}
            <span className="ml-2 tabular-nums">
              {lineCount} line{lineCount === 1 ? "" : "s"}
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-10 w-10"
            aria-pressed={wrap === "wrap"}
            onClick={() => setWrap((mode) => (mode === "wrap" ? "scroll" : "wrap"))}
          >
            <WrapText className="h-5 w-5" />
            <span className="sr-only">Wrap lines</span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("h-10 w-10", copied && "text-green-600 dark:text-green-400")}
            onClick={() => {
              void navigator.clipboard.writeText(code).then(() => setCopied(true))
            }}
          >
            {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />}
            <span className="sr-only">{copied ? "Copied" : "Copy code"}</span>
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10" onClick={onClose}>
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </Button>
        </div>

        <div
          data-native-context="true"
          data-wrap={wrap}
          className={cn(
            "min-h-0 flex-1 overflow-auto overscroll-contain select-text [-webkit-touch-callout:default]",
            "[&>pre]:m-0 [&>pre]:p-4 [&>pre]:font-mono [&>pre]:text-sm [&>pre]:leading-relaxed [&>pre]:bg-transparent",
            wrap === "wrap" ? WRAP_PRE_CLASSES : SCROLL_PRE_CLASSES
          )}
          // Safe: Shiki generates this HTML from the code string; the fallback is escaped above.
          dangerouslySetInnerHTML={{ __html: html ?? `<pre><code>${escapeHtml(code)}</code></pre>` }}
        />
      </DialogContent>
    </Dialog>
  )
}
