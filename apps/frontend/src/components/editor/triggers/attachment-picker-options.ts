import type { PendingAttachment } from "@/hooks/use-attachments"
import { buildImageIndexByAttachment } from "@/components/timeline/attachment-image-index"
import { rankMatches } from "@/lib/match-score"

/**
 * A row in the `/attachment` picker: one of the composer's tray attachments, or
 * the entry that opens the device file picker and inserts what comes back.
 */
export type AttachmentPickerOption =
  | {
      kind: "attachment"
      attachment: PendingAttachment
      /** "Image #N" ordinal, from the single owner of that rule. */
      imageIndex: number | null
    }
  | { kind: "upload" }

export function attachmentPickerOptionKey(option: AttachmentPickerOption): string {
  return option.kind === "upload" ? "upload" : option.attachment.id
}

/**
 * Tray rows for the picker: only attachments that can actually be referenced
 * (uploaded, real id), each carrying the ordinal a tray drag would stamp.
 */
export function buildAttachmentPickerOptions(attachments: readonly PendingAttachment[]): AttachmentPickerOption[] {
  const imageIndexes = buildImageIndexByAttachment(attachments)
  return attachments
    .filter((attachment) => attachment.status === "uploaded" && !attachment.id.startsWith("temp_"))
    .map((attachment) => ({
      kind: "attachment" as const,
      attachment,
      imageIndex: imageIndexes.get(attachment) ?? null,
    }))
}

/**
 * Rank tray rows by the typed filename filter (the same matcher the slash
 * palette uses). The upload entry is not ranked — it stays last so a fresh file
 * is always one selection away, however the filter narrows the tray.
 */
export function filterAttachmentPickerOptions(
  options: readonly AttachmentPickerOption[],
  query: string,
  includeUpload: boolean
): AttachmentPickerOption[] {
  const attachments = options.filter((option) => option.kind === "attachment")
  const ranked = rankMatches(attachments, query.trim(), (option) => ({
    labels: [option.kind === "attachment" ? option.attachment.filename : ""],
  }))
  return includeUpload ? [...ranked, { kind: "upload" }] : ranked
}
