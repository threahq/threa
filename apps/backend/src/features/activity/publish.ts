import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import type { Activity } from "./repository"

/** One `activity:created` outbox event per row. */
export async function insertActivityCreatedEvents(client: Querier, activities: Activity[]): Promise<void> {
  for (const activity of activities) {
    await OutboxRepository.insert(client, "activity:created", {
      workspaceId: activity.workspaceId,
      targetUserId: activity.userId,
      activity: {
        id: activity.id,
        activityType: activity.activityType,
        streamId: activity.streamId,
        messageId: activity.messageId,
        actorId: activity.actorId,
        actorType: activity.actorType,
        context: activity.context,
        createdAt: activity.createdAt.toISOString(),
        isSelf: activity.isSelf,
        emoji: activity.emoji,
      },
    })
  }
}
