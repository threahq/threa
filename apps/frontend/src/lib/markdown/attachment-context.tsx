import { createContext, useContext, useCallback, useState, type ReactNode } from "react"
import { attachmentsApi } from "@/api"
import { triggerDownload } from "@/lib/image-utils"
import { useMediaGallery } from "@/contexts"
import { isHtmlAttachment, isMarkdownAttachment } from "@/lib/attachment-kind"

interface Attachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  processingStatus?: string
}

interface AttachmentContextValue {
  openAttachment: (attachmentId: string, metaKey: boolean) => void
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

  const openAttachment = useCallback(
    async (attachmentId: string, metaKey: boolean) => {
      const attachment = attachments.find((a) => a.id === attachmentId)
      if (!attachment) return

      const isImage = attachment.mimeType.startsWith("image/")
      const isVideo = !isImage && !!attachment.processingStatus
      const isPlayableVideo =
        isVideo && (attachment.processingStatus === "completed" || attachment.processingStatus === "skipped")
      // Markdown/HTML have first-class preview surfaces in the gallery, so an
      // inline link to one should open the preview — matches what the chip
      // below the message does. Without this, links from the same file would
      // download while the sibling chip previews, which felt inconsistent.
      const isPreviewableText =
        !attachment.processingStatus && (isMarkdownAttachment(attachment) || isHtmlAttachment(attachment))

      try {
        if (metaKey) {
          const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
          window.open(url, "_blank")
        } else if (isImage || isPlayableVideo || isPreviewableText) {
          openMedia(attachmentId)
        } else {
          const url = await attachmentsApi.getDownloadUrl(workspaceId, attachmentId)
          triggerDownload(url, attachment.filename)
        }
      } catch (error) {
        console.error("Failed to get attachment URL:", error)
      }
    },
    [workspaceId, attachments, openMedia]
  )

  return (
    <AttachmentContext.Provider value={{ openAttachment, hoveredAttachmentId, setHoveredAttachmentId }}>
      {children}
    </AttachmentContext.Provider>
  )
}

export function useAttachmentContext(): AttachmentContextValue | null {
  return useContext(AttachmentContext)
}
