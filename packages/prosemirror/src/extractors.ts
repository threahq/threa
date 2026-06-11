/**
 * Pure helpers that walk a ProseMirror JSON tree and pull out structural
 * references (attachment IDs, share pointers, etc.) for downstream access
 * checks and projection writes.
 */

import type { JSONContent } from "@threa/types"

/**
 * Collect attachment IDs referenced inline in the document via
 * `attachmentReference` nodes (the `attachment:<id>` pointer URL form).
 *
 * Filters out nodes whose `status` is `uploading` or `error` to mirror the
 * markdown serializer's omission rule (see markdown.ts: skip uploading/error).
 * Deduplicates while preserving first-seen order so callers can pass the
 * result straight to access-check / projection code that already accepts
 * an ordered ID list.
 */
/**
 * Collect mention slugs from `mention` nodes, in document order, keeping
 * duplicate occurrences. Slugs come from the node attrs the editor (or
 * `parseMarkdown`) produced, so this works for any script the slug is
 * written in — no ASCII pattern matching over serialized markdown (INV-54).
 *
 * Slugs are lowercased to match how mention targets are stored and looked
 * up. Callers that need a unique set dedupe on their side.
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
