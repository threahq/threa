import {
  categoryFromMime,
  DELEGATION_STATUSES,
  KNOWLEDGE_TYPES,
  type DelegationStatus,
  type KnowledgeType,
} from "@threa/types"
import type {
  StreamContextAttachmentDetail,
  StreamContextDelegationDetail,
  StreamContextLinkDetail,
  StreamContextMemoDetail,
  StreamContextThreadDetail,
} from "@threa/types"
import type { CachedStreamContextItem } from "@/db"
import { linkPreviewBadge } from "./derive"
import type { ContextItem } from "./types"

/**
 * Adapt an indexed row into the `ContextItem` union `StreamContextRow` already
 * renders, so the index path and the derive path share one row component.
 *
 * The wire `detail` is joined live server-side and is empty on a locally derived
 * row that hasn't reconciled yet, so every field is treated as optional here:
 * a link with no preview falls back to its href, an attachment with no metadata
 * to its ref id. Returns null only when the row can't be rendered at all
 * (a file row with no attachment id).
 */
export function contextItemFromCached(row: CachedStreamContextItem): ContextItem | null {
  const base = {
    key: row.key,
    createdAt: row.occurredAt,
    sourceMessageId: row.sourceMessageId,
    snippet: row.snippet,
  }

  switch (row.category) {
    case "link": {
      const detail = row.detail as Partial<StreamContextLinkDetail>
      const { previewKind, badge } = linkPreviewBadge({
        previewType: detail.previewType ?? null,
        contentType: detail.contentType ?? null,
      })
      return {
        ...base,
        category: "link",
        url: detail.url ?? row.refId,
        title: detail.title ?? null,
        siteName: detail.siteName ?? null,
        faviconUrl: detail.faviconUrl ?? null,
        imageUrl: detail.imageUrl ?? null,
        previewKind,
        badge,
        refCount: row.occurrenceCount,
      }
    }
    case "media": {
      const detail = row.detail as Partial<StreamContextAttachmentDetail>
      const giphyUrl = detail.giphyUrl ?? (row.refKind === "giphy" ? row.refId : null)
      const attachmentId = detail.attachmentId ?? (row.refKind === "attachment" ? row.refId : null)
      const fallbackKind = giphyUrl ? "gif" : "image"
      const mediaKind =
        detail.mediaKind === "video" || detail.mediaKind === "gif" || detail.mediaKind === "image"
          ? detail.mediaKind
          : fallbackKind
      return {
        ...base,
        category: "media",
        mediaKind,
        attachmentId,
        giphyUrl,
        filename: detail.filename ?? detail.giphyTitle ?? (mediaKind === "gif" ? "GIF" : "Image"),
        ...(detail.width != null ? { width: detail.width } : {}),
        ...(detail.height != null ? { height: detail.height } : {}),
      }
    }
    case "file": {
      const detail = row.detail as Partial<StreamContextAttachmentDetail>
      const attachmentId = detail.attachmentId ?? (row.refKind === "attachment" ? row.refId : null)
      if (!attachmentId) return null
      const mimeType = detail.mimeType ?? "application/octet-stream"
      return {
        ...base,
        category: "file",
        attachmentId,
        fileCategory: categoryFromMime(mimeType),
        mimeType,
        filename: detail.filename ?? "File",
        sizeBytes: detail.sizeBytes ?? 0,
      }
    }
    case "memo": {
      const detail = row.detail as Partial<StreamContextMemoDetail>
      return {
        ...base,
        category: "memo",
        memoId: row.refId,
        title: detail.title ?? row.snippet ?? "Memory",
        knowledgeType: asKnowledgeType(detail.knowledgeType),
        sourceMessageIds: row.sourceMessageId ? [row.sourceMessageId] : [],
      }
    }
    case "delegation": {
      const detail = row.detail as Partial<StreamContextDelegationDetail>
      return {
        ...base,
        category: "delegation",
        delegationId: row.refId,
        title: detail.title ?? row.snippet ?? "Delegated task",
        status: asDelegationStatus(detail.status),
        claimedByLabel: detail.claimedByLabel ?? null,
        statusNote: detail.statusNote ?? null,
        resultMessageId: detail.resultMessageId ?? null,
      }
    }
    case "thread": {
      const detail = row.detail as Partial<StreamContextThreadDetail>
      return {
        ...base,
        category: "thread",
        threadId: row.refId,
        snippet: detail.name ?? row.snippet,
        replyCount: detail.replyCount ?? 0,
        lastReplyPreview: null,
      }
    }
  }
}

function asKnowledgeType(value: string | null | undefined): KnowledgeType {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(value ?? "") ? (value as KnowledgeType) : "context"
}

function asDelegationStatus(value: string | null | undefined): DelegationStatus {
  return (DELEGATION_STATUSES as readonly string[]).includes(value ?? "") ? (value as DelegationStatus) : "open"
}
