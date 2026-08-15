import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import type { StreamMember } from "./member-repository"
import type { StreamService } from "./service"

interface ActivityReadService {
  markStreamActivityAsReadInTransaction(
    client: PoolClient,
    userId: string,
    workspaceId: string,
    streamId: string
  ): Promise<void>
}

interface StreamReadServiceDeps {
  pool: Pool
  streamService: StreamService
  activityService: ActivityReadService
}

export class StreamReadService {
  constructor(private readonly deps: StreamReadServiceDeps) {}

  async markAsRead(
    workspaceId: string,
    streamId: string,
    userId: string,
    eventId: string
  ): Promise<StreamMember | null> {
    return withTransaction(this.deps.pool, async (client) => {
      const membership = await this.deps.streamService.markAsReadInTransaction(
        client,
        workspaceId,
        streamId,
        userId,
        eventId
      )
      await this.deps.activityService.markStreamActivityAsReadInTransaction(client, userId, workspaceId, streamId)
      return membership
    })
  }
}
