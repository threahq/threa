import {
  categoryFromMime,
  isInAppLinkContentType,
  type AttachmentSummary,
  type CapturedMemoSummary,
  type JSONContent,
  type LinkPreviewSummary,
  type ThreadSummary,
} from "@threa/types"
import { collectGiphyEmbeds, collectLinkUrls } from "@threa/prosemirror"
import { stripMarkdownToInline } from "@/lib/markdown"
import type { CachedEvent } from "@/db"
import {
  CONTEXT_CATEGORIES,
  type ContextCategory,
  type ContextItem,
  type DerivedStreamContext,
  type LinkContextItem,
} from "./types"

/** The slice of a `message_created` payload the panel reads. */
interface MessageEventPayload {
  messageId: string
  contentMarkdown?: string
  contentJson?: JSONContent
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
  replyCount?: number
  threadId?: string
  threadSummary?: ThreadSummary
}

interface MemosCapturedPayload {
  memos?: CapturedMemoSummary[]
}

const SNIPPET_MAX = 120

function firstLine(markdown: string | undefined): string {
  if (!markdown) return ""
  const inline = stripMarkdownToInline(markdown)
  return inline.length > SNIPPET_MAX ? inline.slice(0, SNIPPET_MAX) + "…" : inline
}

/** Normalize a URL for cross-message dedup: lowercase host, drop trailing `/`. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    u.hostname = u.hostname.toLowerCase()
    u.hash = ""
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1)
    }
    return u.toString()
  } catch {
    return raw.trim().toLowerCase()
  }
}

const GITHUB_BADGES: Record<string, string> = {
  github_pr: "PR",
  github_issue: "Issue",
  github_commit: "Commit",
  github_diff: "Diff",
  github_file: "File",
}
const LINEAR_BADGES: Record<string, string> = {
  linear_project: "Project",
  linear_document: "Doc",
}
// Labels stay type-agnostic where the reference can point at several stream
// kinds: a stream_link may be a channel, scratchpad, or DM, and the per-viewer
// streamType needed to distinguish them (inAppData) is absent on broadcast
// events — "Stream" is correct for all three. Memo/delegation wording matches
// this panel's own filter chips ("Memories", "Delegations").
const IN_APP_BADGES: Record<string, string> = {
  message_link: "Message",
  stream_link: "Stream",
  memo_link: "Memory",
  conversation_link: "Conversation",
  delegation_link: "Delegation",
}

/**
 * The row's type badge from a preview's `previewType`/`contentType` pair —
 * shared by the derive path (which reads a `LinkPreviewSummary` off the event)
 * and the index path (which reads the same two fields off the wire `detail`).
 */
export function linkPreviewBadge(
  preview:
    | {
        previewType?: LinkPreviewSummary["previewType"] | null
        contentType?: LinkPreviewSummary["contentType"] | null
      }
    | null
    | undefined
): {
  previewKind: LinkContextItem["previewKind"]
  badge: string | null
} {
  if (!preview) return { previewKind: "generic", badge: null }
  if (preview.contentType && isInAppLinkContentType(preview.contentType)) {
    return { previewKind: "in-app", badge: IN_APP_BADGES[preview.contentType] ?? "Threa" }
  }
  const previewType = preview.previewType
  if (!previewType) return { previewKind: "generic", badge: null }
  if (previewType.startsWith("github_")) {
    return { previewKind: "github", badge: GITHUB_BADGES[previewType] ?? "GitHub" }
  }
  if (previewType.startsWith("linear_")) {
    return { previewKind: "linear", badge: LINEAR_BADGES[previewType] ?? "Linear" }
  }
  return { previewKind: "generic", badge: null }
}

/**
 * Derive the "In this stream" overview from a stream's loaded timeline events.
 *
 * Pure and reactive: callers pass the live `useStreamEvents` array and re-run
 * on every change. Collects links (external URLs and in-app references —
 * shared messages, channels, memos, conversations, delegated tasks — badged by
 * their preview contentType), media (images/GIFs/videos), file
 * attachments, captured memories, and threads branched from this stream — each
 * carrying the source message id for "jump to origin". Items dedup within their
 * category (links by normalized URL, attachments by id, memos by memoId,
 * threads by threadId), keeping the most recent occurrence; the whole list is
 * returned newest-first.
 *
 * Scope is the loaded window only (what's in IDB). This is the sealed-stream
 * path and only that: an E2E stream reaches the server as ciphertext, so
 * `stream_context_items` has nothing for it and deriving on-device is the only
 * way to see its artifacts at all. Every other stream reads the server index.
 */
export function deriveStreamContext(events: readonly CachedEvent[] | undefined): DerivedStreamContext {
  const links = new Map<string, LinkContextItem>()
  const media = new Map<string, ContextItem>()
  const files = new Map<string, ContextItem>()
  const memos = new Map<string, ContextItem>()
  const threads = new Map<string, ContextItem>()

  // Newest-first so the first occurrence we see of a dedup key is the most
  // recent — later (older) occurrences only bump refCount, never overwrite.
  const ordered = events ? [...events].reverse() : []

  for (const event of ordered) {
    const createdAt = event.createdAt

    if (event.eventType === "memos:captured") {
      const payload = event.payload as MemosCapturedPayload
      for (const memo of payload?.memos ?? []) {
        if (memos.has(memo.memoId)) continue
        memos.set(memo.memoId, {
          key: `memo:${memo.memoId}`,
          category: "memo",
          createdAt,
          sourceMessageId: memo.sourceMessageIds[0] ?? null,
          snippet: "",
          memoId: memo.memoId,
          title: memo.title,
          knowledgeType: memo.knowledgeType,
          sourceMessageIds: memo.sourceMessageIds,
        })
      }
      continue
    }

    if (event.eventType !== "message_created") continue

    const payload = event.payload as MessageEventPayload
    const messageId = payload.messageId
    const snippet = firstLine(payload.contentMarkdown)

    // ── Links: the structured document owns the href; server previews only
    // enrich an exact normalized match. This keeps a stale/malformed preview
    // row from replacing the URL the message actually contains.
    const previewsByUrl = new Map<string, LinkPreviewSummary>()
    for (const preview of payload.linkPreviews ?? []) {
      // Preview hrefs render into <a> elements, so never admit a custom scheme.
      if (!/^https?:\/\//i.test(preview.url)) continue
      const norm = normalizeUrl(preview.url)
      if (!previewsByUrl.has(norm)) previewsByUrl.set(norm, preview)
    }

    const seenInMessage = new Set<string>()
    const addLink = (url: string, preview?: LinkPreviewSummary) => {
      const norm = normalizeUrl(url)
      if (seenInMessage.has(norm)) return
      seenInMessage.add(norm)
      const existing = links.get(norm)
      if (existing) {
        existing.refCount += 1
        return
      }
      const { previewKind, badge } = linkPreviewBadge(preview)
      links.set(norm, {
        key: `link:${norm}`,
        category: "link",
        createdAt,
        sourceMessageId: messageId,
        snippet,
        url,
        title: preview?.title ?? null,
        siteName: preview?.siteName ?? null,
        faviconUrl: preview?.faviconUrl ?? null,
        imageUrl: preview?.imageUrl ?? null,
        previewKind,
        badge,
        refCount: 1,
      })
    }

    // Body links read from the structured document (INV-58), never serialized
    // markdown. A regex over `**[x](url)**` can leak bold markers into the URL.
    // Events without a document retain the legacy preview-only fallback.
    const contentJson = payload.contentJson
    if (contentJson) {
      for (const url of collectLinkUrls(contentJson)) {
        addLink(url, previewsByUrl.get(normalizeUrl(url)))
      }
    } else {
      for (const preview of previewsByUrl.values()) {
        addLink(preview.url, preview)
      }
    }

    // ── Attachments → media (image/gif/video) or files (everything else).
    for (const attachment of payload.attachments ?? []) {
      const category = categoryFromMime(attachment.mimeType)
      const isVideo = category === "video"
      const isImage = category === "image"
      if (isImage || isVideo) {
        if (media.has(attachment.id)) continue
        const isGif = attachment.mimeType.toLowerCase() === "image/gif"
        let mediaKind: "image" | "gif" | "video" = "image"
        if (isVideo) mediaKind = "video"
        else if (isGif) mediaKind = "gif"
        media.set(attachment.id, {
          key: `media:${attachment.id}`,
          category: "media",
          createdAt,
          sourceMessageId: messageId,
          snippet,
          mediaKind,
          attachmentId: attachment.id,
          giphyUrl: null,
          filename: attachment.filename,
          width: attachment.width,
          height: attachment.height,
        })
      } else {
        if (files.has(attachment.id)) continue
        files.set(attachment.id, {
          key: `file:${attachment.id}`,
          category: "file",
          createdAt,
          sourceMessageId: messageId,
          snippet,
          attachmentId: attachment.id,
          fileCategory: category,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
        })
      }
    }

    // ── Inline Giphy GIFs (not attachments) → media.
    for (const ref of contentJson ? collectGiphyEmbeds(contentJson) : []) {
      if (media.has(ref.giphyUrl)) continue
      media.set(ref.giphyUrl, {
        key: `media:${ref.giphyUrl}`,
        category: "media",
        createdAt,
        sourceMessageId: messageId,
        snippet,
        mediaKind: "gif",
        attachmentId: null,
        giphyUrl: ref.giphyUrl,
        filename: ref.title || "GIF",
        width: ref.width,
        height: ref.height,
      })
    }

    // ── Threads branched from this stream.
    if (payload.threadId && (payload.replyCount ?? 0) > 0) {
      if (!threads.has(payload.threadId)) {
        const summary = payload.threadSummary
        threads.set(payload.threadId, {
          key: `thread:${payload.threadId}`,
          category: "thread",
          // Order threads by most recent activity, not the parent's age.
          createdAt: summary?.lastReplyAt ?? createdAt,
          sourceMessageId: messageId,
          snippet: snippet || "Thread",
          threadId: payload.threadId,
          replyCount: payload.replyCount ?? 0,
          lastReplyPreview: summary?.latestReply ? firstLine(summary.latestReply.contentMarkdown) : null,
        })
      }
    }
  }

  // ISO timestamps sort lexically; compare b→a for newest-first.
  const items = [...links.values(), ...media.values(), ...files.values(), ...memos.values(), ...threads.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt)
  )

  const counts = Object.fromEntries(CONTEXT_CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>
  for (const item of items) counts[item.category] += 1

  return { items, counts, total: items.length }
}
