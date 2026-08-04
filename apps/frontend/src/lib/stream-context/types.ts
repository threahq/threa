import type { AttachmentCategory, DelegationStatus, FollowUpStatus, KnowledgeType } from "@threa/types"

/**
 * The buckets the "In this stream" panel groups derived context into. `"all"`
 * is a virtual category (the interleaved recency feed), not a member of any
 * single item.
 */
export type ContextCategory = "link" | "media" | "file" | "memo" | "delegation" | "follow_up" | "thread"

export const CONTEXT_CATEGORIES: ContextCategory[] = [
  "link",
  "media",
  "file",
  "memo",
  "delegation",
  "follow_up",
  "thread",
]

interface ContextItemBase {
  /** Stable React key, also the dedup identity within its category. */
  key: string
  category: ContextCategory
  /** ISO timestamp used for recency ordering (newest first). */
  createdAt: string
  /**
   * The deep-link target for "jump to origin": the source message's id, or —
   * for an artifact that lives in no message, like a delegation card — the id
   * of the event that anchors it. `?m=` resolves either (see
   * `matchesDeepLinkTarget`), so one field carries both shapes.
   */
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
  /** Drives the small type badge: GitHub PR/issue, Linear, an in-app Threa
   *  reference (shared message, channel, memo, conversation, task), or none. */
  previewKind: "github" | "linear" | "in-app" | "generic"
  /** A short label for the preview kind ("PR", "Issue", "Message", …) or null. */
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
  /** Raw mime type, kept so the gallery can decide previewability (pdf /
   *  markdown / html / text) via the canonical `is*Attachment` helpers — the
   *  coarse `fileCategory` collapses those distinctions. */
  mimeType: string
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

export interface DelegationContextItem extends ContextItemBase {
  category: "delegation"
  delegationId: string
  title: string
  /** Live status from the authoritative list endpoint, not the loaded window. */
  status: DelegationStatus
  claimedByLabel: string | null
  statusNote: string | null
  resultMessageId: string | null
}

export interface FollowUpContextItem extends ContextItemBase {
  category: "follow_up"
  followUpId: string
  note: string
  /** Live status from the authoritative outcomes read — there is no `fired` event. */
  status: FollowUpStatus
  /** ISO firing time; in the future while the follow-up is pending. */
  scheduledFor: string | null
}

export interface ThreadContextItem extends ContextItemBase {
  category: "thread"
  /** The thread's stream id — open it with `getPanelUrl(threadId)`. */
  threadId: string
  replyCount: number
  lastReplyPreview: string | null
}

export type ContextItem =
  | LinkContextItem
  | MediaContextItem
  | FileContextItem
  | MemoContextItem
  | DelegationContextItem
  | FollowUpContextItem
  | ThreadContextItem

export interface DerivedStreamContext {
  /** All items, newest first. */
  items: ContextItem[]
  /** Per-category counts for the filter chips. */
  counts: Record<ContextCategory, number>
  total: number
}
