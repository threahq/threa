/**
 * Canonical pointer-URL formats used inside the markdown wire format.
 *
 * Three custom protocols ride on top of regular markdown link syntax:
 *
 *   - `quote:streamId/messageId/authorId/actorType` — the attribution
 *     link inside a `quoteReply` block. `authorId`/`actorType` are
 *     optional for backward compat with messages serialized before
 *     denormalised author metadata was added.
 *   - `shared-message:streamId/messageId` — the inline pointer link a
 *     `sharedMessage` block serialises to. Two segments only.
 *   - `attachment:attachmentId` — the inline reference an
 *     `attachmentReference` node serialises to (metadata rides on the
 *     link title; see `attachment-markdown.ts`).
 *   - `memo:memoId` — the pointer link a `memoEmbed` block serialises
 *     to. Single segment; the memo card body is hydrated at read time.
 *
 * Centralising the build/parse helpers here keeps the format in one
 * place: the markdown serializer, the markdown parser, and the
 * react-markdown pointer-detection in the timeline all agree by
 * construction.
 */

export interface QuoteHref {
  streamId: string
  messageId: string
  /** Empty string when the message was serialized pre-denormalisation. */
  authorId: string
  /** Defaults to `"user"` when omitted, matching the legacy schema. */
  actorType: string
}

export function buildQuoteHref(params: QuoteHref): string {
  // Emit the legacy two-segment form when authorId is empty, otherwise the
  // four-segment string with `//user` in the middle wouldn't match the
  // parser's `[\w-]+` segment regex on roundtrip.
  if (!params.authorId) {
    return `quote:${params.streamId}/${params.messageId}`
  }
  return `quote:${params.streamId}/${params.messageId}/${params.authorId}/${params.actorType}`
}

export function parseQuoteHref(href: string): QuoteHref | null {
  if (!href.startsWith("quote:")) return null
  const parts = href.slice("quote:".length).split("/")
  if (parts.length < 2) return null
  return {
    streamId: parts[0],
    messageId: parts[1],
    authorId: parts[2] ?? "",
    actorType: parts[3] ?? "user",
  }
}

export interface SharedMessageHref {
  streamId: string
  messageId: string
}

export function buildSharedMessageHref(params: SharedMessageHref): string {
  return `shared-message:${params.streamId}/${params.messageId}`
}

export function parseSharedMessageHref(href: string): SharedMessageHref | null {
  if (!href.startsWith("shared-message:")) return null
  const parts = href.slice("shared-message:".length).split("/")
  if (parts.length < 2) return null
  return { streamId: parts[0], messageId: parts[1] }
}

export interface MemoHref {
  memoId: string
}

export function buildMemoHref(params: MemoHref): string {
  return `memo:${params.memoId}`
}

export function parseMemoHref(href: string): MemoHref | null {
  if (!href.startsWith("memo:")) return null
  const memoId = href.slice("memo:".length)
  // Canonical ids are a single `[\w-]+` segment (matches the markdown link
  // pattern). Reject anything with a path/query/fragment suffix so values like
  // `memo:memo_123/extra` don't slip through as a valid pointer.
  if (!/^[\w-]+$/.test(memoId)) return null
  return { memoId }
}
