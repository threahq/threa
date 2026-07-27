import { collectGiphyEmbeds } from "@threa/prosemirror"
import { categoryFromMime, stripMarkdownToInline, type AttachmentSummary, type JSONContent } from "@threa/types"
import { streamContextItemId } from "../../lib/id"
import { extractUrls, normalizeUrl, getAppOrigins } from "../link-previews"
import type { ContextCategory, ContextRefKind, NewStreamContextItem } from "./types"

/** btree index bound — a longer href cannot be indexed, so it is not projected. */
const MAX_URL_LENGTH = 2000
const SNIPPET_MAX_LENGTH = 120

export interface ContextRowsForMessageParams {
  workspaceId: string
  streamId: string
  rootStreamId: string
  messageId: string
  authorId: string | null
  occurredAt: Date
  sequence: bigint | null
  contentJson: JSONContent | null | undefined
  contentMarkdown: string
  attachments: Pick<AttachmentSummary, "id" | "mimeType">[]
}

export function contextSnippet(contentMarkdown: string): string {
  const firstLine = stripMarkdownToInline(contentMarkdown.split("\n").find((line) => line.trim().length > 0) ?? "")
  const trimmed = firstLine.trim()
  return trimmed.length > SNIPPET_MAX_LENGTH ? `${trimmed.slice(0, SNIPPET_MAX_LENGTH)}…` : trimmed
}

/**
 * Projection rows for a single message: links, inline Giphy embeds, and
 * attachments. Deduped within the message by `(category, refId)` — occurrences
 * across messages are separate rows by design.
 */
export function contextRowsForMessage(params: ContextRowsForMessageParams): NewStreamContextItem[] {
  const snippet = contextSnippet(params.contentMarkdown)
  const rows: NewStreamContextItem[] = []
  const seen = new Set<string>()

  const push = (
    category: ContextCategory,
    refKind: ContextRefKind,
    refId: string,
    groupKey: string,
    detail: Record<string, unknown>
  ): void => {
    const key = `${category}:${refId}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      id: streamContextItemId(),
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      rootStreamId: params.rootStreamId,
      category,
      refKind,
      refId,
      groupKey,
      sourceMessageId: params.messageId,
      authorId: params.authorId,
      occurredAt: params.occurredAt,
      sequence: params.sequence,
      snippet,
      detail,
    })
  }

  for (const href of extractUrls(params.contentMarkdown, getAppOrigins(), params.contentJson)) {
    if (href.length > MAX_URL_LENGTH) continue
    push("link", "url", href, normalizeUrl(href), { url: href })
  }

  if (params.contentJson) {
    for (const embed of collectGiphyEmbeds(params.contentJson)) {
      push("media", "giphy", embed.giphyUrl, embed.giphyUrl, {
        giphyUrl: embed.giphyUrl,
        title: embed.title,
        width: embed.width,
        height: embed.height,
      })
    }
  }

  for (const attachment of params.attachments) {
    const mimeCategory = categoryFromMime(attachment.mimeType)
    if (mimeCategory === "image" || mimeCategory === "video") {
      // Same equality the client's derive path uses — a prefix match would
      // classify a parameterised mime differently on the two sides, and the
      // rows are reconciled by key across both.
      const imageKind = attachment.mimeType.toLowerCase() === "image/gif" ? "gif" : "image"
      const mediaKind = mimeCategory === "video" ? "video" : imageKind
      push("media", "attachment", attachment.id, attachment.id, { mediaKind })
    } else {
      push("file", "attachment", attachment.id, attachment.id, {})
    }
  }

  return rows
}
