import { join } from "node:path"

const UNSAFE_SEGMENT_CHARS = /[\\/:*?"<>|]/g

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(UNSAFE_SEGMENT_CHARS, "_").replace(/^\.+$/, "_").slice(0, 180)
  return cleaned || fallback
}

/** One downloaded attachment's filename, stripped of path separators and Windows-hostile characters. */
export function safeAttachmentFilename(filename: string): string {
  return safeSegment(filename, "attachment")
}

/**
 * A downloaded attachment lands in a per-attachment-id subdirectory: filenames
 * are not unique (the same `image.png` pasted into two messages, or one file
 * carried by both the source and a context message), so a flat directory
 * silently clobbers the earlier download. The leaf keeps the original filename
 * so a re-upload round-trips the name and extension unchanged.
 */
export function attachmentLocalPath(dir: string, attachmentId: string, filename: string): string {
  return join(dir, safeSegment(attachmentId, "attachment"), safeAttachmentFilename(filename))
}
