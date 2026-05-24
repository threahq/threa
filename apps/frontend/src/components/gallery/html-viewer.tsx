import { Loader2 } from "lucide-react"
import { useTextContent } from "./use-text-content"

interface HtmlViewerProps {
  url: string
  filename: string
  rawMode?: boolean
}

/**
 * Renders an HTML attachment inside a hard-sandboxed iframe. We always fetch
 * the source ourselves and pass it via `srcDoc` rather than pointing the
 * iframe at the presigned S3 URL — that earlier setup produced a permanent
 * white iframe in real browsers because the strict sandbox + cross-origin S3
 * response combination tripped the browser's render path. With srcDoc the
 * iframe gets a literal HTML string under a null origin, no network hop, no
 * Content-Type guessing.
 *
 * `sandbox=""` means: render HTML + CSS, but no scripts, no same-origin, no
 * top-frame navigation. Safe for arbitrary user-uploaded HTML.
 *
 * In rawMode the same source is shown as a `<pre>` block, sharing the panel
 * surface with the markdown viewer.
 */
export function HtmlViewer({ url, filename, rawMode = false }: HtmlViewerProps) {
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

  if (rawMode) {
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

  return (
    <div className="absolute inset-0 pb-16 pt-14 sm:py-16">
      <iframe
        data-gallery-text-viewer="true"
        srcDoc={content ?? ""}
        title={filename}
        sandbox=""
        referrerPolicy="no-referrer"
        className="mx-auto block h-full w-full max-w-[800px] rounded-lg bg-white sm:border sm:border-border sm:shadow-2xl"
      />
    </div>
  )
}
