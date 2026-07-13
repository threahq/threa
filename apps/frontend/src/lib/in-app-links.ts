import type { JSONContent } from "@threa/types"
import { collectLinkUrls } from "@threa/prosemirror"

/** Mirrors the backend `parseInAppLink` path shapes (`url-utils.ts`). */
const STREAM_PATH = /^\/w\/[^/]+\/s\/([^/]+)$/
const MEMO_PATH = /^\/w\/[^/]+\/memos\/([^/]+)$/
const DELEGATION_PATH = /^\/w\/[^/]+\/delegations\/([^/]+)$/
const BOARD_PATH = /^\/w\/[^/]+\/board$/
const WORKSPACE_PATH = /^\/w\/([^/]+)\//

/** Panel-id prefix a conversation deep-link carries in `?panel=` (mirrors `CONVERSATION_PANEL_PREFIX`). */
const CONVERSATION_PANEL_PREFIX = "conv:"

/**
 * Matches the server's MAX_PREVIEWS_PER_MESSAGE so the composer never chips more
 * links than a posted message would preview.
 */
const MAX_DRAFT_LINK_CHIPS = 5

/**
 * A draft link classified for chip rendering. In-app links carry the parsed
 * target ids (resolved to a name/access tier by the chip); web links carry just
 * the display host. The `url` round-trips so the chip can resolve and dedup.
 */
export type DraftLinkRef =
  | { kind: "web"; url: string; host: string }
  | { kind: "stream"; url: string; workspaceId: string; streamId: string }
  | { kind: "message"; url: string; workspaceId: string; streamId: string; messageId: string }
  | { kind: "memo"; url: string; workspaceId: string; memoId: string }
  | { kind: "conversation"; url: string; workspaceId: string; conversationId: string }
  | { kind: "delegation"; url: string; workspaceId: string; delegationId: string }

/**
 * Draft link kinds that earn a below-composer chip. Stream/message/conversation/
 * delegation in-app links are excluded: like a posted message (#1103), they render as an
 * inline chip in the draft body (a pasted one becomes an atom node; a typed one
 * converts on send), so a below-row chip would double the surface. Only web and
 * memo links keep their below-row chip (memo is card-only, no inline chip).
 */
export type BelowRowDraftLink = Extract<DraftLinkRef, { kind: "web" | "memo" }>

export function isBelowRowDraftLink(link: DraftLinkRef): link is BelowRowDraftLink {
  return link.kind === "web" || link.kind === "memo"
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin
}

/**
 * Classify a draft URL into an in-app target (stream / message / memo /
 * conversation / delegation at this app's origin) or a plain web link. In-app path shapes mirror the backend
 * `parseInAppLink`; a same-origin URL that isn't a recognized resource (e.g.
 * `/settings`) falls through to a web chip. Returns null for non-http(s) URLs.
 */
export function classifyDraftLink(url: string, origin: string | null = currentOrigin()): DraftLinkRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null

  if (origin && parsed.origin === origin) {
    const workspaceId = parsed.pathname.match(WORKSPACE_PATH)?.[1]
    if (workspaceId) {
      const streamId = parsed.pathname.match(STREAM_PATH)?.[1]
      if (streamId) {
        const messageId = parsed.searchParams.get("m")
        return messageId
          ? { kind: "message", url, workspaceId, streamId, messageId }
          : { kind: "stream", url, workspaceId, streamId }
      }
      const memoId = parsed.pathname.match(MEMO_PATH)?.[1]
      if (memoId) return { kind: "memo", url, workspaceId, memoId }
      const delegationId = parsed.pathname.match(DELEGATION_PATH)?.[1]
      if (delegationId) return { kind: "delegation", url, workspaceId, delegationId }
      if (BOARD_PATH.test(parsed.pathname)) {
        const panel = parsed.searchParams.get("panel")
        if (panel?.startsWith(CONVERSATION_PANEL_PREFIX)) {
          const conversationId = panel.slice(CONVERSATION_PANEL_PREFIX.length)
          if (conversationId) return { kind: "conversation", url, workspaceId, conversationId }
        }
      }
    }
  }

  return { kind: "web", url, host: parsed.hostname.replace(/^www\./, "") }
}

/**
 * Every link URL referenced by draft content, so the composer can chip each one.
 * Reuses {@link collectLinkUrls} (link marks + bare-text URLs) — the authoritative
 * node-tree extractor — then dedupes (document order) and caps to the server's
 * per-message preview limit. Returns both in-app and web links; the caller
 * classifies each with {@link classifyDraftLink}.
 */
export function extractDraftLinkUrls(content: JSONContent | null | undefined): string[] {
  if (!content) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const href of collectLinkUrls(content)) {
    if (seen.has(href) || !/^https?:\/\//i.test(href)) continue
    seen.add(href)
    result.push(href)
    if (result.length >= MAX_DRAFT_LINK_CHIPS) break
  }
  return result
}
