import type { Pool } from "pg"
import {
  OutboxRepository,
  type ReactionOutboxPayload,
  type SavedReminderFiredOutboxPayload,
  type StreamMemberAddedOutboxPayload,
} from "../../lib/outbox"
import { parseMessagePayload } from "../../lib/outbox"
import { AuthorTypes } from "@threa/types"
import { logger } from "../../lib/logger"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "../../lib/outbox"
import type { ActivityService } from "./service"
import { ActivityRepository, type Activity } from "./repository"
import { withTransaction } from "../../db"
import { E2eStreamsRepository } from "../e2e-streams"

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Builds the activity feed from message + reaction events.
 *
 * For message:created, it creates mention rows, thread-activity rows, and a
 * self row for the author (so they see their own messages in the Me feed).
 *
 * For reaction:added, it creates a notification row for the message author
 * (thread-activity tier, common-case semantics: only the author is pinged,
 * not every stream watcher) and a self row for the reactor.
 *
 * For reaction:removed, it deletes the rows created by the matching add.
 *
 * Every created/removed activity is echoed as an activity:created outbox
 * event so connected clients update live. Self rows carry `isSelf: true`
 * in that payload so downstream consumers (push service, frontend unread
 * counters) skip them.
 */
export class ActivityFeedHandler implements OutboxHandler {
  readonly listenerId = "activity-feed"

  private readonly db: Pool
  private readonly activityService: ActivityService
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, activityService: ActivityService) {
    this.db = db
    this.activityService = activityService
    this.batchSize = DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      DEFAULT_CONFIG.debounceMs,
      DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "ActivityFeedHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.db, this.listenerId)
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.db, cursor, this.batchSize, processedIds)

      if (events.length === 0) {
        return { status: "no_events" }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          if (event.eventType === "message:created") {
            const activities = await this.processMessageCreated(event)
            await this.publishActivityCreated(activities)
          } else if (event.eventType === "reaction:added") {
            const activities = await this.processReactionAdded(event)
            await this.publishActivityCreated(activities)
          } else if (event.eventType === "reaction:removed") {
            // Removed rows don't currently emit a compensating event —
            // frontend subscribers detect stale entries on next fetch.
            await this.processReactionRemoved(event)
          } else if (event.eventType === "saved_reminder:fired") {
            const activities = await this.processSavedReminderFired(event)
            await this.publishActivityCreated(activities)
          } else if (event.eventType === "stream:member_added") {
            const activities = await this.processMemberAdded(event)
            await this.publishActivityCreated(activities)
          }

          seen.push(event.id)
        }

        return { status: "processed", processedIds: seen }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))

        if (seen.length > 0) {
          return { status: "error", error, processedIds: seen }
        }

        return { status: "error", error }
      }
    })
  }

  private async processMessageCreated(event: { id: bigint; payload: unknown }): Promise<Activity[]> {
    const payload = parseMessagePayload(event.payload)
    if (!payload) {
      logger.debug({ eventId: event.id.toString() }, "ActivityFeedHandler: malformed message event, skipping")
      return []
    }

    const { streamId, workspaceId, event: messageEvent } = payload

    // E2E streams: mention detection runs against ciphertext (useless) and
    // the activity feed isn't the unread surface for E2E DMs. Short-circuit.
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, streamId)) return []

    // Skip system-authored messages (join/leave notices etc.) — no meaningful
    // content for mention detection or notification-level activity. Member and
    // persona messages both get processed: agents can @mention people and their
    // messages should surface in the activity feed based on notification levels.
    if (messageEvent.actorType === AuthorTypes.SYSTEM) return []
    if (!messageEvent.actorId) return []

    const common = {
      workspaceId,
      streamId,
      messageId: messageEvent.payload.messageId,
      actorId: messageEvent.actorId,
      actorType: messageEvent.actorType,
      contentMarkdown: messageEvent.payload.contentMarkdown,
    }

    // Sequential: mentions first, then notification-level activities.
    // A mentioned user gets a "mention" activity (more specific) instead of both
    // "mention" + "message". The dedup index allows both types per message, so we
    // exclude mentioned users explicitly rather than relying on the DB constraint.
    const mentionActivities = await this.activityService.processMessageMentions(common)
    const mentionedUserIds = new Set(mentionActivities.map((a) => a.userId))

    const notificationActivities = await this.activityService.processMessageNotifications({
      ...common,
      excludeUserIds: mentionedUserIds,
    })

    // Self-row for the message author so they can find their own messages in
    // the Me feed. Inserted already read — no unread, no push.
    const selfActivity = await this.activityService.processSelfMessageActivity(common)

    const all: Activity[] = [...mentionActivities, ...notificationActivities]
    if (selfActivity) all.push(selfActivity)
    return all
  }

  private async processReactionAdded(event: { id: bigint; payload: unknown }): Promise<Activity[]> {
    const payload = event.payload as ReactionOutboxPayload
    if (
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.streamId !== "string" ||
      typeof payload.messageId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.emoji !== "string"
    ) {
      logger.debug({ eventId: event.id.toString() }, "ActivityFeedHandler: malformed reaction:added event, skipping")
      return []
    }

    // E2E streams: reactions on E2E messages don't surface in the activity
    // feed in Phase 1.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return []
    }

    return this.activityService.processReactionAdded({
      workspaceId: payload.workspaceId,
      streamId: payload.streamId,
      messageId: payload.messageId,
      emoji: payload.emoji,
      actorId: payload.userId,
      actorType: payload.actorType ?? AuthorTypes.USER,
    })
  }

  private async processSavedReminderFired(event: { id: bigint; payload: unknown }): Promise<Activity[]> {
    const payload = event.payload as SavedReminderFiredOutboxPayload
    // Standalone (message-less) saved items legitimately carry null
    // messageId/streamId — only reject when the fields are absent entirely.
    if (
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.targetUserId !== "string" ||
      typeof payload.savedId !== "string" ||
      payload.messageId === undefined ||
      payload.streamId === undefined
    ) {
      logger.debug(
        { eventId: event.id.toString() },
        "ActivityFeedHandler: malformed saved_reminder:fired event, skipping"
      )
      return []
    }
    // E2E streams: never surface ciphertext previews in the activity feed.
    if (payload.streamId && (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId))) {
      return []
    }

    // Standalone items preview their own title; message saves preview the
    // live message content.
    const contentPreview = payload.saved?.message?.contentMarkdown?.slice(0, 200) ?? payload.saved?.title ?? null
    const streamName = payload.saved?.message?.streamName ?? null
    return this.activityService.processSavedReminderFired({
      workspaceId: payload.workspaceId,
      userId: payload.targetUserId,
      savedId: payload.savedId,
      streamId: payload.streamId,
      messageId: payload.messageId,
      contentPreview,
      streamName,
    })
  }

  private async processMemberAdded(event: { id: bigint; payload: unknown }): Promise<Activity[]> {
    const payload = event.payload as StreamMemberAddedOutboxPayload
    if (
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.streamId !== "string" ||
      typeof payload.memberId !== "string" ||
      !payload.event
    ) {
      logger.debug(
        { eventId: event.id.toString() },
        "ActivityFeedHandler: malformed stream:member_added event, skipping"
      )
      return []
    }

    // E2E streams: member-added activity is delivered through the stream
    // bootstrap path, not the activity feed, for E2E participants.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return []
    }

    return this.activityService.processMemberAdded({
      workspaceId: payload.workspaceId,
      streamId: payload.streamId,
      memberId: payload.memberId,
      event: payload.event,
    })
  }

  private async processReactionRemoved(event: { id: bigint; payload: unknown }): Promise<void> {
    const payload = event.payload as ReactionOutboxPayload
    if (
      !payload ||
      typeof payload.workspaceId !== "string" ||
      typeof payload.messageId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.emoji !== "string"
    ) {
      logger.debug({ eventId: event.id.toString() }, "ActivityFeedHandler: malformed reaction:removed event, skipping")
      return
    }

    // E2E streams: nothing to remove because we never inserted activity
    // rows for E2E reactions in the first place.
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) {
      return
    }

    await this.activityService.processReactionRemoved({
      workspaceId: payload.workspaceId,
      messageId: payload.messageId,
      actorId: payload.userId,
      emoji: payload.emoji,
    })
  }

  /**
   * Publish an activity:created outbox event for each activity row. Grouped in
   * one transaction per call to keep outbox writes batched.
   *
   * Each payload carries the target user's absolute unread counts for the
   * stream (sync-v2 phase 2c): clients set counters from these instead of
   * incrementing, so replayed/duplicated events converge. The activity rows
   * are committed before this runs, so the counts include them; rows sharing
   * a (user, stream) pair carry identical final counts, which is correct
   * under absolute semantics.
   */
  private async publishActivityCreated(activities: Activity[]): Promise<void> {
    if (activities.length === 0) return

    await withTransaction(this.db, async (client) => {
      // Activities from one source event share a workspace, but group
      // defensively rather than assume it.
      const byWorkspace = new Map<string, Activity[]>()
      for (const activity of activities) {
        const group = byWorkspace.get(activity.workspaceId) ?? []
        group.push(activity)
        byWorkspace.set(activity.workspaceId, group)
      }

      for (const [workspaceId, group] of byWorkspace) {
        // Stream-less rows (standalone saved-item reminders) have no
        // per-stream unread counts; their lookup below misses and falls back
        // to zeros, which is correct — there's no stream badge to update.
        const counts = await ActivityRepository.countUnreadForPairs(
          client,
          workspaceId,
          group.flatMap((a) => (a.streamId ? [{ userId: a.userId, streamId: a.streamId }] : []))
        )

        for (const activity of group) {
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
            },
          })
        }
      }
    })
  }
}
