import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import type { StreamReadFrontierSnapshot } from "@threahq/types"
import type { MarkAsReadResult, StreamService } from "./service"
import { StreamEventRepository } from "./event-repository"

interface ActivityReadService {
  markStreamActivityAsReadInTransaction(
    client: PoolClient,
    userId: string,
    workspaceId: string,
    streamId: string
  ): Promise<void>
  markStreamsAsReadInTransaction(
    client: PoolClient,
    userId: string,
    workspaceId: string,
    streamIds: string[]
  ): Promise<void>
}

interface StreamReadServiceDeps {
  pool: Pool
  streamService: StreamService
  activityService: ActivityReadService
}

/** The read frontier target: a stream event id, or a message id resolved to its message_created event. */
export type MarkAsReadTarget = { eventId: string } | { messageId: string }

export class StreamReadService {
  constructor(private readonly deps: StreamReadServiceDeps) {}

  async markAsRead(
    workspaceId: string,
    streamId: string,
    userId: string,
    target: MarkAsReadTarget
  ): Promise<MarkAsReadResult> {
    return withTransaction(this.deps.pool, async (client) => {
      const eventId =
        "eventId" in target
          ? target.eventId
          : ((await StreamEventRepository.findByMessageId(client, streamId, target.messageId))?.id ?? target.messageId)
      const result = await this.deps.streamService.markAsReadInTransaction(
        client,
        workspaceId,
        streamId,
        userId,
        eventId
      )
      await this.deps.activityService.markStreamActivityAsReadInTransaction(client, userId, workspaceId, streamId)
      return result
    })
  }

  /**
   * Clear streams from the user's Inbox: read each accessible one to latest,
   * drop its hold, and mark its activity read, all in one transaction so a
   * failure leaves no stream half-cleared. Activity covers every accessible
   * stream, not just advanced ones: a caught-up stream can still carry an
   * unread mention.
   */
  async clearInbox(
    workspaceId: string,
    userId: string,
    streamIds: string[]
  ): Promise<{ clearedStreamIds: string[]; frontiers: StreamReadFrontierSnapshot[] }> {
    return withTransaction(this.deps.pool, async (client) => {
      const { accessibleStreamIds, clearedStreamIds, frontiers } =
        await this.deps.streamService.clearInboxInTransaction(client, workspaceId, userId, streamIds)
      await this.deps.activityService.markStreamsAsReadInTransaction(client, userId, workspaceId, accessibleStreamIds)
      return { clearedStreamIds, frontiers }
    })
  }
}
