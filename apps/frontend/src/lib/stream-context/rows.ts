import { collectGiphyEmbeds, collectLinkUrls } from "@threa/prosemirror"
import {
  categoryFromMime,
  streamContextItemKey,
  type AttachmentSummary,
  type CapturedMemoSummary,
  type ContextCategory,
  type JSONContent,
  type StreamContextItemDetail,
  type StreamContextRefKind,
} from "@threa/types"
import { stripMarkdownToInline } from "@/lib/markdown"
import type { CachedEvent, CachedStreamContextItem } from "@/db"

/**
 * btree index bound on the server — a longer href is never projected, so a
 * local row for it would never reconcile. Mirrors `stream-context/extract.ts`.
 */
const MAX_URL_LENGTH = 2000
const SNIPPET_MAX = 120

/** The slice of a `message_created` payload a context row is derived from. */
interface MessageEventPayload {
  messageId?: string
  contentMarkdown?: string
  contentJson?: JSONContent
  attachments?: AttachmentSummary[]
}

interface MemosCapturedPayload {
  memos?: CapturedMemoSummary[]
}

export interface ContextRowsContext {
  workspaceId: string
  /** The stream the artifact lives in — a thread id for thread content. */
  streamId: string
  /** The stream's effective root; equals `streamId` for a non-thread. */
  rootStreamId: string
}

function snippetOf(markdown: string | undefined): string {
  if (!markdown) return ""
  const firstLine = markdown.split("\n").find((line) => line.trim().length > 0) ?? ""
  const inline = stripMarkdownToInline(firstLine).trim()
  return inline.length > SNIPPET_MAX ? `${inline.slice(0, SNIPPET_MAX)}…` : inline
}

/**
 * Locally derive the context rows a timeline event contributes — the same rows
 * the backend's `contextRowsForMessage` writes for the same message, one row per
 * (message × artifact), so the two sets reconcile by `key`.
 *
 * Two deliberate divergences from the server, both self-healing on reconcile:
 *
 * - `groupKey` is left equal to `refId`. The collapse key is server-computed
 *   (the GitHub/Linear-aware URL normalizer stays backend-only), so a local link
 *   row groups by its raw href until the server row overwrites it under the same
 *   `key`.
 * - `detail` carries only what the event itself knows. The server joins live
 *   display data (link previews, attachment metadata, memo titles) onto its rows.
 *
 * Rows are deduped within the message by `(category, refId)`, matching the
 * server's per-message dedup; occurrences across messages stay separate rows.
 */
export function contextItemsFromEvent(
  event: CachedEvent,
  ctx: ContextRowsContext,
  /** The `message_created` events a `memos:captured` payload cites, by message id. */
  sourceMessages?: ReadonlyMap<string, CachedEvent>
): CachedStreamContextItem[] {
  if (event.eventType === "memos:captured") return memoRows(event, ctx, sourceMessages)
  if (event.eventType !== "message_created") return []

  const payload = event.payload as MessageEventPayload
  const messageId = payload.messageId
  if (!messageId) return []

  const rows: CachedStreamContextItem[] = []
  const seen = new Set<string>()
  const snippet = snippetOf(payload.contentMarkdown)

  const push = (
    category: ContextCategory,
    refKind: StreamContextRefKind,
    refId: string,
    detail: StreamContextItemDetail
  ): void => {
    const dedupe = `${category}:${refId}`
    if (seen.has(dedupe)) return
    seen.add(dedupe)
    rows.push(
      buildRow(ctx, {
        category,
        refKind,
        refId,
        sourceMessageId: messageId,
        authorId: event.actorId,
        occurredAt: event.createdAt,
        sequence: event.sequence,
        snippet,
        detail,
      })
    )
  }

  // Body links read from the structured document (INV-58), never serialized
  // markdown — the same source `extractUrls` prefers on the server. The raw href
  // is the ref id; normalization is the server's job.
  const contentJson = payload.contentJson
  if (contentJson) {
    const seenNormalized = new Set<string>()
    for (const url of collectLinkUrls(contentJson)) {
      if (url.length > MAX_URL_LENGTH) continue
      if (!/^https?:\/\//i.test(url)) continue
      // The server emits only the FIRST raw href of each normalized group
      // (`filterAndDeduplicateUrls`), so two hrefs differing only by fragment or
      // tracking params yield ONE server row. Dedupe the same way or the extra
      // local row never reconciles and the panel double-renders the link.
      const normalized = localNormalizedUrl(url)
      if (seenNormalized.has(normalized)) continue
      seenNormalized.add(normalized)
      push("link", "url", url, emptyLinkDetail(url))
    }
  }

  for (const attachment of payload.attachments ?? []) {
    const mimeCategory = categoryFromMime(attachment.mimeType)
    if (mimeCategory === "image" || mimeCategory === "video") {
      // Equality, not a prefix match — a parameterised mime must classify the
      // same on both sides or the two rows carry different `mediaKind`s.
      const imageKind = attachment.mimeType.toLowerCase() === "image/gif" ? "gif" : "image"
      const mediaKind = mimeCategory === "video" ? "video" : imageKind
      push("media", "attachment", attachment.id, {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        mediaKind,
        giphyUrl: null,
        giphyTitle: null,
      })
    } else {
      push("file", "attachment", attachment.id, {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: null,
        height: null,
        mediaKind: null,
        giphyUrl: null,
        giphyTitle: null,
      })
    }
  }

  for (const embed of contentJson ? collectGiphyEmbeds(contentJson) : []) {
    push("media", "giphy", embed.giphyUrl, {
      attachmentId: null,
      filename: null,
      mimeType: null,
      sizeBytes: null,
      width: embed.width ?? null,
      height: embed.height ?? null,
      mediaKind: "gif",
      giphyUrl: embed.giphyUrl,
      giphyTitle: embed.title ?? null,
    })
  }

  return rows
}

/**
 * Memo rows from a `memos:captured` broadcast (INV-62): one per captured memo,
 * anchored on its source messages exactly as `indexCapturedMemos` anchors the
 * server's row — the LATEST resolvable source's timestamp (capture time lands
 * minutes late; extraction is debounced) and the FIRST resolvable source as the
 * "jump to origin" target. A memo whose sources all resolve to nothing is
 * skipped, matching the server, so no orphan row is written that the server
 * never reconciles and no delete can ever reach.
 */
function memoRows(
  event: CachedEvent,
  ctx: ContextRowsContext,
  sourceMessages?: ReadonlyMap<string, CachedEvent>
): CachedStreamContextItem[] {
  const payload = event.payload as MemosCapturedPayload
  const seen = new Set<string>()
  const rows: CachedStreamContextItem[] = []
  for (const memo of payload?.memos ?? []) {
    if (seen.has(memo.memoId)) continue
    seen.add(memo.memoId)
    const resolved = memo.sourceMessageIds
      .map((id) => sourceMessages?.get(id))
      .filter((source): source is CachedEvent => source !== undefined)
    if (resolved.length === 0) continue
    const latest = resolved.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    const firstMessageId = (resolved[0].payload as { messageId?: string })?.messageId ?? null
    rows.push(
      buildRow(ctx, {
        category: "memo",
        refKind: "memo",
        refId: memo.memoId,
        sourceMessageId: firstMessageId,
        authorId: latest.actorId,
        occurredAt: latest.createdAt,
        sequence: latest.sequence,
        snippet: snippetOf(memo.title),
        detail: { title: memo.title, knowledgeType: memo.knowledgeType },
      })
    )
  }
  return rows
}

/** Tracking params `normalizeUrl` strips server-side. */
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]

/**
 * The host/fragment/tracking-param rules the server's `normalizeUrl` applies,
 * used ONLY to decide which hrefs collapse into one local row. The server's
 * GitHub/Linear-aware hash retention stays backend-only: this can therefore
 * collapse a pair the server keeps apart, which self-heals when the seed lands
 * the missing row — the reverse (an extra local row) would never reconcile.
 */
function localNormalizedUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hostname = url.hostname.toLowerCase()
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param)
    url.searchParams.sort()
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1)
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = ""
    }
    url.hash = ""
    return url.toString()
  } catch {
    return raw.toLowerCase()
  }
}

function emptyLinkDetail(url: string): StreamContextItemDetail {
  return {
    url,
    title: null,
    description: null,
    siteName: null,
    faviconUrl: null,
    imageUrl: null,
    previewType: null,
    contentType: null,
    previewStatus: null,
  }
}

function buildRow(
  ctx: ContextRowsContext,
  input: {
    category: ContextCategory
    refKind: StreamContextRefKind
    refId: string
    sourceMessageId: string | null
    authorId: string | null
    occurredAt: string
    sequence: string | null
    snippet: string
    detail: StreamContextItemDetail
  }
): CachedStreamContextItem {
  return {
    key: streamContextItemKey({
      category: input.category,
      refId: input.refId,
      sourceMessageId: input.sourceMessageId,
    }),
    category: input.category,
    refKind: input.refKind,
    refId: input.refId,
    groupKey: input.refId,
    groupRef: `${input.category}:${input.refId}`,
    streamId: ctx.streamId,
    rootStreamId: ctx.rootStreamId,
    workspaceId: ctx.workspaceId,
    sourceMessageId: input.sourceMessageId,
    authorId: input.authorId,
    occurredAt: input.occurredAt,
    sequence: input.sequence,
    snippet: input.snippet,
    occurrenceCount: 1,
    detail: input.detail,
    _cachedAt: Date.now(),
  }
}
