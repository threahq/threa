import { lazy, Suspense } from "react"
import { FileText, Loader2 } from "lucide-react"
import { useIsMobile } from "@/hooks/use-mobile"

// Code-split: PDF.js is ~300KB gz. Only ships when a PDF preview is opened on
// a viewport where we render pages ourselves (mobile). Desktop hands the URL
// to the browser's native viewer via the iframe path below.
const PdfPagesRenderer = lazy(() => import("./pdf-pages-renderer"))

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
 * Renders a PDF attachment. On desktop we hand the presigned URL to an iframe
 * and let the browser's built-in PDF viewer take over — its toolbar, search,
 * print, and zoom are better than anything we'd ship. The presigned URL is
 * served with `Content-Type: application/pdf` and without a `download`
 * Content-Disposition (see attachments service `getDownloadUrl`), so Chrome,
 * Firefox, and desktop Safari render it inline.
 *
 * No sandbox attribute on the iframe: the built-in PDF viewer is a trusted
 * browser component, and tightening the sandbox the way HtmlViewer does
 * (`sandbox=""`) also disables the PDF viewer itself in Chromium.
 *
 * Mobile browsers (iOS Safari, Android WebView, older Android Chrome) don't
 * reliably render PDFs in an iframe — they fall back to a download prompt or
 * open the file outside the page. On mobile we render PDF.js pages into
 * canvases instead so the user gets an actual inline preview rather than just
 * a download tile.
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
    const fallback = isInline ? (
      <div className="flex h-32 w-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading PDF…
      </div>
    ) : (
      <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-white/70">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading PDF…
      </div>
    )
    const renderer = (
      <Suspense fallback={fallback}>
        <PdfPagesRenderer url={url} filename={filename} variant={variant} />
      </Suspense>
    )
    return isInline ? (
      <div className="w-full">{renderer}</div>
    ) : (
      <div className="absolute inset-0 pb-16 pt-14 sm:py-16">{renderer}</div>
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
