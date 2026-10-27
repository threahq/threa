import type { Editor } from "@tiptap/core"
import type { UploadResult } from "@/hooks/use-attachments"
import { isImageAttachment, isVideoAttachment } from "@/lib/attachment-kind"
import type { AttachmentDisplay, AttachmentReferenceAttrs } from "./attachment-reference-extension"

/** Pasted images arrive as `image.png`; number them after the images already in the draft. */
export function namePastedImages(files: File[], existingImageCount: number): File[] {
  let pastedImages = 0
  return files.map((file) => {
    if (!file.type.startsWith("image/")) return file
    pastedImages++
    const ext = file.name.split(".").pop() || "png"
    return new File([file], `pasted-image-${existingImageCount + pastedImages}.${ext}`, { type: file.type })
  })
}

interface InsertFilesOptions {
  /** False once the editor no longer owns the uploads it started, so a late result never lands in the wrong document. */
  isStillTargeting?: () => boolean
  /** Receives the placeholder ids once they are in the document. */
  onPlaceholdersInserted?: (tempIds: string[]) => void
  /** Takes over a failed upload's placeholder; without it the placeholder settles to an error chip. */
  onUploadFailed?: (tempId: string, error: unknown) => void
  /** How images and videos land; unset, they land as chips. */
  mediaDisplay?: AttachmentDisplay
}

/**
 * Inserts a placeholder attachment reference per file at the selection, then
 * settles each one to its uploaded (or failed) attachment as uploads resolve.
 */
export function insertFilesIntoEditor(
  editor: Editor,
  files: File[],
  uploadFile: (file: File) => Promise<UploadResult>,
  { isStillTargeting = () => true, onPlaceholdersInserted, onUploadFailed, mediaDisplay }: InsertFilesOptions = {}
): boolean {
  if (editor.isDestroyed || files.length === 0) return false
  const batchId = `${Date.now()}_${Math.random().toString(36).slice(2)}`
  const insertions = files.map((file, index) => {
    const tempId = `temp_${batchId}_${index}`
    const attrs: AttachmentReferenceAttrs = {
      id: tempId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      status: "uploading",
      imageIndex: null,
      error: null,
    }
    if (mediaDisplay && (isImageAttachment(attrs) || isVideoAttachment(attrs))) attrs.display = mediaDisplay
    return { file, tempId, isImage: file.type.startsWith("image/"), attrs }
  })

  // A picked batch must reach a controlled editor as one document update;
  // intermediate renders can otherwise overwrite one placeholder while the
  // near-simultaneous reservations settle.
  if (!editor.commands.insertAttachmentReferences(insertions.map(({ attrs }) => attrs))) return false
  onPlaceholdersInserted?.(insertions.map(({ tempId }) => tempId))

  const stillTargets = () => !editor.isDestroyed && isStillTargeting()
  for (const { file, tempId, isImage } of insertions) {
    void (async () => {
      try {
        const result = await uploadFile(file)
        if (!stillTargets()) return
        if (result.attachment.status === "error" && onUploadFailed) {
          return onUploadFailed(tempId, new Error(result.attachment.error || "Upload failed"))
        }
        // uploadFile resolves once the id is RESERVED — the bytes may still be
        // streaming in the background. The node is a reference marker, so it
        // settles to "uploaded" here; live transfer state is the uploader's,
        // not the node's.
        editor.commands.updateAttachmentReference(tempId, {
          id: result.attachment.id,
          status: result.attachment.status === "error" ? "error" : "uploaded",
          imageIndex: isImage ? result.imageIndex : null,
          error: result.attachment.error || null,
        })
      } catch (err) {
        if (!stillTargets()) return
        if (onUploadFailed) return onUploadFailed(tempId, err)
        editor.commands.updateAttachmentReference(tempId, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        })
      }
    })()
  }

  return true
}
