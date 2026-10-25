import { createContext, useContext, useCallback, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { collectInlineAttachmentIds, parseMarkdown } from "@threahq/prosemirror"
import { attachmentsApi } from "@/api"
import { triggerDownload } from "@/lib/image-utils"
import { useMediaGallery } from "@/contexts"
import {
  isHtmlAttachment,
  isMarkdownAttachment,
  isPdfAttachment,
  isTextPreviewableAttachment,
} from "@/lib/attachment-kind"
import { attachmentPendingState, PENDING_STATE_LABELS } from "@/lib/attachments/pending-state"

interface Attachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  processingStatus?: string
  safetyStatus?: string
  uploadStatus?: string
  width?: number
  height?: number
}

type AttachmentPendingState = ReturnType<typeof attachmentPendingState>

function pendingStateOf(attachment: Attachment): AttachmentPendingState {
  return attachmentPendingState(attachment as Parameters<typeof attachmentPendingState>[0])
}

/**
 * Attachments the message body renders as inline images: referenced with
 * `display=inline`, an image row, and downloadable. Everything else referenced
 * inline (pending, E2E octet-stream placeholders, non-images) stays a chip.
 */
function resolveInlineImages(contentMarkdown: string, attachments: Attachment[]): ReadonlyMap<string, Attachment> {
  const candidates = attachments.filter((a) => a.mimeType.startsWith("image/") && !pendingStateOf(a))
  // The serializer spells an inline reference with this token, so a body
  // without it has nothing to parse (the common pill-only image message).
  if (candidates.length === 0 || !contentMarkdown.includes("display=inline")) return new Map()
  const inlineIds = new Set(collectInlineAttachmentIds(parseMarkdown(contentMarkdown)))
  return new Map(candidates.filter((a) => inlineIds.has(a.id)).map((a) => [a.id, a]))
}

interface AttachmentContextValue {
  workspaceId: string
  /** Rendered in the body in place of a chip; the strip below hides their tiles. */
  inlineImages: ReadonlyMap<string, Attachment>
  openAttachment: (attachmentId: string, metaKey: boolean) => void
  /**
   * Live upload/scan state for one of this message's attachments, so the
   * inline `attachment:` link renders (and behaves) consistently with the
   * status chip below the message — its bytes may not exist yet.
   */
  getAttachmentPendingState: (attachmentId: string) => AttachmentPendingState
  hoveredAttachmentId: string | null
  setHoveredAttachmentId: (id: string | null) => void
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null)

interface AttachmentProviderProps {
  workspaceId: string
  attachments: Attachment[]
  contentMarkdown: string
  children: ReactNode
}

/**
 * Provider for attachment context in rendered markdown.
 * Enables attachment links to open images/videos in gallery or trigger downloads.
 *
 * Gallery display is delegated to the sibling AttachmentList via the shared
 * ?media= URL parameter (MediaGalleryContext).
 */
export function AttachmentProvider({ workspaceId, attachments, contentMarkdown, children }: AttachmentProviderProps) {
  const [hoveredAttachmentId, setHoveredAttachmentId] = useState<string | null>(null)
  const { openMedia } = useMediaGallery()

  const inlineImages = useMemo(() => resolveInlineImages(contentMarkdown, attachments), [contentMarkdown, attachments])

  const getAttachmentPendingState = useCallback(
    (attachmentId: string): AttachmentPendingState => {
      const attachment = attachments.find((a) => a.id === attachmentId)
      return attachment ? pendingStateOf(attachment) : null
    },
    [attachments]
  )

  const openAttachment = useCallback(
    async (attachmentId: string, metaKey: boolean) => {
      const attachment = attachments.find((a) => a.id === attachmentId)
      if (!attachment) return

      // Bytes may not exist yet (send-while-uploading) or are blocked — a
      // download/preview would 404 or 403 with no explanation.
      const pending = pendingStateOf(attachment)
      if (pending) {
        // In-flight states are routine, not failures — error styling is
        // reserved for failed/blocked so a red toast always means something
        // is actually wrong (INV-63).
        if (pending === "uploading" || pending === "scanning") {
          toast.info(`This file isn't available yet — ${PENDING_STATE_LABELS[pending].toLowerCase()}`)
        } else {
          toast.error(
            pending === "blocked"
              ? "This file was blocked by the malware scan"
              : `This file isn't available yet — ${PENDING_STATE_LABELS[pending].toLowerCase()}`
          )
        }
        return
      }

      const isImage = attachment.mimeType.startsWith("image/")
      const isVideo = !isImage && !!attachment.processingStatus
      const isPlayableVideo =
        isVideo && (attachment.processingStatus === "completed" || attachment.processingStatus === "skipped")
      // Markdown/HTML/PDF have first-class preview surfaces in the gallery, so
      // an inline link to one should open the preview — matches what the chip
      // below the message does. Without this, links from the same file would
      // download while the sibling chip previews, which felt inconsistent.
      const isPreviewableDocument =
        !attachment.processingStatus &&
        (isMarkdownAttachment(attachment) ||
          isHtmlAttachment(attachment) ||
          isPdfAttachment(attachment) ||
          isTextPreviewableAttachment(attachment))

      try {
        if (metaKey) {
          const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
          window.open(url, "_blank")
        } else if (isImage || isPlayableVideo || isPreviewableDocument) {
          openMedia(attachmentId)
        } else {
          const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
          triggerDownload(url, attachment.filename)
        }
      } catch (error) {
        console.error("Failed to get attachment URL:", error)
        toast.error("Couldn't open this attachment")
      }
    },
    [workspaceId, attachments, openMedia]
  )

  const value = useMemo(
    () => ({
      workspaceId,
      inlineImages,
      openAttachment,
      getAttachmentPendingState,
      hoveredAttachmentId,
      setHoveredAttachmentId,
    }),
    [workspaceId, inlineImages, openAttachment, getAttachmentPendingState, hoveredAttachmentId]
  )

  return <AttachmentContext.Provider value={value}>{children}</AttachmentContext.Provider>
}

export function useAttachmentContext(): AttachmentContextValue | null {
  return useContext(AttachmentContext)
}
