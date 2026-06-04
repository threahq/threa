import { useState, useCallback, useRef, type ChangeEvent, type RefObject } from "react"
import { attachmentsApi } from "@/api"
import { encryptAttachmentBytes, rememberAttachmentRef } from "@/lib/crypto/attachment-crypto"

/** The placeholder name/mime the server forces for E2E ciphertext uploads. */
const E2E_CIPHERTEXT_FILENAME = "encrypted"
const E2E_CIPHERTEXT_MIME = "application/octet-stream"

interface UploadOptions {
  /**
   * When the destination stream is E2E, encrypt each file client-side before
   * upload and stash its key/iv so the send path can seal them into the
   * message's `attachmentRefs`.
   */
  e2eEnabled?: boolean
}

/** The canonical facts a successful upload yields, regardless of E2E. */
interface UploadedFacts {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface PendingAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: "uploading" | "uploaded" | "error"
  error?: string
}

export interface UploadResult {
  /** The uploaded attachment */
  attachment: PendingAttachment
  /** For images, the sequential index (1, 2, 3...). Null for non-images. */
  imageIndex: number | null
  /** Temporary ID used during upload - use this to track the node */
  tempId: string
}

export interface UseAttachmentsReturn {
  /** Current pending attachments */
  pendingAttachments: PendingAttachment[]
  /** Synchronous snapshot of attachments for submit paths that must not depend on render timing */
  getPendingAttachmentsSnapshot: () => PendingAttachment[]
  /** Ref to attach to a hidden file input */
  fileInputRef: RefObject<HTMLInputElement | null>
  /** Handler for file input change event */
  handleFileSelect: (e: ChangeEvent<HTMLInputElement>) => void
  /** Upload a file programmatically (for paste/drop). Returns temp ID for tracking. */
  uploadFile: (file: File) => Promise<UploadResult>
  /** Remove an attachment by ID */
  removeAttachment: (id: string) => void
  /** IDs of successfully uploaded attachments */
  uploadedIds: string[]
  /** Whether any files are currently uploading */
  isUploading: boolean
  /** Whether any uploads failed */
  hasFailed: boolean
  /** Clear all attachments */
  clear: () => void
  /** Restore attachments from saved state */
  restore: (attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>) => void
  /** Current image count for numbering */
  imageCount: number
}

export function useAttachments(workspaceId: string, options?: UploadOptions): UseAttachmentsReturn {
  const e2eEnabled = options?.e2eEnabled === true
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([])
  const [imageCount, setImageCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const updatePendingAttachments = useCallback(
    (updater: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[])) => {
      setPendingAttachments((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater
        pendingAttachmentsRef.current = next
        return next
      })
    },
    []
  )

  const getPendingAttachmentsSnapshot = useCallback(() => pendingAttachmentsRef.current, [])

  // The single upload chokepoint both entry points (file-picker + paste/drop)
  // route through, so the E2E encrypt-before-upload rule can't drift between
  // them. For E2E we upload opaque ciphertext (the server forces a placeholder
  // name/mime) and keep the real facts locally for the composer chip and the
  // message ref; non-E2E uploads the file as-is and trusts the server's echo.
  const uploadOne = useCallback(
    async (file: File): Promise<UploadedFacts> => {
      if (e2eEnabled) {
        const plaintext = new Uint8Array(await file.arrayBuffer())
        const { ciphertext, key, iv } = await encryptAttachmentBytes(plaintext)
        const cipherFile = new File([ciphertext], E2E_CIPHERTEXT_FILENAME, { type: E2E_CIPHERTEXT_MIME })
        const attachment = await attachmentsApi.upload(workspaceId, cipherFile, { e2e: true })
        if (!attachment?.id) throw new Error("Invalid response: missing attachment data")
        const filename = file.name
        const mimeType = file.type || E2E_CIPHERTEXT_MIME
        rememberAttachmentRef({ attachmentId: attachment.id, key, iv, filename, mimeType, sizeBytes: file.size })
        return { id: attachment.id, filename, mimeType, sizeBytes: file.size }
      }
      const attachment = await attachmentsApi.upload(workspaceId, file)
      if (!attachment?.id) throw new Error("Invalid response: missing attachment data")
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      }
    },
    [workspaceId, e2eEnabled]
  )

  const handleFileSelect = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      // Convert to array before resetting value — Chrome clears the FileList in-place
      // when input.value is reset, so the reference would be empty if captured after.
      const files = Array.from(e.target.files ?? [])
      if (files.length === 0) return

      // Reset input so same file can be selected again
      e.target.value = ""

      for (const file of files) {
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`

        // Add as uploading
        updatePendingAttachments((prev) => [
          ...prev,
          {
            id: tempId,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            status: "uploading",
          },
        ])

        try {
          const facts = await uploadOne(file)

          // Replace temp with real attachment
          updatePendingAttachments((prev) =>
            prev.map((a) => (a.id === tempId ? { ...facts, status: "uploaded" as const } : a))
          )
        } catch (err) {
          // Mark as error
          updatePendingAttachments((prev) =>
            prev.map((a) =>
              a.id === tempId
                ? {
                    ...a,
                    status: "error" as const,
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : a
            )
          )
        }
      }
    },
    [updatePendingAttachments, uploadOne]
  )

  // Use ref to track image count synchronously for proper indexing
  const imageCountRef = useRef(imageCount)
  imageCountRef.current = imageCount

  const uploadFile = useCallback(
    async (file: File): Promise<UploadResult> => {
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const isImage = file.type.startsWith("image/")
      let assignedImageIndex: number | null = null

      // Assign image index immediately if it's an image
      // Use ref for synchronous access, then update state
      if (isImage) {
        assignedImageIndex = imageCountRef.current + 1
        imageCountRef.current = assignedImageIndex
        setImageCount(assignedImageIndex)
      }

      const pendingAttachment: PendingAttachment = {
        id: tempId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
      }

      // Add as uploading
      updatePendingAttachments((prev) => [...prev, pendingAttachment])

      try {
        const facts = await uploadOne(file)

        const uploadedAttachment: PendingAttachment = {
          ...facts,
          status: "uploaded",
        }

        // Replace temp with real attachment
        updatePendingAttachments((prev) => prev.map((a) => (a.id === tempId ? uploadedAttachment : a)))

        return {
          attachment: uploadedAttachment,
          imageIndex: assignedImageIndex,
          tempId,
        }
      } catch (err) {
        const errorAttachment: PendingAttachment = {
          ...pendingAttachment,
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        }

        // Mark as error
        updatePendingAttachments((prev) => prev.map((a) => (a.id === tempId ? errorAttachment : a)))

        return {
          attachment: errorAttachment,
          imageIndex: assignedImageIndex,
          tempId,
        }
      }
    },
    [updatePendingAttachments, uploadOne]
  )

  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      const attachment = pendingAttachmentsRef.current.find((a) => a.id === attachmentId)
      if (!attachment) return

      // Remove from UI immediately
      updatePendingAttachments((prev) => prev.filter((a) => a.id !== attachmentId))

      // If it was successfully uploaded, delete from server
      if (attachment.status === "uploaded" && !attachmentId.startsWith("temp_")) {
        try {
          await attachmentsApi.delete(workspaceId, attachmentId)
        } catch (err) {
          console.warn("Failed to delete attachment from server:", err)
        }
      }
    },
    [updatePendingAttachments, workspaceId]
  )

  const clear = useCallback(() => {
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
    setImageCount(0)
    imageCountRef.current = 0
  }, [])

  const restore = useCallback(
    (attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>) => {
      const restoredAttachments = attachments.map((a) => ({
        ...a,
        status: "uploaded" as const,
      }))
      pendingAttachmentsRef.current = restoredAttachments
      setPendingAttachments(restoredAttachments)
      // Count images for proper numbering
      const restoredImageCount = attachments.filter((a) => a.mimeType.startsWith("image/")).length
      setImageCount(restoredImageCount)
      imageCountRef.current = restoredImageCount
    },
    []
  )

  const uploadedIds = pendingAttachments
    .filter((a) => a.status === "uploaded" && !a.id.startsWith("temp_"))
    .map((a) => a.id)

  const isUploading = pendingAttachments.some((a) => a.status === "uploading")
  const hasFailed = pendingAttachments.some((a) => a.status === "error")

  return {
    pendingAttachments,
    getPendingAttachmentsSnapshot,
    fileInputRef,
    handleFileSelect,
    uploadFile,
    removeAttachment,
    uploadedIds,
    isUploading,
    hasFailed,
    clear,
    restore,
    imageCount,
  }
}
