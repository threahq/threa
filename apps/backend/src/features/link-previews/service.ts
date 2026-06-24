import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { linkPreviewId } from "../../lib/id"
import type { LinkPreviewSummary, MessageLinkPreviewData } from "@threa/types"
import { getAvatarUrl } from "@threa/types"
import { LinkPreviewRepository, type LinkPreview, type UpdateLinkPreviewParams } from "./repository"
import { MessageRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import type { StreamService } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { extractUrls, normalizeUrl, detectContentType, parseMessagePermalink } from "./url-utils"
import { MAX_PREVIEWS_PER_MESSAGE, getAppOrigins } from "./config"

const CONTENT_PREVIEW_MAX_LENGTH = 200

export interface LinkPreviewServiceDeps {
  pool: Pool
  streamService: StreamService
}

export class LinkPreviewService {
  constructor(private deps: LinkPreviewServiceDeps) {}

  /**
   * Extract URLs from message content and create pending link preview records.
   * Returns the preview IDs and URLs that need to be fetched.
   * Internal message permalinks are detected and marked as completed immediately.
   */
  async extractAndCreatePending(
    workspaceId: string,
    messageId: string,
    contentMarkdown: string
  ): Promise<Array<{ id: string; url: string }>> {
    const appOrigins = getAppOrigins()
    const urls = extractUrls(contentMarkdown, appOrigins).slice(0, MAX_PREVIEWS_PER_MESSAGE)
    if (urls.length === 0) return []

    return withTransaction(this.deps.pool, async (client) => {
      const results: Array<{ id: string; url: string }> = []

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        const normalized = normalizeUrl(url)
        const permalink = parseMessagePermalink(url, appOrigins)

        const preview = await LinkPreviewRepository.insert(client, {
          id: linkPreviewId(),
          workspaceId,
          url,
          normalizedUrl: normalized,
          contentType: permalink ? "message_link" : detectContentType(url),
          targetWorkspaceId: permalink?.workspaceId,
          targetStreamId: permalink?.streamId,
          targetMessageId: permalink?.messageId,
        })

        await LinkPreviewRepository.linkToMessage(client, workspaceId, messageId, preview.id, i)
        results.push({ id: preview.id, url: preview.url })
      }

      return results
    })
  }

  /**
   * Clears old junction rows then creates pending records for new URLs (INV-6: service owns transaction).
   */
  async replacePreviewsForMessage(
    workspaceId: string,
    messageId: string,
    contentMarkdown: string
  ): Promise<Array<{ id: string; url: string }>> {
    const appOrigins = getAppOrigins()
    const urls = extractUrls(contentMarkdown, appOrigins).slice(0, MAX_PREVIEWS_PER_MESSAGE)

    return withTransaction(this.deps.pool, async (client) => {
      await LinkPreviewRepository.unlinkAllFromMessage(client, workspaceId, messageId)

      if (urls.length === 0) return []

      const results: Array<{ id: string; url: string }> = []

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i]
        const normalized = normalizeUrl(url)
        const permalink = parseMessagePermalink(url, appOrigins)

        const preview = await LinkPreviewRepository.insert(client, {
          id: linkPreviewId(),
          workspaceId,
          url,
          normalizedUrl: normalized,
          contentType: permalink ? "message_link" : detectContentType(url),
          targetWorkspaceId: permalink?.workspaceId,
          targetStreamId: permalink?.streamId,
          targetMessageId: permalink?.messageId,
        })

        await LinkPreviewRepository.linkToMessage(client, workspaceId, messageId, preview.id, i)
        results.push({ id: preview.id, url: preview.url })
      }

      return results
    })
  }

  /**
   * Publish a link_preview:ready event with an empty previews array.
   * Used when an edited message no longer contains any URLs.
   */
  async publishEmptyPreviews(workspaceId: string, streamId: string, messageId: string): Promise<void> {
    await OutboxRepository.insert(this.deps.pool, "link_preview:ready", {
      workspaceId,
      streamId,
      messageId,
      previews: [],
    })
  }

  async isCompleted(workspaceId: string, id: string): Promise<boolean> {
    const existing = await LinkPreviewRepository.findById(this.deps.pool, workspaceId, id)
    return existing?.status === "completed"
  }

  /**
   * Called by the worker after network fetches complete (INV-6: service owns transaction).
   */
  async completePreviewsAndPublish(
    workspaceId: string,
    streamId: string,
    messageId: string,
    fetchResults: Array<{ id: string; metadata?: UpdateLinkPreviewParams; skipped: boolean; overwrite?: boolean }>,
    options?: { forcePublish?: boolean }
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (client) => {
      const completedPreviews: LinkPreviewSummary[] = []
      let hasNewWrites = false

      for (const { id, metadata, skipped, overwrite } of fetchResults) {
        if (skipped) {
          const existing = await LinkPreviewRepository.findById(client, workspaceId, id)
          if (existing?.status === "completed") {
            completedPreviews.push(toLinkPreviewSummary(existing, completedPreviews.length))
          }
          continue
        }

        if (!metadata) continue
        const updated = overwrite
          ? await LinkPreviewRepository.overwriteMetadata(client, workspaceId, id, metadata)
          : await LinkPreviewRepository.updateMetadata(client, workspaceId, id, metadata)
        if (updated && updated.status === "completed") {
          hasNewWrites = true
          completedPreviews.push(toLinkPreviewSummary(updated, completedPreviews.length))
        } else if (!updated) {
          // Row already completed by a concurrent worker (WHERE status='pending' didn't match)
          const existing = await LinkPreviewRepository.findById(client, workspaceId, id)
          if (existing?.status === "completed") {
            completedPreviews.push(toLinkPreviewSummary(existing, completedPreviews.length))
          }
        }
      }

      // Cached previews still need a ready event so the live UI can attach them
      // to newly-created messages without waiting for a bootstrap refresh.
      if (completedPreviews.length > 0) {
        await OutboxRepository.insert(client, "link_preview:ready", {
          workspaceId,
          streamId,
          messageId,
          previews: completedPreviews,
        })
      } else if (completedPreviews.length === 0 && options?.forcePublish) {
        // All fetches failed on an edit — DB junction rows are already cleared,
        // but frontend still shows stale previews. Emit empty set to clear them.
        await OutboxRepository.insert(client, "link_preview:ready", {
          workspaceId,
          streamId,
          messageId,
          previews: [],
        })
      }
    })
  }

  /** Filters out failed/pending previews. */
  async getPreviewsForMessage(workspaceId: string, messageId: string): Promise<LinkPreviewSummary[]> {
    const previews = await LinkPreviewRepository.findByMessageId(this.deps.pool, workspaceId, messageId)
    return previews.filter((p) => p.status === "completed").map((p, i) => toLinkPreviewSummary(p, i))
  }

  async getPreviewsForMessages(workspaceId: string, messageIds: string[]): Promise<Map<string, LinkPreviewSummary[]>> {
    const previewMap = await LinkPreviewRepository.findByMessageIds(this.deps.pool, workspaceId, messageIds)
    const result = new Map<string, LinkPreviewSummary[]>()

    for (const [msgId, previews] of previewMap) {
      const completed = previews.filter((p) => p.status === "completed").map((p, i) => toLinkPreviewSummary(p, i))
      if (completed.length > 0) {
        result.set(msgId, completed)
      }
    }

    return result
  }

  /** Notifies other sessions via outbox (INV-4). */
  async dismiss(workspaceId: string, userId: string, messageId: string, linkPreviewId: string): Promise<void> {
    await withTransaction(this.deps.pool, async (client) => {
      const inserted = await LinkPreviewRepository.dismiss(client, workspaceId, userId, messageId, linkPreviewId)
      if (inserted) {
        await OutboxRepository.insert(client, "link_preview:dismissed", {
          workspaceId,
          authorId: userId,
          messageId,
          linkPreviewId,
        })
      }
    })
  }

  async getDismissals(workspaceId: string, userId: string, messageIds: string[]): Promise<Set<string>> {
    return LinkPreviewRepository.findDismissals(this.deps.pool, workspaceId, userId, messageIds)
  }

  /**
   * Resolve a message link preview for a specific viewer.
   * Returns access-tiered data: full content for accessible messages,
   * limited info for private/cross-workspace messages.
   */
  async resolveMessageLink(
    workspaceId: string,
    userId: string,
    linkPreviewId: string
  ): Promise<MessageLinkPreviewData | null> {
    const preview = await LinkPreviewRepository.findById(this.deps.pool, workspaceId, linkPreviewId)
    if (!preview || preview.contentType !== "message_link") return null

    const { targetWorkspaceId, targetStreamId, targetMessageId } = preview
    if (!targetWorkspaceId || !targetStreamId || !targetMessageId) return null

    // Cross-workspace: minimal info — intentionally does NOT check if target workspace exists
    // to avoid leaking workspace existence.
    if (targetWorkspaceId !== workspaceId) {
      return { accessTier: "cross_workspace" }
    }

    // Same workspace — check stream access. tryAccess returns null for both
    // non-existent and inaccessible streams, so no existence leak.
    const stream = await this.deps.streamService.tryAccess(targetStreamId, workspaceId, userId)
    if (!stream) {
      return { accessTier: "private" }
    }

    // Full access — look up message and verify it belongs to this stream.
    // Collapse all failure modes (not found, deleted, wrong stream) into the same
    // response to avoid leaking message existence across streams.
    const message = await MessageRepository.findById(this.deps.pool, targetMessageId)
    if (!message || message.deletedAt || message.streamId !== targetStreamId) {
      return { accessTier: "full", deleted: true }
    }

    let authorName: string | undefined
    let authorAvatarUrl: string | undefined
    if (message.authorType === "user") {
      const user = await UserRepository.findById(this.deps.pool, workspaceId, message.authorId)
      if (user) {
        authorName = user.name
        authorAvatarUrl = getAvatarUrl(workspaceId, user.avatarUrl, 64) ?? undefined
      }
    }

    const contentPreview =
      message.contentMarkdown.length > CONTENT_PREVIEW_MAX_LENGTH
        ? message.contentMarkdown.slice(0, CONTENT_PREVIEW_MAX_LENGTH) + "…"
        : message.contentMarkdown

    return {
      accessTier: "full",
      authorName,
      authorAvatarUrl,
      contentPreview,
      streamName: stream.displayName ?? stream.slug ?? undefined,
    }
  }

  async getPreviewById(workspaceId: string, linkPreviewId: string): Promise<LinkPreview | null> {
    return LinkPreviewRepository.findById(this.deps.pool, workspaceId, linkPreviewId)
  }
}

export function toLinkPreviewSummary(preview: LinkPreview, position: number): LinkPreviewSummary {
  return {
    id: preview.id,
    url: preview.url,
    title: preview.title,
    description: preview.description,
    imageUrl: preview.imageUrl,
    faviconUrl: preview.faviconUrl,
    siteName: preview.siteName,
    contentType: preview.contentType,
    previewType: preview.previewType,
    previewData: preview.previewData,
    position,
  }
}
