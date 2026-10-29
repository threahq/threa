import type { Querier } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { ActivityRepository, type Activity } from "./repository"

/**
 * One `activity:created` outbox event per row, each carrying the target user's absolute unread
 * counts for the row's stream (sync phase 2c): clients set counters from these, never increment,
 * so replays converge. Run after the rows are written so the counts include them. Stream-less rows
 * (standalone saved-item reminders) have no per-stream counts and carry zeros.
 */
export async function insertActivityCreatedEvents(
  client: Querier,
  workspaceId: string,
  activities: Activity[]
): Promise<void> {
  if (activities.length === 0) return
  const counts = await ActivityRepository.countUnreadForPairs(
    client,
    workspaceId,
    activities.flatMap((a) => (a.streamId ? [{ userId: a.userId, streamId: a.streamId }] : []))
  )

  for (const activity of activities) {
    const pairCounts = counts.get(`${activity.userId}:${activity.streamId}`)
    await OutboxRepository.insert(client, "activity:created", {
      workspaceId: activity.workspaceId,
      targetUserId: activity.userId,
      counts: {
        mentionCount: pairCounts?.mentionCount ?? 0,
        activityCount: pairCounts?.totalCount ?? 0,
      },
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
