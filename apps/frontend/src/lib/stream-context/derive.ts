import {
  categoryFromMime,
  type AttachmentSummary,
  type CapturedMemoSummary,
  type LinkPreviewSummary,
  type ThreadSummary,
} from "@threa/types"
import { stripMarkdownToInline } from "@/lib/markdown"
import { extractGiphyRefs } from "@/lib/markdown/giphy-refs"
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
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
  replyCount?: number
  threadId?: string
  threadSummary?: ThreadSummary
}

interface MemosCapturedPayload {
  memos?: CapturedMemoSummary[]
}

// Mirrors the markdown link serialization (`[text](url)`), narrowed to web
// URLs so the custom protocols (`giphy:`, `memo:`, `attachment:`, `quote:`)
// and bare `#channel` / `@mention` code spans never match.
const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\\\]])*\]\((https?:\/\/[^)\s]+)\)/g

// A web URL pasted as plain text (no link mark, no preview). The markdown-link
// pass runs first and records its URLs, so this only adds genuinely-bare ones.
const BARE_URL_PATTERN = /https?:\/\/[^\s<>()[\]]+/g

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

function linkBadge(previewType: string | null | undefined): {
  previewKind: LinkContextItem["previewKind"]
  badge: string | null
} {
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
 * on every change. Collects external links, media (images/GIFs/videos), file
 * attachments, captured memories, and threads branched from this stream — each
 * carrying the source message id for "jump to origin". Items dedup within their
 * category (links by normalized URL, attachments by id, memos by memoId,
 * threads by threadId), keeping the most recent occurrence; the whole list is
 * returned newest-first.
 *
 * Scope is the loaded window only (what's in IDB), which is what a frontend-only
 * overview can see without a backend index — fine for the recency-biased view
 * the panel presents.
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

    // ── Links: rich previews first, then any bare markdown URLs not covered.
    const seenInMessage = new Set<string>()
    for (const preview of payload.linkPreviews ?? []) {
      // `message_link` previews point at other in-app messages, not the web —
      // they belong to "related", not the external-links list.
      if (preview.contentType === "message_link") continue
      // The href renders into an <a> (React does not sanitize href), and unlike
      // the bare/markdown passes this URL never went through an http(s) regex —
      // gate the scheme so a non-http preview url can't reach the anchor.
      if (!/^https?:\/\//i.test(preview.url)) continue
      const norm = normalizeUrl(preview.url)
      seenInMessage.add(norm)
      const existing = links.get(norm)
      if (existing) {
        existing.refCount += 1
        continue
      }
      const { previewKind, badge } = linkBadge(preview.previewType)
      links.set(norm, {
        key: `link:${norm}`,
        category: "link",
        createdAt,
        sourceMessageId: messageId,
        snippet,
        url: preview.url,
        title: preview.title,
        siteName: preview.siteName,
        faviconUrl: preview.faviconUrl,
        imageUrl: preview.imageUrl,
        previewKind,
        badge,
        refCount: 1,
      })
    }
    const addBareLink = (rawUrl: string) => {
      const url = rawUrl.replace(/[.,;:!?]+$/, "")
      const norm = normalizeUrl(url)
      if (seenInMessage.has(norm)) return
      seenInMessage.add(norm)
      const existing = links.get(norm)
      if (existing) {
        existing.refCount += 1
        return
      }
      links.set(norm, {
        key: `link:${norm}`,
        category: "link",
        createdAt,
        sourceMessageId: messageId,
        snippet,
        url,
        title: null,
        siteName: null,
        faviconUrl: null,
        imageUrl: null,
        previewKind: "generic",
        badge: null,
        refCount: 1,
      })
    }
    const markdown = payload.contentMarkdown ?? ""
    for (const match of markdown.matchAll(MARKDOWN_LINK_PATTERN)) addBareLink(match[1])
    for (const match of markdown.matchAll(BARE_URL_PATTERN)) addBareLink(match[0])

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
          filename: attachment.filename,
          sizeBytes: attachment.sizeBytes,
        })
      }
    }

    // ── Inline Giphy GIFs (not attachments) → media.
    for (const ref of extractGiphyRefs(payload.contentMarkdown ?? "")) {
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
