import {
  isInAppLinkContentType,
  LinkPreviewContentTypes,
  type AttachmentSummary,
  type LinkPreviewContentType,
  type LinkPreviewSummary,
} from "@threa/types"

import { resolveEmojiShortcodes, stripMarkdownKeepingCode, truncateInline } from "@/lib/markdown/strip"

/** Characters of prose one reading-minute covers. */
const CHARS_PER_MINUTE = 1100

/** Longest link-preview title that reads as a label; longer ones fall back to the hostname. */
const MAX_LINK_TITLE_CHARS = 28

/**
 * The first meaningful line of a message, as inline text (INV-60 — the strip is
 * the shared `@threa/types` one, never a parallel implementation).
 *
 * The whole markdown is stripped before the split: fences are block-level, so a
 * line-first split would leave a bare ``` behind instead of the code's first
 * line. The per-line pass is emoji-only — re-stripping markdown here would
 * re-interpret fence-extracted code (`# comment`, `> out.txt`) as markdown.
 * Lines that strip to nothing (dividers, alt-less images, empty headings) are
 * skipped. Returns "" when nothing survives — the caller picks the fallback.
 */
export function leadLine(
  contentMarkdown: string,
  maxChars: number,
  toEmoji?: (shortcode: string) => string | null
): string {
  for (const line of stripMarkdownKeepingCode(contentMarkdown).split("\n")) {
    const inline = resolveEmojiShortcodes(line, toEmoji).trim()
    if (!inline) continue
    return truncateInline(inline, maxChars)
  }
  return ""
}

export function estimateReadingMinutes(chars: number): number {
  if (chars <= 0) return 0
  return Math.max(1, Math.ceil(chars / CHARS_PER_MINUTE))
}

/** The `RenderableMessage` fields the artifact row reads, structurally. */
export interface LedgerArtifactSource {
  attachments?: AttachmentSummary[]
  linkPreviews?: LinkPreviewSummary[]
}

export interface RowArtifacts {
  attachmentCount: number
  firstLinkLabel: string | null
}

export function rowArtifacts(message: LedgerArtifactSource): RowArtifacts {
  const preview = (message.linkPreviews ?? []).find((p) => p.contentType !== LinkPreviewContentTypes.STREAM_LINK)
  return {
    attachmentCount: message.attachments?.length ?? 0,
    firstLinkLabel: preview ? linkLabel(preview) : null,
  }
}

/**
 * In-app previews are stored without a title — the target resolves per-viewer —
 * so the kind noun is the only honest label; the hostname would read
 * "app.threa.io" on every one.
 */
const IN_APP_LINK_NOUNS: Partial<Record<LinkPreviewContentType, string>> = {
  [LinkPreviewContentTypes.MESSAGE_LINK]: "message",
  [LinkPreviewContentTypes.MEMO_LINK]: "memo",
  [LinkPreviewContentTypes.CONVERSATION_LINK]: "conversation",
  [LinkPreviewContentTypes.DELEGATION_LINK]: "delegation",
}

export function linkLabel(preview: LinkPreviewSummary): string {
  if (isInAppLinkContentType(preview.contentType)) return IN_APP_LINK_NOUNS[preview.contentType] ?? "link"
  const title = preview.title?.trim()
  if (title && title.length < MAX_LINK_TITLE_CHARS) return title
  return hostname(preview.url)
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export type LedgerItemKind = "message" | "event"

export interface LedgerEventGroup<T> {
  kind: "event-group"
  events: T[]
}

/**
 * Fold adjacent runs of two or more events into one group; single events and
 * messages pass through untouched. Pure and order-preserving.
 */
export function coalesceLedgerItems<T extends { kind: LedgerItemKind }>(items: T[]): Array<T | LedgerEventGroup<T>> {
  const out: Array<T | LedgerEventGroup<T>> = []
  let run: T[] = []

  const flush = () => {
    if (run.length >= 2) out.push({ kind: "event-group", events: run })
    else out.push(...run)
    run = []
  }

  for (const item of items) {
    if (item.kind === "event") {
      run.push(item)
      continue
    }
    flush()
    out.push(item)
  }
  flush()
  return out
}
