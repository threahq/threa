import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Document, Page, pdfjs } from "react-pdf"
import { FileText } from "lucide-react"
// Vite bundles the worker as a static asset and gives us its URL. Pinning
// pdfjs-dist to the version react-pdf depends on keeps the worker API in sync
// with the core — version mismatches surface as cryptic "Cannot read property
// of undefined" errors deep inside the worker.
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url"
// react-pdf positions the canvas behind a transparent text layer for selection
// and an annotation layer for links. Without these stylesheets the layers
// stack on top of the canvas and the document looks empty.
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker

interface PdfPagesRendererProps {
  url: string
  filename: string
  /** `gallery` paints on a dark surface (lightbox); `inline` paints on the
   *  app's card surface (attachment explorer). */
  variant: "gallery" | "inline"
}

/**
 * Renders a PDF by streaming pages through PDF.js into <canvas> elements. We
 * fall back to this on mobile because iOS Safari (and Android WebView, and
 * older Android Chrome) won't render a PDF inside an <iframe> — they either
 * download the file or open it in the system viewer. Desktop keeps using the
 * browser-native PDF viewer via PdfViewer's iframe path because its toolbar,
 * search, and printing are better than anything we'd ship.
 *
 * Lazy-loaded by `PdfViewer` so the ~300KB PDF.js bundle only ships when the
 * user actually opens a PDF preview.
 */
export default function PdfPagesRenderer({ url, filename, variant }: PdfPagesRendererProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState<number | null>(null)
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [errored, setErrored] = useState(false)

  // Re-measure on resize so rotating the device or resizing the panel
  // re-renders pages at the new width. <Page width> drives canvas size, so
  // this is what makes the document responsive.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => setContainerWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    setPageCount(null)
    setErrored(false)
  }, [url])

  // Keep the {url} prop stable across renders — react-pdf re-fetches when the
  // file reference changes by identity, even if the URL string is the same.
  const file = useMemo(() => ({ url }), [url])

  const isGallery = variant === "gallery"

  if (errored) {
    return (
      <div
        className={
          isGallery
            ? "flex flex-col items-center gap-2 text-white/70"
            : "flex flex-col items-center gap-2 text-muted-foreground"
        }
      >
        <FileText className="h-6 w-6" />
        <div className="text-xs">Couldn't render this PDF.</div>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className={isGallery ? "text-xs text-white underline" : "text-xs text-primary underline"}
        >
          Open original
        </a>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      data-gallery-text-viewer="true"
      className={
        isGallery
          ? "mx-auto flex h-full w-full max-w-[900px] flex-col items-center gap-2 overflow-y-auto px-2 py-4"
          : "mx-auto flex max-h-[60vh] w-full max-w-[800px] flex-col items-center gap-2 overflow-y-auto px-2 py-2"
      }
    >
      {containerWidth !== null ? (
        <Document
          file={file}
          onLoadSuccess={({ numPages }) => setPageCount(numPages)}
          onLoadError={() => setErrored(true)}
          loading={
            <div className={isGallery ? "py-10 text-xs text-white/70" : "py-10 text-xs text-muted-foreground"}>
              Loading {filename}…
            </div>
          }
          error={null}
          className="flex flex-col items-center gap-2"
        >
          {pageCount !== null
            ? Array.from({ length: pageCount }, (_, i) => (
                <Page
                  key={`page-${i + 1}`}
                  pageNumber={i + 1}
                  width={containerWidth - 16}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  className="overflow-hidden rounded-lg bg-white shadow-md"
                />
              ))
            : null}
        </Document>
      ) : null}
    </div>
  )
}
