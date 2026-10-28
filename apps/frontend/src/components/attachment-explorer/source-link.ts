import type { MouseEvent } from "react"
import type { AttachmentSearchItem } from "@/api/attachments"
import { requestBlockFocus } from "@/lib/docs/block-focus"

export interface AttachmentSource {
  kind: "message" | "doc"
  to: string
  /** Lands the opened doc on the block embedding the file; a modified click opens elsewhere and leaves it alone. */
  onFollow?: (event: MouseEvent) => void
}

/** Where a file came from: the message carrying it, or the doc block embedding it. */
export function attachmentSource(workspaceId: string, item: AttachmentSearchItem): AttachmentSource | null {
  const { streamId, messageId, docBlockId } = item
  if (!streamId) return null
  if (messageId) return { kind: "message", to: `/w/${workspaceId}/s/${streamId}?m=${messageId}` }
  if (docBlockId) {
    return {
      kind: "doc",
      to: `/w/${workspaceId}/s/${streamId}`,
      onFollow: (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        requestBlockFocus(streamId, docBlockId)
      },
    }
  }
  return null
}
