import { Loader2 } from "lucide-react"
import { useTextContent } from "./use-text-content"

interface TextViewerProps {
  url: string
  filename: string
}

/**
 * Plain-text preview for the gallery — text/code/data files rendered verbatim in
 * a monospace `<pre>`, no syntax highlighting and no wrapping (long lines scroll
 * horizontally) so code keeps its column layout. Matches the snippet editor's
 * deliberately plain posture. `data-gallery-text-viewer` opts the panel out of
 * the carousel's touch gestures so native scroll handles both axes.
 */
export function TextViewer({ url, filename }: TextViewerProps) {
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
    <div className="absolute inset-0 pb-16 pt-14 sm:py-16">
      <div
        data-gallery-text-viewer="true"
        className="mx-auto h-full w-full max-w-[800px] overflow-auto overscroll-contain rounded-lg bg-card text-foreground sm:border sm:border-border sm:shadow-2xl"
      >
        <pre className="px-4 py-6 sm:px-8 sm:py-8 font-mono text-xs leading-relaxed whitespace-pre text-foreground">
          {content ?? ""}
        </pre>
      </div>
    </div>
  )
}
