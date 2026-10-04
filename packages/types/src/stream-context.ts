// "In this stream" wire contract. The backend serves rows out of the
// `stream_context_items` projection; the client derives the same rows locally
// for sealed streams and reconciles the two sets by `key`, so the literals and
// the key derivation live here rather than in either app (INV-33).

import type { GitHubPrPreviewData } from "./domain"
import type { FollowUpStatus, LinkPreviewContentType, LinkPreviewStatus, RichLinkPreviewType } from "./constants"

export const CONTEXT_CATEGORIES = [
  "pull_request",
  "link",
  "media",
  "file",
  "memo",
  "delegation",
  "follow_up",
  "thread",
] as const
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number]

/**
 * Categories a message body owns, i.e. exactly what a message's context-row
 * derivation rebuilds. An edit refresh must not touch the other categories —
 * memo, delegation and thread landmarks are anchored on a message but written by
 * other paths and nothing re-creates them.
 */
export const MESSAGE_BODY_CONTEXT_CATEGORIES = ["pull_request", "link", "media", "file"] as const

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

export interface GitHubPullRequestRef {
  owner: string
  repo: string
  number: number
  /** `https://github.com/{owner}/{repo}/pull/{number}` — stable under the backend's URL normalizer. */
  url: string
}

const GITHUB_PULL_REQUEST_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?=[/?#]|$)/i

/**
 * The pull request a URL points into — the PR page itself or any view under it
 * (`/files`, `/commits`, `#issuecomment-…`). Shorthand refs (`#12`,
 * `owner/repo#12`) are deliberately not PR refs: `#12` names no repo, `#` is
 * the channel-link sigil, and GitHub shares the number space between issues
 * and PRs, so the shorthand alone cannot say which one it is.
 */
export function parseGitHubPullRequestUrl(url: string): GitHubPullRequestRef | null {
  const match = GITHUB_PULL_REQUEST_URL.exec(url)
  if (!match) return null
  const [, owner, repo, rawNumber] = match
  const number = Number.parseInt(rawNumber!, 10)
  if (number <= 0) return null
  return { owner: owner!, repo: repo!, number, url: `https://github.com/${owner}/${repo}/pull/${number}` }
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

/**
 * The ref is parsed from the message; `title` and `state` are joined live from
 * the PR's `link_previews` row and stay null until that preview lands.
 */
export interface StreamContextPullRequestDetail {
  url: string
  owner: string
  repo: string
  number: number
  title: string | null
  state: GitHubPrPreviewData["state"] | null
  previewStatus: LinkPreviewStatus | null
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
  | StreamContextPullRequestDetail
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
