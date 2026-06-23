import type { AttachmentCategory, KnowledgeType } from "@threa/types"

/**
 * The buckets the "In this stream" panel groups derived context into. `"all"`
 * is a virtual category (the interleaved recency feed), not a member of any
 * single item.
 */
export type ContextCategory = "link" | "media" | "file" | "memo" | "thread"

export const CONTEXT_CATEGORIES: ContextCategory[] = ["link", "media", "file", "memo", "thread"]

interface ContextItemBase {
  /** Stable React key, also the dedup identity within its category. */
  key: string
  category: ContextCategory
  /** ISO timestamp used for recency ordering (newest first). */
  createdAt: string
  /** The message this item was derived from, for "jump to origin". */
  sourceMessageId: string | null
  /** First line of the source message, markdown-stripped (INV-60). */
  snippet: string
}

export interface LinkContextItem extends ContextItemBase {
  category: "link"
  url: string
  title: string | null
  siteName: string | null
  faviconUrl: string | null
  imageUrl: string | null
  /** Drives the small type badge: GitHub PR/issue, Linear, or none. */
  previewKind: "github" | "linear" | "generic"
  /** A short label for the preview kind ("PR", "Issue", "Linear", …) or null. */
  badge: string | null
  /** How many loaded messages referenced this URL. */
  refCount: number
}

export interface MediaContextItem extends ContextItemBase {
  category: "media"
  mediaKind: "image" | "video" | "gif"
  /** Uploaded attachment id; null for an inline Giphy reference. */
  attachmentId: string | null
  /** Giphy CDN url; null for an uploaded attachment. */
  giphyUrl: string | null
  filename: string
  width?: number
  height?: number
}

export interface FileContextItem extends ContextItemBase {
  category: "file"
  attachmentId: string
  fileCategory: AttachmentCategory
  filename: string
  sizeBytes: number
}

export interface MemoContextItem extends ContextItemBase {
  category: "memo"
  memoId: string
  title: string
  knowledgeType: KnowledgeType
  sourceMessageIds: string[]
}

export interface ThreadContextItem extends ContextItemBase {
  category: "thread"
  /** The thread's stream id — open it with `getPanelUrl(threadId)`. */
  threadId: string
  replyCount: number
  lastReplyPreview: string | null
}

export type ContextItem = LinkContextItem | MediaContextItem | FileContextItem | MemoContextItem | ThreadContextItem

export interface DerivedStreamContext {
  /** All items, newest first. */
  items: ContextItem[]
  /** Per-category counts for the filter chips. */
  counts: Record<ContextCategory, number>
  total: number
}
