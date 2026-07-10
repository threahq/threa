import { createContext, useContext, useCallback, useState, type ReactNode } from "react"
import { toast } from "sonner"
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
}

type AttachmentPendingState = ReturnType<typeof attachmentPendingState>

interface AttachmentContextValue {
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
  children: ReactNode
}

/**
 * Provider for attachment context in rendered markdown.
 * Enables attachment links to open images/videos in gallery or trigger downloads.
 *
 * Gallery display is delegated to the sibling AttachmentList via the shared
 * ?media= URL parameter (MediaGalleryContext).
 */
export function AttachmentProvider({ workspaceId, attachments, children }: AttachmentProviderProps) {
  const [hoveredAttachmentId, setHoveredAttachmentId] = useState<string | null>(null)
  const { openMedia } = useMediaGallery()

  const getAttachmentPendingState = useCallback(
    (attachmentId: string): AttachmentPendingState => {
      const attachment = attachments.find((a) => a.id === attachmentId)
      return attachment ? attachmentPendingState(attachment as Parameters<typeof attachmentPendingState>[0]) : null
    },
    [attachments]
  )

  const openAttachment = useCallback(
    async (attachmentId: string, metaKey: boolean) => {
      const attachment = attachments.find((a) => a.id === attachmentId)
      if (!attachment) return

      // Bytes may not exist yet (send-while-uploading) or are blocked — a
      // download/preview would 404 or 403 with no explanation.
      const pending = attachmentPendingState(attachment as Parameters<typeof attachmentPendingState>[0])
      if (pending) {
        toast.error(
          pending === "blocked"
            ? "This file was blocked by the malware scan"
            : `This file isn't available yet — ${PENDING_STATE_LABELS[pending].toLowerCase()}`
        )
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

  return (
    <AttachmentContext.Provider
      value={{ openAttachment, getAttachmentPendingState, hoveredAttachmentId, setHoveredAttachmentId }}
    >
      {children}
    </AttachmentContext.Provider>
  )
}

export function useAttachmentContext(): AttachmentContextValue | null {
  return useContext(AttachmentContext)
}
