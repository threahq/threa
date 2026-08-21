/**
 * Canonical pointer-URL formats used inside the markdown wire format.
 *
 * Three custom protocols ride on top of regular markdown link syntax:
 *
 *   - `quote:streamId/messageId/authorId/actorType[?v=n&r=from-to]` — the
 *     attribution link inside a `quoteReply` block. `authorId`/`actorType` are
 *     optional for backward compat with messages serialized before
 *     denormalised author metadata was added; the `?v=`/`&r=` suffix pins the
 *     source revision and the quoted span (see `ReferencePin`).
 *   - `shared-message:streamId/messageId[/conversationId][?v=n&r=from-to]` — the inline
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
  type ContentRange,
  isResolvedChannelLinkId,
  MENTION_BROADCAST_CHANNEL,
  MENTION_BROADCAST_HERE,
} from "@threa/types"

/**
 * The pin a `quote:`/`shared-message:` href can carry as a `?v=<n>[&r=<from>-<to>]`
 * suffix: which revision of the source the reference points at, and which span of
 * that revision's content. Absent on legacy hrefs, which mean "current revision,
 * whole message".
 */
export interface ReferencePin {
  /** Source message revision; `null`/absent = unpinned. */
  version?: number | null
  /** Position span inside the pinned revision; `null`/absent = the whole message. */
  range?: ContentRange | null
}

export interface QuoteHref extends ReferencePin {
  streamId: string
  messageId: string
  /** Empty string when the message was serialized pre-denormalisation. */
  authorId: string
  /** Defaults to `"user"` when omitted, matching the legacy schema. */
  actorType: string
}

export function buildQuoteHref(params: QuoteHref): string {
  const query = buildReferenceQuery(params)
  // Emit the legacy two-segment form when authorId is empty, otherwise the
  // four-segment string with `//user` in the middle wouldn't match the
  // parser's `[\w-]+` segment regex on roundtrip.
  if (!params.authorId) {
    return `quote:${params.streamId}/${params.messageId}${query}`
  }
  return `quote:${params.streamId}/${params.messageId}/${params.authorId}/${params.actorType}${query}`
}

export function parseQuoteHref(href: string): QuoteHref | null {
  if (!href.startsWith("quote:")) return null
  const split = splitReferenceQuery(href.slice("quote:".length))
  if (!split) return null
  const parts = split.path.split("/")
  if (parts.length < 2) return null
  return {
    streamId: parts[0],
    messageId: parts[1],
    authorId: parts[2] ?? "",
    actorType: parts[3] ?? "user",
    version: split.pin.version,
    range: split.pin.range,
  }
}

export interface SharedMessageHref extends ReferencePin {
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
  const query = buildReferenceQuery(params)
  // Emit the legacy two-segment form when there's no conversation origin so
  // older readers keep parsing it and the wire form stays stable for the common
  // in-stream case; append the third segment only when it carries information.
  if (!params.conversationId) {
    return `shared-message:${params.streamId}/${params.messageId}${query}`
  }
  return `shared-message:${params.streamId}/${params.messageId}/${params.conversationId}${query}`
}

export function parseSharedMessageHref(href: string): SharedMessageHref | null {
  if (!href.startsWith("shared-message:")) return null
  const split = splitReferenceQuery(href.slice("shared-message:".length))
  if (!split) return null
  const parts = split.path.split("/")
  // Exactly the 2-segment (legacy / in-stream) or 3-segment (conversation
  // origin) shapes `buildSharedMessageHref` emits — reject anything longer so a
  // malformed href can't silently drop trailing data, matching the strictness
  // of the regex-anchored `parseSharedMessageLine` in markdown.ts.
  if (parts.length < 2 || parts.length > 3) return null
  return {
    streamId: parts[0],
    messageId: parts[1],
    conversationId: parts[2] || undefined,
    version: split.pin.version,
    range: split.pin.range,
  }
}

/**
 * `?v=<n>` when pinned, plus `&r=<from>-<to>` when the reference covers a span
 * of that revision. A range without a version has no meaning — positions only
 * exist inside a known revision — so it's a programming error, not a value to
 * drop silently (INV-11).
 */
function buildReferenceQuery(pin: ReferencePin): string {
  const version = pin.version ?? null
  const range = pin.range ?? null
  if (version === null) {
    if (range !== null) throw new Error("A reference range requires a pinned version")
    return ""
  }
  if (range === null) return `?v=${version}`
  return `?v=${version}&r=${range.from}-${range.to}`
}

/**
 * Split a pointer body into its path and its pin. Returns `null` when the query
 * is malformed — the caller then treats the whole href as unparseable rather
 * than silently reading a reference as unpinned. Unrecognised parameters are
 * ignored so a future one doesn't invalidate today's links.
 */
function splitReferenceQuery(body: string): { path: string; pin: Required<ReferencePin> } | null {
  const queryAt = body.indexOf("?")
  if (queryAt < 0) return { path: body, pin: { version: null, range: null } }
  const path = body.slice(0, queryAt)
  const params = new URLSearchParams(body.slice(queryAt + 1))
  const rawVersion = params.get("v")
  const rawRange = params.get("r")
  if (rawVersion === null) {
    return rawRange === null ? { path, pin: { version: null, range: null } } : null
  }
  if (!/^\d+$/.test(rawVersion)) return null
  const version = Number(rawVersion)
  if (version < 1) return null
  if (rawRange === null) return { path, pin: { version, range: null } }
  const match = rawRange.match(/^(\d+)-(\d+)$/)
  if (!match) return null
  const from = Number(match[1])
  const to = Number(match[2])
  if (from >= to) return null
  return { path, pin: { version, range: { from, to } } }
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
