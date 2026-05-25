import { Download, ExternalLink, FileText } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"

interface PdfViewerProps {
  url: string
  filename: string
  /** Layout chrome. `gallery` (default) is absolute-positioned with dark-chrome
   *  loading states sized for the gallery dialog. `inline` is block-flow with a
   *  height cap and muted chrome — used by surfaces like the attachment
   *  explorer preview pane. */
  variant?: "gallery" | "inline"
}

/**
 * Renders a PDF attachment by handing the presigned URL to an iframe and
 * letting the browser's built-in PDF viewer take over. The presigned URL is
 * served with `Content-Type: application/pdf` and without a `download`
 * Content-Disposition (see attachments service `getDownloadUrl`), so Chrome,
 * Firefox, and desktop Safari render it inline.
 *
 * No sandbox attribute: the built-in PDF viewer is a trusted browser
 * component, and tightening the sandbox the way HtmlViewer does (`sandbox=""`)
 * also disables the PDF viewer itself in Chromium.
 *
 * Mobile browsers (iOS Safari, Android Chrome) don't reliably render PDFs in
 * an iframe — they fall back to a download prompt or open the file outside
 * the page. On mobile we render an explicit "Open PDF" tile instead so the
 * user gets a working affordance rather than a blank iframe.
 */
export function PdfViewer({ url, filename, variant = "gallery" }: PdfViewerProps) {
  const isInline = variant === "inline"
  const isMobile = useIsMobile()

  if (!url) {
    return isInline ? (
      <div className="flex h-32 w-full items-center justify-center">
        <FileText className="h-6 w-6 text-muted-foreground" />
      </div>
    ) : (
      <div className="absolute inset-0 flex items-center justify-center">
        <FileText className="h-8 w-8 text-white/50" />
      </div>
    )
  }

  if (isMobile) {
    return isInline ? (
      <div className="w-full">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="mx-auto flex w-full max-w-[800px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-card px-6 py-10 text-center transition-colors hover:border-primary"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-card bg-red-500/15 text-red-600 dark:text-red-400">
            <FileText className="h-7 w-7" />
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium text-foreground">{filename}</div>
            <div className="inline-flex items-center gap-1 text-xs text-primary">
              <ExternalLink className="h-3 w-3" />
              Open PDF
            </div>
          </div>
        </a>
      </div>
    ) : (
      <div data-gallery-text-viewer="true" className="absolute inset-0 flex items-center justify-center px-6">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center gap-4 rounded-lg bg-white/10 px-8 py-10 text-center text-white backdrop-blur-sm transition-colors hover:bg-white/15"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-card bg-white/15">
            <FileText className="h-8 w-8" />
          </div>
          <div className="space-y-1">
            <div className="text-sm font-medium">{filename}</div>
            <div className="inline-flex items-center gap-1 text-xs text-white/70">
              <Download className="h-3 w-3" />
              Open PDF
            </div>
          </div>
        </a>
      </div>
    )
  }

  if (isInline) {
    return (
      <div className="w-full">
        <iframe
          src={url}
          title={filename}
          referrerPolicy="no-referrer"
          className="mx-auto block h-[60vh] w-full max-w-[800px] rounded-lg border border-border bg-white"
        />
      </div>
    )
  }

  return (
    <div className="absolute inset-0 pb-16 pt-14 sm:py-16">
      <iframe
        data-gallery-text-viewer="true"
        src={url}
        title={filename}
        referrerPolicy="no-referrer"
        className="mx-auto block h-full w-full max-w-[900px] rounded-lg bg-white sm:border sm:border-border sm:shadow-2xl"
      />
    </div>
  )
}
