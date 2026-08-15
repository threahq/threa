import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Loader2,
  FileText,
  Image as ImageIcon,
  File as FileIcon,
  Film,
  Globe,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  X,
} from "lucide-react"
import { AttachmentPill, type AttachmentPillStatus } from "@/components/composer/attachment-pill"
import { Button } from "@/components/ui/button"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { useComposerPillDragHost } from "@/components/editor/composer-pill-dnd"
import type { ComposerPillDragHost } from "@/components/editor/composer-pill-drag-host"
import { useIsMobileOrCoarse } from "@/hooks/use-pointer"
import { useInputMode } from "@/hooks/use-input-mode"
import { MediaGallery, type GalleryItem } from "@/components/image-gallery"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import { buildPendingGalleryItem, uploadGalleryType, type UploadGalleryType } from "@/components/gallery/upload-preview"
import { useDecryptedAttachment } from "@/hooks/use-decrypted-attachment"
import { getAttachmentRef, type AttachmentRef } from "@/lib/crypto/attachment-crypto"
import { attachmentContentUrl } from "@/api"
import type { PendingAttachment } from "@/hooks/use-attachments"
import { retryUpload } from "@/lib/uploads/upload-manager"
import { formatFileSize } from "@/lib/file-size"
import { buildImageIndexByAttachment } from "./attachment-image-index"
import { cn } from "@/lib/utils"

// Leading-slot icon for a previewable type, matching the gallery's own glyphs
// (Globe for html, FileText for docs, Film for video). Non-previewable files
// (type null — a zip, an unknown binary) fall back to the generic file icon.
function iconForType(type: UploadGalleryType | null): typeof FileIcon {
  switch (type) {
    case "image":
      return ImageIcon
    case "video":
      return Film
    case "pdf":
    case "markdown":
    case "text":
      return FileText
    case "html":
      return Globe
    default:
      return FileIcon
  }
}

/**
 * Wraps a chip as a drag source for the editor's own sensor. A tray drag always
 * inserts a reference, so the chip stays put and the same file can be dropped
 * into the message any number of times. EVERY chip drags — uploading and failed
 * included: a reference is a binding to the id, not to finished bytes (the same
 * send-while-uploading model the message itself uses), and a chip whose gestures
 * die with its upload state hands the flick to the page instead of the tray.
 *
 * `touch-action: pan-y` gives the browser the tray's own scroll axis (the tray
 * wraps and scrolls vertically on every breakpoint); the drag itself activates
 * on a long press, which involves no movement, so it needs no axis of its own.
 */
function TrayPillDraggable({
  host,
  attachment,
  imageIndex,
  children,
}: {
  host: ComposerPillDragHost | null
  attachment: PendingAttachment
  /** "Image #N" ordinal for an image attachment, from the send-time rule. */
  imageIndex: number | null
  children: ReactNode
}) {
  const inputMode = useInputMode()
  const draggable = host !== null
  const begin = (event: MouseEvent | TouchEvent, target: EventTarget) => {
    // Every press on a chip owns the click it produces, draggable or not.
    host?.clearActivationClickSuppression()
    if (!draggable) return
    // The × and the chip body are the same pointer target; let the button win.
    if (target instanceof Element && target.closest("button")) return
    host.startTrayGesture(
      {
        kind: "tray",
        attachmentId: attachment.id,
        // Marker semantics: the doc pill is a reference, not a transfer gauge —
        // live status stays on the chip row. A reference dragged in while the
        // reservation is still in flight carries the temp id; the editor flips
        // it to the real id when the tray learns it.
        attrs: {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          status: "uploaded",
          imageIndex,
          error: null,
        },
      },
      event
    )
  }
  // Hover is a mouse affordance: on touch the press that precedes a drag would
  // fire it, and there is no leave to clear it.
  const hoverHighlights = draggable && inputMode === "mouse"
  useEffect(() => {
    if (!hoverHighlights) return
    return () => host?.highlightAttachment(null)
  }, [host, hoverHighlights])

  return (
    <span
      className={cn("inline-flex shrink-0", draggable && "cursor-grab")}
      style={{ touchAction: "pan-y" }}
      onMouseDown={(event) => begin(event.nativeEvent, event.target)}
      onTouchStart={(event) => begin(event.nativeEvent, event.target)}
      onMouseEnter={hoverHighlights ? () => host?.highlightAttachment(attachment.id) : undefined}
      onMouseLeave={hoverHighlights ? () => host?.highlightAttachment(null) : undefined}
    >
      {children}
    </span>
  )
}

const STATUS_MAP: Record<PendingAttachment["status"], AttachmentPillStatus> = {
  uploading: "pending",
  uploaded: "default",
  error: "error",
}

/** Stable identity across the temp→server id flip: the object URL never changes. */
function attachmentKey(a: PendingAttachment): string {
  return a.previewUrl ?? a.id
}

// Preview source for a chip that needs no decrypt: local bytes win for every
// previewable type (image/video/pdf/markdown/html/text) and double as the image
// thumbnail; otherwise a non-E2E image resolves to its deterministic content URL
// (thumbnail variant for the chip, full for the lightbox). Returns null for
// non-previewable files and for anything with no local bytes but a decryptable
// ref (routed to E2eChip). A present ref means "E2E, unlocked"; its absence here
// means non-E2E, where the content URL is real image bytes. Non-image types with
// no local bytes (a reloaded draft) have no static source — their server bytes
// sit behind a presign/decrypt this path doesn't reach, so they show a type icon
// until re-picked.
function staticSrc(
  a: PendingAttachment,
  type: UploadGalleryType | null,
  workspaceId: string | undefined
): { thumb?: string; full: string } | null {
  if (a.previewUrl) return { thumb: type === "image" ? a.previewUrl : undefined, full: a.previewUrl }
  if (type !== "image" || !workspaceId || getAttachmentRef(a.id)) return null
  return {
    thumb: attachmentContentUrl(workspaceId, a.id, { variant: "thumbnail" }),
    full: attachmentContentUrl(workspaceId, a.id),
  }
}

interface ChipViewProps {
  attachment: PendingAttachment
  /** Which gallery type this file previews as (drives the icon), or null. */
  galleryType: UploadGalleryType | null
  /** Leading-slot preview image; falls back to the type icon when absent/failed. */
  thumbnailSrc?: string
  /** Full-resolution URL for the lightbox, or null when not previewable. */
  fullSrc: string | null
  /** True while an E2E file's bytes are still decrypting. */
  decrypting?: boolean
  onRemove: (id: string) => void
  /** Abort an in-flight upload and drop the chip. Drives the × while uploading. */
  onCancelUpload: (id: string) => void
  onOpen: (key: string) => void
  onResolveSrc: (key: string, src: string | null) => void
  /** Inline references to this attachment in the message being composed. */
  referenceCount: number
  /** Mobile tray: a tighter label fits more chips per wrapped row. */
  compact: boolean
  /** "Image #N" ordinal for an image attachment, from the send-time rule. */
  imageIndex: number | null
  dragHost: ComposerPillDragHost | null
}

function ChipView({
  attachment,
  galleryType,
  thumbnailSrc,
  fullSrc,
  decrypting,
  onRemove,
  onCancelUpload,
  onOpen,
  onResolveSrc,
  referenceCount,
  compact,
  imageIndex,
  dragHost,
}: ChipViewProps) {
  const key = attachmentKey(attachment)

  // Publish the full-res URL so the parent can build the lightbox item list.
  useEffect(() => {
    onResolveSrc(key, fullSrc)
  }, [key, fullSrc, onResolveSrc])
  useEffect(() => () => onResolveSrc(key, null), [key, onResolveSrc])

  const status = STATUS_MAP[attachment.status]
  const isUploading = attachment.status === "uploading"
  const isError = attachment.status === "error"
  // The × stays available while uploading so a file stuck on a flaky link can
  // be abandoned instead of holding the message hostage: it aborts the
  // transfer, drops the chip, and deletes the reservation.
  const removeHandler = isUploading ? () => onCancelUpload(attachment.id) : () => onRemove(attachment.id)
  const removeLabel = isUploading ? `Cancel upload of ${attachment.filename}` : `Remove ${attachment.filename}`
  // A retryable failure's bytes are still held locally — same in-place retry
  // the timeline chip offers, instead of forcing remove-and-repick.
  const canRetry = isError && attachment.canRetry === true
  // Compact chips drop the size so two fit per wrapped mobile row; the error
  // state keeps its word — it's the tap affordance, not decoration.
  let secondary: string | undefined = compact ? undefined : formatFileSize(attachment.sizeBytes)
  if (isError) secondary = canRetry ? "Retry" : "Failed"

  const isGenericError =
    isError &&
    (attachment.error === "Internal server error" || attachment.error === "Upload failed" || !attachment.error)
  let tooltip: string | undefined
  if (isGenericError)
    tooltip = canRetry
      ? "We couldn't upload this file. Tap to retry."
      : "We couldn't upload this file. Please remove it and try again."
  else if (isError) tooltip = attachment.error

  let Icon = iconForType(galleryType)
  if (isUploading || decrypting) Icon = Loader2
  else if (isError) Icon = AlertCircle

  const canPreview = !!fullSrc && !isError
  // A drag out of the tray ends in a click on the chip; it must not also open
  // the lightbox or retry the upload.
  const guard = (run: () => void) => () => {
    if (dragHost?.activationClickSuppressed) return
    run()
  }
  let onActivate: (() => void) | undefined
  if (canRetry) onActivate = guard(() => retryUpload(attachment.id))
  else if (canPreview) onActivate = guard(() => onOpen(key))

  return (
    <TrayPillDraggable host={dragHost} attachment={attachment} imageIndex={imageIndex}>
      <AttachmentPill
        icon={Icon}
        thumbnailSrc={thumbnailSrc}
        spinning={isUploading || decrypting}
        label={attachment.filename}
        secondary={secondary}
        status={status}
        tooltip={tooltip}
        onRemove={removeHandler}
        removeLabel={removeLabel}
        progress={isUploading ? attachment.progress : undefined}
        onActivate={onActivate}
        activateLabel={canRetry ? `Retry upload of ${attachment.filename}` : `Preview ${attachment.filename}`}
        labelMaxWidth={compact ? "max-w-[72px]" : "max-w-[120px]"}
        referenceCount={referenceCount}
      />
    </TrayPillDraggable>
  )
}

/** Chip whose preview needs no decrypt: local object URL, non-E2E image thumbnail, or icon. */
function StaticChip(
  props: Omit<ChipViewProps, "galleryType" | "thumbnailSrc" | "fullSrc"> & {
    workspaceId: string | undefined
  }
) {
  const type = uploadGalleryType(props.attachment)
  const src = staticSrc(props.attachment, type, props.workspaceId)
  return <ChipView {...props} galleryType={type} thumbnailSrc={src?.thumb} fullSrc={src?.full ?? null} />
}

/** Chip for an E2E file: decrypts the bytes in memory (no server thumbnail exists). */
function E2eChip({
  attachmentRef,
  ...props
}: Omit<ChipViewProps, "galleryType" | "thumbnailSrc" | "fullSrc" | "decrypting"> & {
  attachmentRef: AttachmentRef
  workspaceId: string
}) {
  const type = uploadGalleryType(props.attachment)
  const decrypted = useDecryptedAttachment(props.workspaceId, attachmentRef)
  const url = decrypted.status === "ready" ? decrypted.url : null
  return (
    <ChipView
      {...props}
      galleryType={type}
      thumbnailSrc={type === "image" ? (url ?? undefined) : undefined}
      fullSrc={url}
      decrypting={decrypted.status === "pending"}
    />
  )
}

/**
 * Bottom-sheet overview of the whole tray (mobile): full filenames, live
 * status, per-row retry/remove, and bulk recovery — the chips themselves show
 * a couple of wrapped rows at most, so this is where "what exactly is attached
 * and what failed" gets answered at twenty attachments.
 */
function AttachmentListDrawer({
  open,
  onOpenChange,
  onAnimationEnd,
  attachments,
  onRemove,
  onCancelUpload,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAnimationEnd: (open: boolean) => void
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  onCancelUpload: (id: string) => void
}) {
  const failed = attachments.filter((a) => a.status === "error")
  const retryable = failed.filter((a) => a.canRetry === true)
  return (
    <Drawer open={open} onOpenChange={onOpenChange} onAnimationEnd={onAnimationEnd}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerTitle className="px-4 pt-1 text-sm font-medium">Attachments</DrawerTitle>
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {attachments.length} {attachments.length === 1 ? "file" : "files"}
          {failed.length > 0 && <span className="font-medium text-destructive"> · {failed.length} failed</span>}
        </p>
        <ul className="min-h-0 flex-1 overflow-y-auto px-2">
          {attachments.map((attachment) => {
            const isUploading = attachment.status === "uploading"
            const isError = attachment.status === "error"
            let Icon = iconForType(uploadGalleryType(attachment))
            if (isUploading) Icon = Loader2
            else if (isError) Icon = AlertCircle
            let statusText: ReactNode = formatFileSize(attachment.sizeBytes)
            if (isUploading) statusText = `Uploading — ${Math.round((attachment.progress ?? 0) * 100)}%`
            else if (isError) statusText = attachment.error || "Upload failed"
            return (
              <li
                key={attachmentKey(attachment)}
                className="flex items-center gap-3 border-b border-border/50 px-2 py-2.5 last:border-b-0"
              >
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground",
                    isError && "bg-destructive/10 text-destructive"
                  )}
                >
                  <Icon className={cn("h-4 w-4", isUploading && "animate-spin")} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{attachment.filename}</span>
                  <span className={cn("block truncate text-xs text-muted-foreground", isError && "text-destructive")}>
                    {statusText}
                  </span>
                </span>
                {isError && attachment.canRetry === true && (
                  <button
                    type="button"
                    className="px-2 py-1.5 text-xs font-medium text-primary"
                    onClick={() => void retryUpload(attachment.id)}
                    aria-label={`Retry upload of ${attachment.filename}`}
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-full p-1.5 text-muted-foreground active:bg-muted"
                  onClick={() => (isUploading ? onCancelUpload(attachment.id) : onRemove(attachment.id))}
                  aria-label={isUploading ? `Cancel upload of ${attachment.filename}` : `Remove ${attachment.filename}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            )
          })}
        </ul>
        {failed.length > 0 && (
          <div className="flex gap-2 px-4 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => {
                for (const a of failed) onRemove(a.id)
              }}
            >
              Remove failed
            </Button>
            {retryable.length > 0 && (
              <Button
                size="sm"
                className="flex-1"
                onClick={() => {
                  for (const a of retryable) void retryUpload(a.id)
                }}
              >
                Retry {retryable.length}
              </Button>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  )
}

interface PendingAttachmentsProps {
  attachments: PendingAttachment[]
  onRemove: (id: string) => void
  /** Abort an in-flight upload and drop its chip. */
  onCancelUpload?: (id: string) => void
  /**
   * Pills rendered inside the same flex-wrap row before the file pills.
   * Used by the composer to fold context-ref chips into the same visual
   * surface as file uploads — so users see one row of "things attached
   * to this message," not two stacked rows.
   */
  beforePills?: ReactNode
  /**
   * Anchors every preview source (non-E2E server thumbnail, E2E decrypt,
   * lightbox). Optional because the composer's own `workspaceId` is; every URL
   * path is guarded on its presence so a missing value yields an icon, never a
   * malformed `/api/workspaces//…` request (INV-11) — local previews and remove
   * still work without it.
   */
  workspaceId?: string
  /**
   * References per attachment id in the message being composed, derived from the
   * document by the composer. A referenced chip renders drawn-from, with a count
   * from two references up.
   */
  referenceCounts?: ReadonlyMap<string, number>
  /**
   * The mobile composer is in its resting (single-line bar) state: fold the
   * chips down to the rollup line so a parked draft doesn't occupy the reading
   * strip. The drawer stays reachable through the rollup; the chips return
   * when the composer opens. No effect on desktop.
   */
  resting?: boolean
}

/**
 * Composer attachment row: every attachment renders as one uniform chip
 * (filename + size + remove ×). Previewable files (image/video/pdf/markdown/
 * html/text — decided by the same {@link uploadGalleryType} the timeline uses)
 * tap/click to open the shared lightbox; images also show a preview thumbnail in
 * the leading slot (from local bytes, the non-E2E server thumbnail, or an
 * in-memory E2E decrypt). Non-previewable files keep a plain type-icon chip.
 * Renders nothing when both lists are empty.
 *
 * A one-line rollup sits above the chips on every breakpoint — count, failure
 * tally, bulk retry, fold chevron. On mobile the chips wrap to a capped couple
 * of rows and the rollup opens {@link AttachmentListDrawer} for the full list;
 * desktop's taller wrapped tray is its own full list, so the summary there is
 * plain text.
 */
export function PendingAttachments({
  attachments,
  onRemove,
  onCancelUpload,
  beforePills,
  workspaceId,
  referenceCounts,
  resting = false,
}: PendingAttachmentsProps) {
  const isMobile = useIsMobileOrCoarse()
  const dragHost = useComposerPillDragHost()
  // Mobile space controls: start at the one-line rollup because the composer
  // already competes with the keyboard for the viewport; the drawer holds the
  // full list. Desktop keeps the chips open.
  const [collapsed, setCollapsed] = useState(isMobile)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // True from close until vaul's exit animation lands, so removing the last
  // attachment from the open sheet slides it out instead of snapping the whole
  // subtree out of the DOM.
  const [drawerExiting, setDrawerExiting] = useState(false)
  const handleDrawerOpenChange = useCallback((open: boolean) => {
    setDrawerOpen(open)
    if (!open) setDrawerExiting(true)
  }, [])
  const handleDrawerAnimationEnd = useCallback((open: boolean) => {
    if (!open) setDrawerExiting(false)
  }, [])
  const attachmentCount = attachments.length
  useEffect(() => {
    if (attachmentCount === 0 && drawerOpen) handleDrawerOpenChange(false)
  }, [attachmentCount, drawerOpen, handleDrawerOpenChange])
  // Open lightbox tracked by the stable attachment key, not the id (which flips
  // temp→server on upload completion), so an open preview survives its upload.
  const [openKey, setOpenKey] = useState<string | null>(null)
  // Preview URL per previewable chip, published by each chip (a chip owns the
  // E2E decrypt / object-URL lifecycle), so the lightbox item list has every source.
  const [srcByKey, setSrcByKey] = useState<Map<string, string>>(new Map())

  const onResolveSrc = useCallback((key: string, src: string | null) => {
    setSrcByKey((prev) => {
      if ((prev.get(key) ?? null) === src) return prev
      const next = new Map(prev)
      if (src) next.set(key, src)
      else next.delete(key)
      return next
    })
  }, [])

  // A tray-dragged image reference carries the same ordinal send would give it,
  // so two references to one image never read as different files.
  const imageIndexes = useMemo(() => buildImageIndexByAttachment(attachments), [attachments])

  const galleryItems = useMemo<GalleryItem[]>(
    () =>
      attachments
        .map((a): GalleryItem | null => {
          const type = uploadGalleryType(a)
          if (!type) return null
          const key = attachmentKey(a)
          const url = srcByKey.get(key)
          if (!url) return null
          return buildPendingGalleryItem(type, url, a.filename, key)
        })
        .filter((item): item is GalleryItem => item !== null),
    [attachments, srcByKey]
  )

  // The drawer must survive its exit animation even when the list empties.
  if (attachments.length === 0 && !beforePills && !drawerOpen && !drawerExiting) return null

  const galleryIndex = openKey ? galleryItems.findIndex((g) => g.attachmentId === pendingGalleryId(openKey)) : -1

  const failedCount = attachments.filter((a) => a.status === "error").length
  const uploadingCount = attachments.filter((a) => a.status === "uploading").length
  const retryableIds = attachments.filter((a) => a.status === "error" && a.canRetry === true).map((a) => a.id)
  const CollapseChevron = collapsed ? ChevronDown : ChevronUp
  // Resting folds everything (context-ref pills included — same rule as the
  // composer's link previews); the manual fold only exists while the rollup
  // renders, so it scopes to having attachments.
  const foldChips = (isMobile && resting) || (collapsed && attachments.length > 0)

  const rollupSummary = (
    <>
      <span className="truncate">
        {attachments.length} {attachments.length === 1 ? "file" : "files"}
        {uploadingCount > 0 && ` · ${uploadingCount} uploading`}
      </span>
      {failedCount > 0 && <span className="font-medium text-destructive">· {failedCount} failed</span>}
    </>
  )

  return (
    <>
      {attachments.length > 0 && (
        // The rollup renders on every breakpoint — the counts, bulk retry and
        // fold ARE the overview; only the drawer behind the mobile tap is a
        // phone affordance (desktop's wrapped tray is its own full list).
        // preventDefault keeps editor focus (and the keyboard) through taps on
        // this line's buttons — same guard as the composer's action bar. Safe
        // as a blanket here: every child is our own button, nothing portaled.
        <div
          className="mb-1.5 flex h-6 shrink-0 items-center gap-3 text-xs text-muted-foreground"
          onMouseDown={(event) => event.preventDefault()}
        >
          {isMobile ? (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1"
              onClick={() => setDrawerOpen(true)}
              aria-label="Show all attachments"
            >
              {rollupSummary}
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            </button>
          ) : (
            <span className="flex min-w-0 items-center gap-1">{rollupSummary}</span>
          )}
          {retryableIds.length > 0 && (
            <button
              type="button"
              className="shrink-0 font-medium text-primary"
              onClick={() => {
                for (const id of retryableIds) void retryUpload(id)
              }}
            >
              Retry {retryableIds.length}
            </button>
          )}
          {!resting && (
            <button
              type="button"
              className="-m-1 ml-auto shrink-0 p-1"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? "Show attachment chips" : "Hide attachment chips"}
            >
              <CollapseChevron className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
      {!foldChips && (attachments.length > 0 || beforePills) && (
        <div
          data-testid="attachment-chip-row"
          className={cn(
            // shrink-0: the tray is a flex child of the composer shell, whose
            // height is capped (drag handle / 380px). Shrinkable, it absorbed
            // the whole deficit — chips sliced off at the bottom — while the
            // editor card kept its size. The cap belongs to the card.
            "flex shrink-0 flex-wrap items-center mb-3 overflow-y-auto",
            // Two chip rows plus a sliver of the third, so "there's more" is
            // visible without stealing the strip the composer already fights
            // the keyboard for. The full list lives in the drawer.
            isMobile ? "max-h-[96px] gap-1.5" : "max-h-[120px] gap-2"
          )}
        >
          {beforePills}
          {attachments.map((attachment) => {
            const key = attachmentKey(attachment)
            const ref =
              workspaceId && !attachment.previewUrl && uploadGalleryType(attachment) != null
                ? getAttachmentRef(attachment.id)
                : undefined
            const shared = {
              attachment,
              onRemove,
              onCancelUpload: onCancelUpload ?? onRemove,
              onOpen: setOpenKey,
              onResolveSrc,
              referenceCount: referenceCounts?.get(attachment.id) ?? 0,
              compact: isMobile,
              imageIndex: imageIndexes.get(attachment) ?? null,
              dragHost,
            }
            return ref && workspaceId ? (
              <E2eChip key={key} attachmentRef={ref} workspaceId={workspaceId} {...shared} />
            ) : (
              <StaticChip key={key} workspaceId={workspaceId} {...shared} />
            )
          })}
        </div>
      )}
      {isMobile && (attachments.length > 0 || drawerOpen || drawerExiting) && (
        <AttachmentListDrawer
          open={drawerOpen}
          onOpenChange={handleDrawerOpenChange}
          onAnimationEnd={handleDrawerAnimationEnd}
          attachments={attachments}
          onRemove={onRemove}
          onCancelUpload={onCancelUpload ?? onRemove}
        />
      )}

      {workspaceId && galleryItems.length > 0 && (
        <MediaGallery
          isOpen={galleryIndex !== -1}
          onClose={() => setOpenKey(null)}
          items={galleryItems}
          initialIndex={Math.max(0, galleryIndex)}
          workspaceId={workspaceId}
        />
      )}
    </>
  )
}
