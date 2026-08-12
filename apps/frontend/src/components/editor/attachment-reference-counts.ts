import type { JSONContent } from "@threa/types"

/**
 * How many times each attachment is referenced in a draft. Derived from the
 * document on every read — the tray is an inventory and a chip's referenced
 * state is a view of the message, never stored alongside the attachment.
 */
export function countAttachmentReferences(content: JSONContent | null | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: JSONContent) => {
    if (node.type === "attachmentReference" && typeof node.attrs?.id === "string") {
      counts.set(node.attrs.id, (counts.get(node.attrs.id) ?? 0) + 1)
    }
    for (const child of node.content ?? []) visit(child)
  }
  if (content) visit(content)
  return counts
}
