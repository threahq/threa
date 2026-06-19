/**
 * Pure helpers that walk a ProseMirror JSON tree and pull out structural
 * references (attachment IDs, share pointers, etc.) for downstream access
 * checks and projection writes.
 */

import type { JSONContent } from "@threa/types"

/**
 * Slugs come from the node attrs, so this works for any script the slug is
 * written in — no ASCII pattern matching over serialized markdown (INV-54).
 * Lowercased to match how mention targets are stored and looked up.
 */
export function collectMentionSlugs(content: JSONContent): string[] {
  const slugs: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const slug = node.attrs?.slug
      if (typeof slug === "string" && slug.length > 0) {
        slugs.push(slug.toLowerCase())
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return slugs
}

/**
 * Message IDs this document explicitly quote-replies to, read from the
 * `quoteReply` node attrs (so it works for any language/script — no markdown
 * pattern matching, INV-54). Dedupes preserving first-seen order.
 */
export function collectQuoteReplyMessageIds(content: JSONContent): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "quoteReply") {
      const messageId = node.attrs?.messageId
      if (typeof messageId === "string" && messageId.length > 0 && !seen.has(messageId)) {
        seen.add(messageId)
        ordered.push(messageId)
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return ordered
}

/**
 * Skips `uploading`/`error` nodes to mirror the markdown serializer's omission
 * rule (markdown.ts), and dedupes preserving first-seen order.
 */
export function collectAttachmentReferenceIds(content: JSONContent): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "attachmentReference") {
      const status = node.attrs?.status
      const id = node.attrs?.id
      if (typeof id === "string" && id.length > 0 && status !== "uploading" && status !== "error") {
        if (!seen.has(id)) {
          seen.add(id)
          ordered.push(id)
        }
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return ordered
}
