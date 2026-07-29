// "In this stream" wire contract. The backend serves rows out of the
// `stream_context_items` projection; the client derives the same rows locally
// for sealed streams and reconciles the two sets by `key`, so the literals and
// the key derivation live here rather than in either app (INV-33).

import type { FollowUpStatus, LinkPreviewContentType, LinkPreviewStatus, RichLinkPreviewType } from "./constants"

export const CONTEXT_CATEGORIES = ["link", "media", "file", "memo", "delegation", "follow_up", "thread"] as const
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number]

/**
 * Categories a message body owns, i.e. exactly what a message's context-row
 * derivation rebuilds. An edit refresh must not touch the other categories —
 * memo, delegation and thread landmarks are anchored on a message but written by
 * other paths and nothing re-creates them.
 */
export const MESSAGE_BODY_CONTEXT_CATEGORIES = ["link", "media", "file"] as const

export const STREAM_CONTEXT_REF_KINDS = [
  "url",
  "attachment",
  "giphy",
  "memo",
  "delegation",
  "follow_up",
  "thread",
] as const
export type StreamContextRefKind = (typeof STREAM_CONTEXT_REF_KINDS)[number]

export const STREAM_CONTEXT_SCOPES = ["stream", "tree"] as const
export type StreamContextScope = (typeof STREAM_CONTEXT_SCOPES)[number]

/** Row identity, computed identically on both sides of the wire. */
export function streamContextItemKey(input: {
  category: ContextCategory
  refId: string
  sourceMessageId: string | null
}): string {
  return `${input.category}:${input.refId}:${input.sourceMessageId ?? ""}`
}

/** Joined live from `link_previews`; every field is null until the preview lands. */
export interface StreamContextLinkDetail {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  faviconUrl: string | null
  imageUrl: string | null
  /** `link_previews.preview_type` — the rich provider card, null for a plain page. */
  previewType: RichLinkPreviewType | null
  /** `link_previews.content_type` — website | pdf | image | in_app_*. */
  contentType: LinkPreviewContentType | null
  previewStatus: LinkPreviewStatus | null
}

/** Shared by `media` and `file`. Giphy rows carry no attachment, only the stored detail. */
export interface StreamContextAttachmentDetail {
  attachmentId: string | null
  filename: string | null
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  mediaKind: string | null
  giphyUrl: string | null
  giphyTitle: string | null
}

export interface StreamContextMemoDetail {
  title: string | null
  knowledgeType: string | null
}

export interface StreamContextDelegationDetail {
  title: string | null
  status: string | null
  claimedByLabel: string | null
  statusNote: string | null
  resultMessageId: string | null
}

/** Joined live from `agent_follow_ups`; the stored detail carries nothing status-shaped. */
export interface StreamContextFollowUpDetail {
  note: string
  status: FollowUpStatus
  scheduledFor: string | null
}

export interface StreamContextThreadDetail {
  name: string | null
  replyCount: number
  lastReplyAt: string | null
  anchorEventId: string | null
}

export type StreamContextItemDetail =
  | StreamContextLinkDetail
  | StreamContextAttachmentDetail
  | StreamContextMemoDetail
  | StreamContextDelegationDetail
  | StreamContextFollowUpDetail
  | StreamContextThreadDetail

export interface StreamContextItem {
  /** `${category}:${refId}:${sourceMessageId ?? ""}` — see {@link streamContextItemKey}. */
  key: string
  category: ContextCategory
  refKind: StreamContextRefKind
  refId: string
  groupKey: string
  /** The stream the artifact lives in — a thread of the root under `scope=tree`. */
  streamId: string
  sourceMessageId: string | null
  /**
   * The stream event to deep-link when the artifact has no source message —
   * a delegation's `delegation:created` card, or a thread anchored on a card.
   * `?m=` accepts either id (see `matchesDeepLinkTarget`), so a row jumps with
   * whichever of the two it has.
   */
  anchorEventId: string | null
  authorId: string | null
  /** ISO — the source message's `created_at`. */
  occurredAt: string
  /** bigint as string. */
  sequence: string | null
  snippet: string
  /** Occurrences this collapsed row stands for; 1 in the occurrences endpoint. */
  occurrenceCount: number
  detail: StreamContextItemDetail
}

export interface ListStreamContextResponse {
  items: StreamContextItem[]
  /** Whole-scope counts; only the first page carries them. */
  counts: Record<ContextCategory, number> | null
  nextCursor: string | null
  /** `client` = sealed stream, the panel derives locally instead. */
  mode: "index" | "client"
}

export interface ListStreamContextOccurrencesResponse {
  items: StreamContextItem[]
  nextCursor: string | null
}
