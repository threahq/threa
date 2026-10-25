import type { Editor } from "@tiptap/core"
import type { UploadResult } from "@/hooks/use-attachments"
import type { AttachmentReferenceAttrs } from "./attachment-reference-extension"

interface InsertFilesOptions {
  /** False once the editor no longer owns the uploads it started, so a late result never lands in the wrong document. */
  isStillTargeting?: () => boolean
  /** Receives the placeholder ids once they are in the document. */
  onPlaceholdersInserted?: (tempIds: string[]) => void
}

/**
 * Inserts a placeholder attachment reference per file at the selection, then
 * settles each one to its uploaded (or failed) attachment as uploads resolve.
 */
export function insertFilesIntoEditor(
  editor: Editor,
  files: File[],
  uploadFile: (file: File) => Promise<UploadResult>,
  { isStillTargeting = () => true, onPlaceholdersInserted }: InsertFilesOptions = {}
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
    return { file, tempId, isImage: file.type.startsWith("image/"), attrs }
  })

  // A picked batch must reach a controlled editor as one document update;
  // intermediate renders can otherwise overwrite one placeholder while the
  // near-simultaneous reservations settle.
  if (!editor.commands.insertAttachmentReferences(insertions.map(({ attrs }) => attrs))) return false
  onPlaceholdersInserted?.(insertions.map(({ tempId }) => tempId))

  const targets = () => !editor.isDestroyed && isStillTargeting()
  for (const { file, tempId, isImage } of insertions) {
    void (async () => {
      try {
        const result = await uploadFile(file)
        if (!targets()) return
        // uploadFile resolves once the id is RESERVED — the bytes may still be
        // streaming in the background. The node is a reference marker, so it
        // settles to "uploaded" here (live transfer state renders on the chip
        // row, and stored content never persists "uploading" — see
        // materializePendingAttachmentReferences).
        editor.commands.updateAttachmentReference(tempId, {
          id: result.attachment.id,
          status: result.attachment.status === "error" ? "error" : "uploaded",
          imageIndex: isImage ? result.imageIndex : null,
          error: result.attachment.error || null,
        })
      } catch (err) {
        if (!targets()) return
        editor.commands.updateAttachmentReference(tempId, {
          status: "error",
          error: err instanceof Error ? err.message : "Upload failed",
        })
      }
    })()
  }

  return true
}
