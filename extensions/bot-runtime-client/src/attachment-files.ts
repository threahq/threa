import { join } from "node:path"

const UNSAFE_SEGMENT_CHARS = /[\\/:*?"<>|]/g
/** ext4/APFS cap a path component at 255 BYTES, not characters — a 180-char CJK name is 540. */
const MAX_SEGMENT_BYTES = 180
const MAX_EXTENSION_BYTES = 16
const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).length
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  let out = ""
  let bytes = 0
  for (const char of value) {
    const size = byteLength(char)
    if (bytes + size > maxBytes) break
    out += char
    bytes += size
  }
  return out
}

function clean(value: string): string {
  return value.replace(UNSAFE_SEGMENT_CHARS, "_").replace(/^\.+$/, "_")
}

function safeSegment(value: string, fallback: string): string {
  return truncateToBytes(clean(value), MAX_SEGMENT_BYTES) || fallback
}

/**
 * One downloaded attachment's filename, stripped of path separators and
 * Windows-hostile characters. An over-long name loses stem, never extension:
 * the agent (and a `THREA_ATTACH:` re-upload) picks the mime type off the
 * suffix, so a truncated `.png` would land as `application/octet-stream`.
 */
export function safeAttachmentFilename(filename: string): string {
  const cleaned = clean(filename)
  const dot = cleaned.lastIndexOf(".")
  const extension = dot > 0 ? cleaned.slice(dot) : ""
  if (!extension || byteLength(extension) > MAX_EXTENSION_BYTES) {
    return truncateToBytes(cleaned, MAX_SEGMENT_BYTES) || "attachment"
  }
  const stem = truncateToBytes(cleaned.slice(0, dot), MAX_SEGMENT_BYTES - byteLength(extension))
  return `${stem}${extension}`
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
