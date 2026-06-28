import type { Pool } from "pg"
import { withTransaction } from "../../db"
import { linkPreviewId } from "../../lib/id"
import type {
  InAppLinkPreviewData,
  LinkPreviewContentType,
  LinkPreviewSummary,
  MessageLinkPreviewData,
} from "@threa/types"
import { getAvatarUrl } from "@threa/types"
import { LinkPreviewRepository, type LinkPreview, type UpdateLinkPreviewParams } from "./repository"
import { MessageRepository } from "../messaging"
import { UserRepository } from "../workspaces"
import type { StreamService } from "../streams"
import { StreamMemberRepository } from "../streams"
import type { MemoExplorerService } from "../memos"
import { resolveUserAccessibleStreamIds } from "../search"
import { OutboxRepository } from "../../lib/outbox"
import { extractUrls, normalizeUrl, detectContentType, parseInAppLink, type InAppLinkRef } from "./url-utils"
import { MAX_PREVIEWS_PER_MESSAGE, getAppOrigins } from "./config"

const CONTENT_PREVIEW_MAX_LENGTH = 200

export interface LinkPreviewServiceDeps {
  pool: Pool
  streamService: StreamService
  memoExplorerService: MemoExplorerService
}

/**
 * The target columns shared by both resolve entry points: a stored `LinkPreview`
 * row (fields are `string | null`) and a freshly parsed URL (fields optional /
 * `undefined`). The resolvers gate on truthiness, so either shape is safe.
 */
interface InAppLinkTarget {
  targetWorkspaceId?: string | null
  targetStreamId?: string | null
  targetMessageId?: string | null
  targetMemoId?: string | null
}

/**
 * Map a parsed in-app link (or a plain web URL when `ref` is null) to the
 * persisted content type and target columns. Keeps the two insert paths in sync.
 */
function inAppLinkInsertFields(
  ref: InAppLinkRef | null,
  url: string
): {
  contentType: LinkPreviewContentType
  targetWorkspaceId?: string
  targetStreamId?: string
  targetMessageId?: string
  targetMemoId?: string
} {
  if (!ref) return { contentType: detectContentType(url) }
  switch (ref.kind) {
    case "message":
      return {
        contentType: "message_link",
        targetWorkspaceId: ref.workspaceId,
        targetStreamId: ref.streamId,
        targetMessageId: ref.messageId,
      }
    case "stream":
      return {
        contentType: "stream_link",
        targetWorkspaceId: ref.workspaceId,
        targetStreamId: ref.streamId,
      }
    case "memo":
      return {
        contentType: "memo_link",
        targetWorkspaceId: ref.workspaceId,
        targetMemoId: ref.memoId,
      }
  }
}

export class LinkPreviewService {
  constructor(private deps: LinkPreviewServiceDeps) {}

  /**
   * Extract URLs from message content and create pending link preview records.
   * Returns the preview IDs and URLs that need to be fetched.
   * In-app links (message, stream, memo) are detected and marked as completed immediately.
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
        const ref = parseInAppLink(url, appOrigins)

        const preview = await LinkPreviewRepository.insert(client, {
          id: linkPreviewId(),
          workspaceId,
          url,
          normalizedUrl: normalized,
          ...inAppLinkInsertFields(ref, url),
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
        const ref = parseInAppLink(url, appOrigins)

        const preview = await LinkPreviewRepository.insert(client, {
          id: linkPreviewId(),
          workspaceId,
          url,
          normalizedUrl: normalized,
          ...inAppLinkInsertFields(ref, url),
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
   * Resolve an in-app link preview (message, stream, or memo) for a specific viewer.
   * Returns access-tiered data: full content for accessible targets, limited info
   * for private targets, and a minimal card for cross-workspace links. A
   * cross-workspace target is never inspected — same-workspace check happens first
   * so we never leak the existence of another workspace's content.
   */
  async resolveInAppLink(
    workspaceId: string,
    userId: string,
    linkPreviewId: string
  ): Promise<InAppLinkPreviewData | null> {
    const preview = await LinkPreviewRepository.findById(this.deps.pool, workspaceId, linkPreviewId)
    if (!preview) return null
    return this.resolveInAppTarget(workspaceId, userId, preview.contentType, preview)
  }

  /**
   * Resolve an in-app link straight from its URL, for surfaces that have no
   * persisted preview row yet (e.g. the composer rendering a draft as you type).
   * Parses the URL exactly like the post-time extractor, then shares the same
   * per-viewer, access-tiered resolvers as the by-id path. Returns null for any
   * URL that isn't a recognized in-app link.
   */
  async resolveInAppLinkByUrl(workspaceId: string, userId: string, url: string): Promise<InAppLinkPreviewData | null> {
    const ref = parseInAppLink(url, getAppOrigins())
    if (!ref) return null
    const { contentType, ...target } = inAppLinkInsertFields(ref, url)
    return this.resolveInAppTarget(workspaceId, userId, contentType, target)
  }

  private resolveInAppTarget(
    workspaceId: string,
    userId: string,
    contentType: LinkPreviewContentType,
    target: InAppLinkTarget
  ): Promise<InAppLinkPreviewData | null> {
    switch (contentType) {
      case "message_link":
        return this.resolveMessageTarget(workspaceId, userId, target)
      case "stream_link":
        return this.resolveStreamTarget(workspaceId, userId, target)
      case "memo_link":
        return this.resolveMemoTarget(workspaceId, userId, target)
      default:
        return Promise.resolve(null)
    }
  }

  private async resolveMessageTarget(
    workspaceId: string,
    userId: string,
    target: InAppLinkTarget
  ): Promise<MessageLinkPreviewData | null> {
    const { targetWorkspaceId, targetStreamId, targetMessageId } = target
    if (!targetWorkspaceId || !targetStreamId || !targetMessageId) return null

    if (targetWorkspaceId !== workspaceId) {
      return { kind: "message", accessTier: "cross_workspace" }
    }

    // tryAccess returns null for both non-existent and inaccessible streams, so no existence leak.
    const stream = await this.deps.streamService.tryAccess(targetStreamId, workspaceId, userId)
    if (!stream) {
      return { kind: "message", accessTier: "private" }
    }

    // Collapse all failure modes (not found, deleted, wrong stream) into one
    // response to avoid leaking message existence across streams.
    const message = await MessageRepository.findById(this.deps.pool, targetMessageId)
    if (!message || message.deletedAt || message.streamId !== targetStreamId) {
      return { kind: "message", accessTier: "full", deleted: true }
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

    // A DM message reads "{author} to {recipient}", so resolve the non-author
    // participant. DMs are 1:1 in the display model (display-name.ts collapses to
    // "the other participant"). Prefer the member who is neither the author nor
    // the viewer so a non-member author (e.g. a persona) still names the other
    // person; only then fall back to any non-author member.
    let recipientName: string | undefined
    if (stream.type === "dm") {
      const members = await StreamMemberRepository.list(this.deps.pool, { streamId: targetStreamId })
      const recipientId =
        members.find((m) => m.memberId !== message.authorId && m.memberId !== userId)?.memberId ??
        members.find((m) => m.memberId !== message.authorId)?.memberId
      if (recipientId) {
        recipientName = (await UserRepository.findById(this.deps.pool, workspaceId, recipientId))?.name
      }
    }

    const contentPreview =
      message.contentMarkdown.length > CONTENT_PREVIEW_MAX_LENGTH
        ? message.contentMarkdown.slice(0, CONTENT_PREVIEW_MAX_LENGTH) + "…"
        : message.contentMarkdown

    return {
      kind: "message",
      accessTier: "full",
      authorName,
      authorAvatarUrl,
      contentPreview,
      streamName: stream.displayName ?? stream.slug ?? undefined,
      streamType: stream.type,
      recipientName,
    }
  }

  private async resolveStreamTarget(
    workspaceId: string,
    userId: string,
    target: InAppLinkTarget
  ): Promise<InAppLinkPreviewData | null> {
    const { targetWorkspaceId, targetStreamId } = target
    if (!targetWorkspaceId || !targetStreamId) return null

    if (targetWorkspaceId !== workspaceId) {
      return { kind: "stream", accessTier: "cross_workspace" }
    }

    const stream = await this.deps.streamService.tryAccess(targetStreamId, workspaceId, userId)
    if (!stream) {
      return { kind: "stream", accessTier: "private" }
    }

    const description =
      stream.description && stream.description.length > CONTENT_PREVIEW_MAX_LENGTH
        ? stream.description.slice(0, CONTENT_PREVIEW_MAX_LENGTH) + "…"
        : (stream.description ?? undefined)

    return {
      kind: "stream",
      accessTier: "full",
      streamName: stream.displayName ?? stream.slug ?? undefined,
      streamType: stream.type,
      visibility: stream.visibility,
      description,
    }
  }

  private async resolveMemoTarget(
    workspaceId: string,
    userId: string,
    target: InAppLinkTarget
  ): Promise<InAppLinkPreviewData | null> {
    const { targetWorkspaceId, targetMemoId } = target
    if (!targetWorkspaceId || !targetMemoId) return null

    if (targetWorkspaceId !== workspaceId) {
      return { kind: "memo", accessTier: "cross_workspace" }
    }

    // A memo's visibility is inherited from the streams its source messages live in.
    const accessibleStreamIds = await resolveUserAccessibleStreamIds(this.deps.pool, workspaceId, userId, {
      archiveStatus: ["active", "archived"],
    })
    // No accessible streams means no memo is reachable — return the private tier
    // without reading the memo row, matching how the message/stream paths collapse
    // "not found" and "no access" into one response (no existence side-channel).
    if (accessibleStreamIds.length === 0) {
      return { kind: "memo", accessTier: "private" }
    }
    const memo = await this.deps.memoExplorerService.getById(workspaceId, targetMemoId, { accessibleStreamIds })
    if (!memo) {
      return { kind: "memo", accessTier: "private" }
    }

    const abstract =
      memo.memo.abstract.length > CONTENT_PREVIEW_MAX_LENGTH
        ? memo.memo.abstract.slice(0, CONTENT_PREVIEW_MAX_LENGTH) + "…"
        : memo.memo.abstract

    return {
      kind: "memo",
      accessTier: "full",
      title: memo.memo.title,
      abstract,
      knowledgeType: memo.memo.knowledgeType,
      sourceStreamName: memo.sourceStream?.name ?? undefined,
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
