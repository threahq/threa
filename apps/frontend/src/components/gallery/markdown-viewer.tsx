import { Loader2 } from "lucide-react"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { useTextContent } from "./use-text-content"

interface MarkdownViewerProps {
  url: string
  filename: string
  rawMode?: boolean
}

// Native `overflow-auto` instead of Radix ScrollArea: ScrollArea's viewport
// intercepts horizontal touch on iOS, which broke pan-to-scroll inside wide
// code blocks (and made horizontal swipes feel like dead taps that fell
// through to the underlying message gesture). The browser's own scrolling
// handles both axes and respects the surrounding gallery carousel via
// `overscroll-behavior: contain`.
export function MarkdownViewer({ url, filename, rawMode = false }: MarkdownViewerProps) {
  const { content, error } = useTextContent(url || null)

  if (!url || (content === null && !error)) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-white/50" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <p className="text-sm text-white/70">Couldn't load {filename}.</p>
      </div>
    )
  }

  return (
    // Mobile: panel goes edge-to-edge between top action bar and bottom filename
    // bar; rounded corners match the desktop card so the transition into the
    // dark dialog chrome isn't a hard horizontal line.
    // Desktop: drop horizontal padding so the panel can grow up to the same
    // 800px column the stream uses for messages; vertical padding still keeps
    // the action bar and filename bar from overlapping the card.
    <div className="absolute inset-0 pb-16 pt-14 sm:py-16">
      <div
        data-gallery-text-viewer="true"
        className="mx-auto h-full w-full max-w-[800px] overflow-auto overscroll-contain rounded-lg bg-card text-foreground sm:border sm:border-border sm:shadow-2xl"
      >
        {rawMode ? (
          <pre className="px-4 py-6 sm:px-8 sm:py-8 font-mono text-xs leading-relaxed whitespace-pre text-foreground">
            {content ?? ""}
          </pre>
        ) : (
          <div className="px-4 py-6 sm:px-8 sm:py-8">
            <MarkdownContent content={content ?? ""} />
          </div>
        )}
      </div>
    </div>
  )
}
