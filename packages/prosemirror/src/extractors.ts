/**
 * Pure helpers that walk a ProseMirror JSON tree and pull out structural
 * references (attachment IDs, share pointers, etc.) for downstream access
 * checks and projection writes.
 */

import { type JSONContent, actorTypeFromMentionId, isResolvedChannelLinkId, isResolvedMentionId } from "@threa/types"

/**
 * Resolved actor references for CONSUMERS (notifications, agent/bot dispatch).
 * `actorType` is derived from the id prefix, which is authoritative (INV-64) —
 * the node's `mentionType`/`slug` are display labels and never drive a decision.
 * Broadcast sentinels map to `{ actorType: "broadcast", actorId: sentinel }`.
 * Mention nodes whose id is still a bare slug (unresolved) are skipped — they
 * only appear before the ingestion resolver runs. Deduped by `actorId`.
 */
export function collectMentionActorRefs(
  content: JSONContent
): Array<{ actorType: "user" | "persona" | "bot" | "broadcast"; actorId: string }> {
  const seen = new Set<string>()
  const refs: Array<{ actorType: "user" | "persona" | "bot" | "broadcast"; actorId: string }> = []

  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const id = node.attrs?.id
      if (typeof id === "string" && id.length > 0) {
        const actorType = actorTypeFromMentionId(id)
        if (actorType !== null && !seen.has(id)) {
          seen.add(id)
          refs.push({ actorType, actorId: id })
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
  return refs
}

/**
 * Resolved stream ids from `channelLink` nodes (id has the `stream_` prefix).
 * Unresolved (bare-slug) channel links are skipped. Deduped, first-seen order.
 */
export function collectChannelStreamIds(content: JSONContent): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "channelLink") {
      const id = node.attrs?.id
      if (typeof id === "string" && id.length > 0 && isResolvedChannelLinkId(id) && !seen.has(id)) {
        seen.add(id)
        ordered.push(id)
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
 * Slugs of mention nodes whose id is unresolved (a bare slug, no prefix) — the
 * input the ingestion resolver needs to look up. Excludes broadcast slugs
 * (`here`/`channel`), which resolve to a sentinel without a DB lookup.
 * Lowercased (slug lookups are case-insensitive) and deduped.
 */
export function collectUnresolvedMentionSlugs(content: JSONContent): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const id = node.attrs?.id
      const slug = node.attrs?.slug
      if (typeof id === "string" && typeof slug === "string" && slug.length > 0 && !isResolvedMentionId(id)) {
        const lower = slug.toLowerCase()
        if (lower !== "here" && lower !== "channel" && !seen.has(lower)) {
          seen.add(lower)
          ordered.push(lower)
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

/**
 * Slugs of `channelLink` nodes whose id is unresolved — the resolver input for
 * channels. Lowercased and deduped.
 */
export function collectUnresolvedChannelLinkSlugs(content: JSONContent): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "channelLink") {
      const id = node.attrs?.id
      const slug = node.attrs?.slug
      if (typeof id === "string" && typeof slug === "string" && slug.length > 0 && !isResolvedChannelLinkId(id)) {
        const lower = slug.toLowerCase()
        if (!seen.has(lower)) {
          seen.add(lower)
          ordered.push(lower)
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

/**
 * Pure transformer: returns a NEW tree with `mention`/`channelLink` attrs
 * rewritten by `fn`. `fn` receives the node and returns replacement attrs, or
 * `undefined` to leave the node unchanged. Non-target nodes are copied
 * structurally (only `content` is recursed); all other fields are preserved.
 */
export function mapMentionAndChannelNodes(
  content: JSONContent,
  fn: (node: JSONContent) => Record<string, unknown> | undefined
): JSONContent {
  const map = (node: JSONContent): JSONContent => {
    let next = node
    if (node.type === "mention" || node.type === "channelLink") {
      const newAttrs = fn(node)
      if (newAttrs !== undefined) {
        next = { ...node, attrs: newAttrs }
      }
    }
    if (next.content) {
      next = { ...next, content: next.content.map(map) }
    }
    return next
  }

  return map(content)
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

const BARE_URL_IN_TEXT = /https?:\/\/[^\s<>"[\]]+/g

function trimPlaintextUrl(url: string): string {
  let trimmed = url.replace(/[.,;:!?]+$/, "")
  while (trimmed.endsWith(")")) {
    const opens = (trimmed.match(/\(/g) ?? []).length
    const closes = (trimmed.match(/\)/g) ?? []).length
    if (closes <= opens) break
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

/**
 * An inline Giphy embed lifted from the node tree. Mirrors the `giphyEmbed`
 * node attrs; `title` falls back to `""` when the node carried none.
 */
export interface GiphyEmbedRef {
  giphyUrl: string
  title: string
  width?: number
  height?: number
}

/**
 * Inline Giphy GIFs (`giphyEmbed` nodes), de-duplicated by `giphyUrl` with the
 * first occurrence's title winning. Reads the node attrs directly rather than
 * re-parsing the `[title](giphy:…)` markdown serialization.
 */
export function collectGiphyEmbeds(content: JSONContent): GiphyEmbedRef[] {
  const refs: GiphyEmbedRef[] = []
  const seen = new Set<string>()

  const walk = (node: JSONContent): void => {
    if (node.type === "giphyEmbed") {
      const giphyUrl = node.attrs?.giphyUrl
      if (typeof giphyUrl === "string" && giphyUrl.length > 0 && !seen.has(giphyUrl)) {
        seen.add(giphyUrl)
        const title = node.attrs?.title
        const width = node.attrs?.width
        const height = node.attrs?.height
        refs.push({
          giphyUrl,
          title: typeof title === "string" ? title : "",
          width: typeof width === "number" ? width : undefined,
          height: typeof height === "number" ? height : undefined,
        })
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return refs
}

/**
 * External (http/https) URLs the document points at, in document order,
 * INCLUDING duplicates — callers dedup and ref-count.
 *
 * Reads from the node tree, never serialized markdown: a `link` mark's `href`
 * is the authoritative target — returned verbatim — and is immune to the
 * emphasis markers that contaminate a regex over markdown (a bold URL
 * serializes to `**https://x**`, whose trailing `**` leaks into the captured
 * string). Text nodes that are NOT inside a link mark are scanned for plain-text
 * URLs (pasted without an autolink); those pick up trailing sentence
 * punctuation from the prose around them, so it's trimmed — a thing we must
 * never do to an authoritative href, whose final `!`/`.`/etc. may be
 * significant. Custom-protocol links (`giphy:`/`memo:`/`attachment:`/`quote:`)
 * are excluded by the `https?:` gate.
 */
export function collectLinkUrls(content: JSONContent): string[] {
  const urls: string[] = []

  const walk = (node: JSONContent): void => {
    if (node.type === "text" && typeof node.text === "string") {
      const linkMarks = (node.marks ?? []).filter((mark) => mark.type === "link")
      if (linkMarks.length > 0) {
        for (const mark of linkMarks) {
          const href = mark.attrs?.href
          if (typeof href === "string" && /^https?:\/\//i.test(href)) urls.push(href)
        }
      } else {
        for (const match of node.text.matchAll(BARE_URL_IN_TEXT)) urls.push(trimPlaintextUrl(match[0]))
      }
    }
    if (node.content) {
      for (const child of node.content) {
        walk(child)
      }
    }
  }

  walk(content)
  return urls
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
