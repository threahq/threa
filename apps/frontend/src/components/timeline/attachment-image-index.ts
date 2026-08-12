import type { PendingAttachment } from "@/hooks/use-attachments"

/** Attachments that bind to the message on send: real id, upload not failed. */
export function isMaterializableAttachment(attachment: PendingAttachment): boolean {
  return attachment.status !== "error" && !attachment.id.startsWith("temp_")
}

/**
 * "Image #N" is an identity, not a position, so the ordinal has one owner: the
 * nth image among the attachments that will materialize, 1-based. A tray drag
 * stamps it at insert and send re-derives the same number here, so a reference
 * never appears to renumber.
 */
export function buildImageIndexByAttachment(attachments: readonly PendingAttachment[]): Map<PendingAttachment, number> {
  const indexes = new Map<PendingAttachment, number>()
  let nextIndex = 1
  for (const attachment of attachments) {
    if (!isMaterializableAttachment(attachment)) continue
    if (attachment.mimeType.startsWith("image/")) indexes.set(attachment, nextIndex++)
  }
  return indexes
}
