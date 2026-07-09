import { useState, useCallback, useEffect, useRef, type ChangeEvent, type RefObject } from "react"
import { attachmentsApi } from "@/api"
import { encryptAttachmentBytes, rememberAttachmentRef } from "@/lib/crypto/attachment-crypto"
import { uploadGalleryType } from "@/components/gallery/upload-preview"

/** The placeholder name/mime the server forces for E2E ciphertext uploads. */
const E2E_CIPHERTEXT_FILENAME = "encrypted"
const E2E_CIPHERTEXT_MIME = "application/octet-stream"

/**
 * Object URL for the local bytes of a picked/pasted file the gallery can preview
 * (image, video, pdf, markdown, html, text — decided by the same
 * {@link uploadGalleryType} the timeline uses), so the composer can preview the
 * actual file before send. Reading from the local File means the preview is
 * available immediately (even mid-upload) and works for E2E streams where the
 * server only ever holds ciphertext. Best-effort: environments without
 * object-URL support (jsdom) get `undefined` and fall back to a plain chip.
 */
function createPreviewUrl(file: File): string | undefined {
  if (!uploadGalleryType({ mimeType: file.type, filename: file.name })) return undefined
  try {
    return URL.createObjectURL(file)
  } catch {
    return undefined
  }
}

function revokePreviewUrl(url: string | undefined): void {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch {
    // no-op — see createPreviewUrl
  }
}

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
  uploadPromise: Promise<void>
}

export interface PendingAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  status: "uploading" | "uploaded" | "error"
  error?: string
  /**
   * Local object URL for previewable files (image/video/pdf/markdown/html/text),
   * for the in-composer preview (thumbnail + lightbox). Undefined for
   * non-previewable files and for restored drafts, which carry no local bytes.
   * Revoked on remove/clear/unmount.
   */
  previewUrl?: string
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
  /**
   * Abort an in-flight upload, drop its chip, and best-effort delete the
   * server-side reservation. No-op for an attachment that isn't uploading.
   */
  cancelUpload: (id: string) => void
  /** IDs of reserved or uploaded attachments that can be sent with a message. */
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
  // Per-upload AbortControllers keyed by attachment id (both the temp id used
  // during reservation and the final server id after the reservation lands),
  // so a cancel click at either phase aborts the in-flight bytes upload.
  const uploadControllersRef = useRef(new Map<string, AbortController>())

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
    async (file: File, signal: AbortSignal): Promise<UploadedFacts> => {
      if (e2eEnabled) {
        const plaintext = new Uint8Array(await file.arrayBuffer())
        const { ciphertext, key, iv } = await encryptAttachmentBytes(plaintext)
        const filename = file.name
        const mimeType = file.type || E2E_CIPHERTEXT_MIME
        const reservation = await attachmentsApi.reserve(
          workspaceId,
          {
            filename,
            mimeType,
            sizeBytes: ciphertext.byteLength,
            e2e: true,
          },
          { signal }
        )
        const attachment = reservation.attachment
        if (!attachment?.id) throw new Error("Invalid response: missing attachment data")
        rememberAttachmentRef({ attachmentId: attachment.id, key, iv, filename, mimeType, sizeBytes: file.size })
        const cipherFile = new File([ciphertext], E2E_CIPHERTEXT_FILENAME, { type: E2E_CIPHERTEXT_MIME })
        return {
          id: attachment.id,
          filename,
          mimeType,
          sizeBytes: file.size,
          uploadPromise: attachmentsApi
            .upload(workspaceId, cipherFile, { e2e: true, attachmentId: attachment.id, signal })
            .then(() => undefined),
        }
      }
      const reservation = await attachmentsApi.reserve(
        workspaceId,
        {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        },
        { signal }
      )
      const attachment = reservation.attachment
      if (!attachment?.id) throw new Error("Invalid response: missing attachment data")
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        uploadPromise: attachmentsApi
          .upload(workspaceId, file, { attachmentId: attachment.id, signal })
          .then(() => undefined),
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
        const previewUrl = createPreviewUrl(file)
        const controller = new AbortController()
        uploadControllersRef.current.set(tempId, controller)

        updatePendingAttachments((prev) => [
          ...prev,
          {
            id: tempId,
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            status: "uploading",
            previewUrl,
          },
        ])

        try {
          const { uploadPromise, ...facts } = await uploadOne(file, controller.signal)

          // The id flips temp→server once the reservation lands; keep the
          // controller reachable under the new id so a cancel click during the
          // (potentially long) bytes-upload phase still aborts it.
          uploadControllersRef.current.set(facts.id, controller)
          uploadControllersRef.current.delete(tempId)

          updatePendingAttachments((prev) =>
            prev.map((a) => (a.id === tempId ? { ...facts, status: "uploading" as const, previewUrl } : a))
          )
          uploadPromise
            .then(() => {
              uploadControllersRef.current.delete(facts.id)
              updatePendingAttachments((prev) =>
                prev.map((a) => (a.id === facts.id ? { ...a, status: "uploaded" as const } : a))
              )
            })
            .catch((err) => {
              uploadControllersRef.current.delete(facts.id)
              // A user-initiated cancel removes the chip already; don't relabel
              // the dropped attachment as failed.
              if (controller.signal.aborted) return
              updatePendingAttachments((prev) =>
                prev.map((a) =>
                  a.id === facts.id
                    ? { ...a, status: "error" as const, error: err instanceof Error ? err.message : "Upload failed" }
                    : a
                )
              )
            })
        } catch (err) {
          uploadControllersRef.current.delete(tempId)
          if (controller.signal.aborted) {
            // Cancelled mid-reservation: drop the chip quietly.
            updatePendingAttachments((prev) => prev.filter((a) => a.id !== tempId))
            revokePreviewUrl(previewUrl)
            continue
          }
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

      // Assign the image index off the synchronous ref, not state, so back-to-back
      // uploads in one tick get distinct sequential indices.
      if (isImage) {
        assignedImageIndex = imageCountRef.current + 1
        imageCountRef.current = assignedImageIndex
        setImageCount(assignedImageIndex)
      }

      const previewUrl = createPreviewUrl(file)
      const controller = new AbortController()
      uploadControllersRef.current.set(tempId, controller)
      const pendingAttachment: PendingAttachment = {
        id: tempId,
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        status: "uploading",
        previewUrl,
      }

      updatePendingAttachments((prev) => [...prev, pendingAttachment])

      try {
        const { uploadPromise, ...facts } = await uploadOne(file, controller.signal)

        uploadControllersRef.current.set(facts.id, controller)
        uploadControllersRef.current.delete(tempId)

        const uploadedAttachment: PendingAttachment = {
          ...facts,
          status: "uploading",
          previewUrl,
        }

        updatePendingAttachments((prev) => prev.map((a) => (a.id === tempId ? uploadedAttachment : a)))
        uploadPromise
          .then(() => {
            uploadControllersRef.current.delete(facts.id)
            updatePendingAttachments((prev) =>
              prev.map((a) => (a.id === facts.id ? { ...a, status: "uploaded" as const } : a))
            )
          })
          .catch((err) => {
            uploadControllersRef.current.delete(facts.id)
            if (controller.signal.aborted) return
            updatePendingAttachments((prev) =>
              prev.map((a) =>
                a.id === facts.id
                  ? { ...a, status: "error" as const, error: err instanceof Error ? err.message : "Upload failed" }
                  : a
              )
            )
          })

        return {
          attachment: uploadedAttachment,
          imageIndex: assignedImageIndex,
          tempId,
        }
      } catch (err) {
        uploadControllersRef.current.delete(tempId)
        if (controller.signal.aborted) {
          updatePendingAttachments((prev) => prev.filter((a) => a.id !== tempId))
          revokePreviewUrl(previewUrl)
          return {
            attachment: { ...pendingAttachment, status: "error", error: "Cancelled" },
            imageIndex: assignedImageIndex,
            tempId,
          }
        }
        const errorAttachment: PendingAttachment = {
          ...pendingAttachment,
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        }

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

      // Abort any in-flight upload first so a lingering bytes fetch can't
      // resolve after the chip is gone and mutate state for a dropped id.
      uploadControllersRef.current.get(attachmentId)?.abort()
      uploadControllersRef.current.delete(attachmentId)

      revokePreviewUrl(attachment.previewUrl)
      updatePendingAttachments((prev) => prev.filter((a) => a.id !== attachmentId))

      // Clean up the server-side row for any real (non-temp) id — an uploaded
      // file, a reserved-but-not-yet-uploaded file, or a failed upload that
      // still holds a reservation. Temp ids never reached the server.
      if (!attachmentId.startsWith("temp_")) {
        try {
          await attachmentsApi.delete(workspaceId, attachmentId)
        } catch (err) {
          console.warn("Failed to delete attachment from server:", err)
        }
      }
    },
    [updatePendingAttachments, workspaceId]
  )

  // User-facing cancel: abort the in-flight fetch, drop the chip, and let
  // removeAttachment best-effort delete the reservation. Safe at both phases
  // (temp id mid-reservation, server id mid-bytes-upload) because the
  // controller is registered under whichever id the chip currently shows.
  const cancelUpload = useCallback(
    (id: string) => {
      const attachment = pendingAttachmentsRef.current.find((a) => a.id === id)
      if (!attachment || attachment.status !== "uploading") return
      void removeAttachment(id)
    },
    [removeAttachment]
  )

  const clear = useCallback(() => {
    for (const a of pendingAttachmentsRef.current) revokePreviewUrl(a.previewUrl)
    // Abort any uploads still in flight so they can't settle after a send.
    for (const controller of uploadControllersRef.current.values()) controller.abort()
    uploadControllersRef.current.clear()
    pendingAttachmentsRef.current = []
    setPendingAttachments([])
    setImageCount(0)
    imageCountRef.current = 0
  }, [])

  // Backstop for previews still live when the composer unmounts (navigating away
  // with a draft mid-upload) — the happy path revokes via clear() on send.
  useEffect(
    () => () => {
      for (const a of pendingAttachmentsRef.current) revokePreviewUrl(a.previewUrl)
    },
    []
  )

  const restore = useCallback(
    (attachments: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }>) => {
      // Carry over the local object URL for any attachment already in memory: a
      // draft re-hydrate (the debounced save that lands mid-session, or a
      // stash/restore pointer move) round-trips through this path, and without
      // the carry-over the fresh-upload preview would collapse to an icon the
      // instant the draft persisted. Preview persistence across an actual reload
      // is the reader's job (server thumbnail / E2E decrypt) — there are no local
      // bytes to carry then.
      const priorPreviewById = new Map(
        pendingAttachmentsRef.current.filter((a) => a.previewUrl).map((a) => [a.id, a.previewUrl])
      )
      const restoredIds = new Set(attachments.map((a) => a.id))
      for (const a of pendingAttachmentsRef.current) {
        if (a.previewUrl && !restoredIds.has(a.id)) revokePreviewUrl(a.previewUrl)
      }
      const restoredAttachments = attachments.map((a) => ({
        ...a,
        status: "uploaded" as const,
        previewUrl: priorPreviewById.get(a.id),
      }))
      pendingAttachmentsRef.current = restoredAttachments
      setPendingAttachments(restoredAttachments)
      const restoredImageCount = attachments.filter((a) => a.mimeType.startsWith("image/")).length
      setImageCount(restoredImageCount)
      imageCountRef.current = restoredImageCount
    },
    []
  )

  const uploadedIds = pendingAttachments
    .filter((a) => a.status !== "error" && !a.id.startsWith("temp_"))
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
    cancelUpload,
    uploadedIds,
    isUploading,
    hasFailed,
    clear,
    restore,
    imageCount,
  }
}
