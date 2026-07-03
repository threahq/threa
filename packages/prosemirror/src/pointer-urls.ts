/**
 * Canonical pointer-URL formats used inside the markdown wire format.
 *
 * Three custom protocols ride on top of regular markdown link syntax:
 *
 *   - `quote:streamId/messageId/authorId/actorType` — the attribution
 *     link inside a `quoteReply` block. `authorId`/`actorType` are
 *     optional for backward compat with messages serialized before
 *     denormalised author metadata was added.
 *   - `shared-message:streamId/messageId[/conversationId]` — the inline
 *     pointer link a `sharedMessage` block serialises to. The optional third
 *     segment is the conversation the message was shared from; when present the
 *     card's back-link reopens the source in that conversation's side panel
 *     instead of its home-stream permalink. Omitted for in-stream shares (and
 *     for pointers serialized before conversation-awareness landed), so a
 *     two-segment link stays valid.
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

import {
  actorTypeFromMentionId,
  isResolvedChannelLinkId,
  MENTION_BROADCAST_CHANNEL,
  MENTION_BROADCAST_HERE,
} from "@threa/types"

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
  /**
   * The conversation the message was shared from, when the share originated on
   * a conversation surface (board card / conversation panel). Drives the card's
   * conversation-panel back-link; absent for in-stream shares and legacy
   * two-segment pointers.
   */
  conversationId?: string
}

export function buildSharedMessageHref(params: SharedMessageHref): string {
  // Emit the legacy two-segment form when there's no conversation origin so
  // older readers keep parsing it and the wire form stays stable for the common
  // in-stream case; append the third segment only when it carries information.
  if (!params.conversationId) {
    return `shared-message:${params.streamId}/${params.messageId}`
  }
  return `shared-message:${params.streamId}/${params.messageId}/${params.conversationId}`
}

export function parseSharedMessageHref(href: string): SharedMessageHref | null {
  if (!href.startsWith("shared-message:")) return null
  const parts = href.slice("shared-message:".length).split("/")
  // Exactly the 2-segment (legacy / in-stream) or 3-segment (conversation
  // origin) shapes `buildSharedMessageHref` emits — reject anything longer so a
  // malformed href can't silently drop trailing data, matching the strictness
  // of the regex-anchored `parseSharedMessageLine` in markdown.ts.
  if (parts.length < 2 || parts.length > 3) return null
  return { streamId: parts[0], messageId: parts[1], conversationId: parts[2] || undefined }
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

export interface GiphyHref {
  giphyUrl: string
  /** Intrinsic pixel size of the rendition, when known, so the renderer can
   *  reserve an aspect-ratio box before the GIF loads. */
  width?: number
  height?: number
}

/**
 * `giphy:<encoded CDN url>[?w=<n>&h=<n>]` — the inline pointer a `giphyEmbed`
 * node serialises to. The URL is percent-encoded (parens included) so it can't
 * contain a `)` that would truncate the surrounding markdown link, and the
 * cached title rides on the link text. Intrinsic dimensions ride as a trailing
 * `?w=&h=` query: `encodeURIComponent` escapes `?`/`&`/`=`, so the encoded URL
 * can never contain those literally and the suffix is unambiguous on parse.
 *
 * Unlike attachments — whose metadata rides the markdown link *title* slot
 * (`[text](attachment:id "threa-attachment:...")`, see `attachment-markdown.ts`)
 * via a dedicated regex group — a `giphy:` link is detected inside the generic
 * link branch, which has no title capture. Keeping the dimensions on the
 * pseudo-URI that `parseGiphyHref` already owns is the cohesive fit here.
 */
export function buildGiphyHref(params: GiphyHref): string {
  const encoded = encodeURIComponent(params.giphyUrl).replace(/\(/g, "%28").replace(/\)/g, "%29")
  if (isPositiveInt(params.width) && isPositiveInt(params.height)) {
    return `giphy:${encoded}?w=${params.width}&h=${params.height}`
  }
  return `giphy:${encoded}`
}

export function parseGiphyHref(href: string): GiphyHref | null {
  if (!href.startsWith("giphy:")) return null
  const body = href.slice("giphy:".length)
  // The encoded CDN url can't contain a literal `?` (encodeURIComponent escapes
  // it), so the first `?` cleanly separates the url from the dimension query.
  const queryIndex = body.indexOf("?")
  const encodedUrl = queryIndex >= 0 ? body.slice(0, queryIndex) : body
  let giphyUrl: string
  try {
    giphyUrl = decodeURIComponent(encodedUrl)
  } catch {
    return null
  }
  // Only ever point at Giphy's own CDN — the embed renders an <img> from this
  // URL, so an arbitrary origin here would be an open image-embed/SSRF surface.
  let parsed: URL
  try {
    parsed = new URL(giphyUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:") return null
  if (parsed.hostname !== "giphy.com" && !parsed.hostname.endsWith(".giphy.com")) return null

  const dims = queryIndex >= 0 ? parseGiphyDimensions(body.slice(queryIndex + 1)) : undefined
  return dims ? { giphyUrl, ...dims } : { giphyUrl }
}

export type MentionPointerType = "user" | "persona" | "bot" | "broadcast"

export interface MentionHrefPointer {
  kind: "mention"
  mentionType: MentionPointerType
  /** A `usr_`/`persona_`/`bot_` actor id, or a `broadcast:here`/`broadcast:channel` sentinel. */
  id: string
}

export interface ChannelHrefPointer {
  kind: "channel"
  /** A `stream_` id. */
  id: string
}

export type ActorHrefPointer = MentionHrefPointer | ChannelHrefPointer

const MENTION_POINTER_SCHEMES = ["user", "persona", "bot"] as const

/**
 * Decode a mention/channel pointer link href — `user:usr_x`, `persona:persona_x`,
 * `bot:bot_x`, `broadcast:here`/`broadcast:channel`, `channel:stream_x` — into its
 * kind + actor/stream id (INV-64), or null when the href isn't one of these
 * reserved schemes. Shared by the markdown parser (`parseMarkdown`) and the
 * react-markdown renderer so the wire format and the rendered chip agree by
 * construction.
 */
export function parseMentionPointerHref(href: string): ActorHrefPointer | null {
  // The id must carry the authoritative prefix for its scheme (INV-64, INV-2):
  // `channel:` → `stream_`, `user:` → `usr_`, etc. A mismatched or prefixless id
  // (`channel:not_stream`, `user:persona_x`) is rejected, not decoded as resolved.
  if (href.startsWith("channel:")) {
    const id = href.slice("channel:".length)
    return isResolvedChannelLinkId(id) ? { kind: "channel", id } : null
  }
  if (href === MENTION_BROADCAST_HERE || href === MENTION_BROADCAST_CHANNEL) {
    return { kind: "mention", mentionType: "broadcast", id: href }
  }
  for (const scheme of MENTION_POINTER_SCHEMES) {
    const prefix = `${scheme}:`
    if (href.startsWith(prefix)) {
      const id = href.slice(prefix.length)
      return actorTypeFromMentionId(id) === scheme ? { kind: "mention", mentionType: scheme, id } : null
    }
  }
  return null
}

function isPositiveInt(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/** Parse the `w=<n>&h=<n>` dimension suffix; returns undefined unless both are
 *  present as positive integers, so a malformed suffix degrades to "no dims". */
function parseGiphyDimensions(query: string): { width: number; height: number } | undefined {
  const params = new URLSearchParams(query)
  const width = Number(params.get("w"))
  const height = Number(params.get("h"))
  if (!isPositiveInt(width) || !isPositiveInt(height)) return undefined
  return { width, height }
}
