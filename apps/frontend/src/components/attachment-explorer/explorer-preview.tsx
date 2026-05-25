import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import { categoryFromMime } from "@threa/types"
import { Check, ChevronDown, ChevronUp, Code2, Copy, Download, ExternalLink, Eye, Hash } from "lucide-react"
import { attachmentsApi, type AttachmentExtractionContent, type AttachmentSearchItem } from "@/api/attachments"
import { Button } from "@/components/ui/button"
import { HtmlViewer } from "@/components/gallery/html-viewer"
import { MarkdownViewer } from "@/components/gallery/markdown-viewer"
import { PdfViewer } from "@/components/gallery/pdf-viewer"
import { ProgressiveImage } from "@/components/ui/progressive-image"
import { useFormattedDate } from "@/hooks"
import { isHtmlAttachment, isMarkdownAttachment, isPdfAttachment } from "@/lib/attachment-kind"
import { stripMarkdownToInline } from "@/lib/markdown"
import { formatFileSize } from "@/lib/file-size"
import { CATEGORY_META } from "./category"

interface ExplorerPreviewProps {
  workspaceId: string
  item: AttachmentSearchItem | null
}

export function ExplorerPreview({ workspaceId, item }: ExplorerPreviewProps) {
  const { formatFull } = useFormattedDate()
  const [rawUrl, setRawUrl] = useState<string | null>(null)
  const [processedUrl, setProcessedUrl] = useState<string | null>(null)
  // Image-only: fetched in parallel with the raw URL so the preview pane has
  // something painted while the full-resolution variant streams in.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  // Source vs. rendered toggle for markdown/html. Resets per item so a fresh
  // selection always lands on the rendered view.
  const [rawMode, setRawMode] = useState(false)
  const previewRef = useRef<HTMLPreElement | null>(null)
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Tracks which attachment is currently selected so handleCopy can drop
  // post-await state writes (setCopied, timer) when the user switched items
  // mid-flight.
  const currentAttachmentIdRef = useRef<string | null>(item?.id ?? null)

  // Reset per-item UI state so a fresh selection never inherits the previous
  // item's expanded view or "Copied" badge.
  useEffect(() => {
    currentAttachmentIdRef.current = item?.id ?? null
    setExpanded(false)
    setCopied(false)
    setIsTruncated(false)
    setRawMode(false)
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = null
    }
  }, [item?.id])

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  // Hide the Expand button when the line-clamped preview already fits the
  // full content — toggling it would just rerender the same text. Re-measures
  // on resize so the panel-resize handle keeps the button in sync.
  useLayoutEffect(() => {
    if (expanded) return
    const el = previewRef.current
    if (!el) return
    const measure = () => setIsTruncated(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, item?.id, item?.extraction?.summary])

  const attachmentId = item?.id
  const fullExtraction = useQuery<AttachmentExtractionContent>({
    queryKey: ["attachment-extraction", workspaceId, attachmentId],
    queryFn: () => {
      if (!attachmentId) throw new Error("Missing attachment id")
      return attachmentsApi.getExtraction(workspaceId, attachmentId)
    },
    enabled: Boolean(attachmentId) && expanded,
    staleTime: 5 * 60_000,
  })

  const handleCopy = useCallback(async () => {
    if (!item) return
    const copiedAttachmentId = item.id
    try {
      const data = fullExtraction.data ?? (await attachmentsApi.getExtraction(workspaceId, item.id))
      const text = data.fullText ?? data.summary
      await navigator.clipboard.writeText(text)
      // Drop the result if the user switched attachments while we were awaiting
      // the fetch or the clipboard write — otherwise the badge and reset timer
      // would attach to the newly selected item.
      if (currentAttachmentIdRef.current !== copiedAttachmentId) return
      setCopied(true)
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = setTimeout(() => {
        setCopied(false)
        copyResetTimerRef.current = null
      }, 2000)
    } catch {
      // Clipboard API unavailable or fetch failed — silent: the user can still
      // open the original via the Download button if they need the contents.
    }
  }, [item, workspaceId, fullExtraction.data])

  const category = item ? categoryFromMime(item.mimeType) : null

  useEffect(() => {
    setRawUrl(null)
    setProcessedUrl(null)
    setThumbnailUrl(null)
    setPreviewError(null)
    if (!item) return
    let cancelled = false
    if (category === "image") {
      attachmentsApi
        .getDownloadUrl(workspaceId, item.id, { variant: "thumbnail" })
        .then((url) => {
          if (!cancelled) setThumbnailUrl(url)
        })
        .catch(() => {
          // Thumbnail is best-effort — the raw fetch below still drives the
          // real preview, and ProgressiveImage degrades to raw-only gracefully.
        })
    }
    attachmentsApi
      .getDownloadUrl(workspaceId, item.id, { variant: "raw" })
      .then((url) => {
        if (!cancelled) setRawUrl(url)
      })
      .catch((err) => {
        if (cancelled) return
        setPreviewError(err instanceof Error ? err.message : "Failed to load preview")
      })
    if (category === "video" && item.processingStatus === "completed") {
      attachmentsApi
        .getDownloadUrl(workspaceId, item.id, { variant: "processed" })
        .then((url) => {
          if (!cancelled) setProcessedUrl(url)
        })
        .catch(() => {
          // Processed variant is optional — fall back to raw silently.
        })
    }
    return () => {
      cancelled = true
    }
  }, [workspaceId, item, category])

  if (!item || !category) {
    return (
      <div className="flex h-full items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
        Select a file to preview it here.
      </div>
    )
  }

  // Bind a non-null narrowing of `item` so the inner `renderMedia` closure
  // doesn't have to re-prove that `item` is still non-null after the early
  // return — TS can't propagate narrowing into nested function bodies.
  const selected = item
  const meta = CATEGORY_META[category]
  const Icon = meta.icon
  const sourceUrl =
    selected.streamId && selected.messageId ? `/w/${workspaceId}/s/${selected.streamId}?m=${selected.messageId}` : null
  // Browsers handle iPhone .mov source poorly; prefer the transcoded mp4 when ready.
  const playbackUrl = category === "video" ? (processedUrl ?? rawUrl) : rawUrl
  const isMarkdown = isMarkdownAttachment(selected)
  const isHtml = isHtmlAttachment(selected)
  const isPdf = isPdfAttachment(selected)
  const canToggleRaw = isMarkdown || isHtml

  function renderMedia() {
    if (previewError) {
      return <div className="px-6 py-4 text-xs text-muted-foreground">{previewError}</div>
    }
    // Images bypass the "no rawUrl yet" fallback so the thumbnail can paint as
    // soon as it lands — ProgressiveImage will then crossfade to the raw
    // variant when it arrives.
    if (category === "image" && (rawUrl || thumbnailUrl)) {
      return (
        <ProgressiveImage
          src={rawUrl}
          posterSrc={thumbnailUrl}
          alt={selected.filename}
          imgClassName="block max-h-[50vh] min-w-0 max-w-full"
        />
      )
    }
    if (isMarkdown && rawUrl) {
      return <MarkdownViewer url={rawUrl} filename={selected.filename} rawMode={rawMode} variant="inline" />
    }
    if (isHtml && rawUrl) {
      return <HtmlViewer url={rawUrl} filename={selected.filename} rawMode={rawMode} variant="inline" />
    }
    if (isPdf && rawUrl) {
      return <PdfViewer url={rawUrl} filename={selected.filename} variant="inline" />
    }
    if (!rawUrl) {
      return (
        <div className={`flex h-16 w-16 items-center justify-center rounded-card ${meta.accent}`}>
          <Icon className="h-8 w-8" />
        </div>
      )
    }
    if (category === "video") {
      return <video src={playbackUrl ?? undefined} controls className="block max-h-[50vh] min-w-0 max-w-full" />
    }
    if (category === "audio") {
      return (
        <div className="w-full px-6">
          <audio src={rawUrl} controls className="w-full" />
        </div>
      )
    }
    return (
      <a
        href={rawUrl}
        target="_blank"
        rel="noreferrer"
        className="group flex flex-col items-center gap-3 rounded-card border border-transparent px-6 py-5 transition-colors hover:border-border hover:bg-card"
      >
        <div className={`flex h-16 w-16 items-center justify-center rounded-card ${meta.accent}`}>
          <Icon className="h-8 w-8" />
        </div>
        <span className="text-xs font-medium text-primary underline-offset-4 group-hover:underline">Open original</span>
      </a>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-[200px] items-center justify-center overflow-hidden bg-muted/30 px-4 py-6">
          {renderMedia()}
        </div>

        <div className="space-y-3 border-t p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-4">
          <div className="space-y-1">
            <div className="break-all text-sm font-medium">{item.filename}</div>
            <div className="text-xs text-muted-foreground">
              {item.uploaderName ? <span>{item.uploaderName} · </span> : null}
              {item.streamSlug ? (
                <>
                  <Hash className="mr-0.5 inline h-3 w-3 align-[-2px]" />
                  {item.streamSlug} ·{" "}
                </>
              ) : null}
              <span title={formatFull(new Date(item.createdAt))}>{formatFull(new Date(item.createdAt))}</span>
              <span> · {formatFileSize(item.sizeBytes)}</span>
            </div>
          </div>

          {item.extraction?.summary ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium text-muted-foreground">Extract</div>
                <div className="flex items-center gap-1">
                  {isTruncated || expanded ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setExpanded((v) => !v)}
                      aria-expanded={expanded}
                    >
                      {expanded ? (
                        <>
                          <ChevronUp className="h-3 w-3" />
                          Collapse
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-3 w-3" />
                          Expand
                        </>
                      )}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={handleCopy}
                    aria-label="Copy full extraction"
                  >
                    {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              </div>
              {expanded ? (
                <ExpandedExtract item={item} query={fullExtraction} />
              ) : (
                <pre
                  ref={previewRef}
                  className="line-clamp-5 whitespace-pre-wrap rounded-card bg-muted/40 p-3 text-xs leading-relaxed text-foreground/80"
                >
                  {stripMarkdownToInline(item.extraction.summary)}
                </pre>
              )}
            </div>
          ) : null}

          {item.referenceCount > 0 ? (
            <div className="text-xs text-muted-foreground">
              Referenced by {item.referenceCount} message{item.referenceCount === 1 ? "" : "s"}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            {sourceUrl ? (
              <Button size="sm" asChild>
                <Link to={sourceUrl} className="gap-1">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Show message
                </Link>
              </Button>
            ) : null}
            {canToggleRaw ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRawMode((v) => !v)}
                aria-pressed={rawMode}
                aria-label={rawMode ? "Show rendered preview" : "Show raw source"}
                className="gap-1"
              >
                {rawMode ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
                {rawMode ? "Rendered" : "Source"}
              </Button>
            ) : null}
            {rawUrl ? (
              <Button size="sm" variant="outline" asChild>
                <a href={rawUrl} download={item.filename} className="gap-1">
                  <Download className="h-3.5 w-3.5" />
                  {processedUrl ? "Original" : "Download"}
                </a>
              </Button>
            ) : null}
            {processedUrl ? (
              <Button size="sm" variant="ghost" asChild>
                <a href={processedUrl} download={item.filename.replace(/\.[^.]+$/, ".mp4")} className="gap-1">
                  <Download className="h-3.5 w-3.5" />
                  Processed (.mp4)
                </a>
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

interface ExpandedExtractProps {
  item: AttachmentSearchItem
  query: UseQueryResult<AttachmentExtractionContent>
}

function ExpandedExtract({ item, query }: ExpandedExtractProps) {
  if (query.isLoading) {
    return <p className="text-xs leading-relaxed text-muted-foreground">Loading…</p>
  }
  if (query.isError) {
    return <p className="text-xs leading-relaxed text-muted-foreground">Couldn't load the full extract.</p>
  }
  return (
    <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-card bg-muted/40 p-3 text-xs leading-relaxed text-foreground/80">
      {stripMarkdownToInline(query.data?.fullText ?? query.data?.summary ?? item.extraction?.summary ?? "")}
    </pre>
  )
}
