import type { Pool, PoolClient } from "pg"
import { ActivityRepository, type Activity } from "./repository"
import { UserRepository } from "../workspaces"
import { StreamRepository, StreamMemberRepository, resolveNotificationLevelsForStream, type Stream } from "../streams"
import { extractMentionSlugs, PersonaRepository } from "../agents"
import { BotRepository } from "../public-api"
import { MessageRepository } from "../messaging"
import {
  Visibilities,
  NotificationLevels,
  StreamTypes,
  AuthorTypes,
  ActivityTypes,
  isBroadcastSlug,
} from "@threa/types"
import { withClient } from "../../db"
import { logger } from "../../lib/logger"

interface ActivityServiceDeps {
  pool: Pool
}

export class ActivityService {
  private readonly pool: Pool

  constructor(deps: ActivityServiceDeps) {
    this.pool = deps.pool
  }

  async processMessageMentions(params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    actorType: string
    contentMarkdown: string
  }): Promise<Activity[]> {
    const { workspaceId, streamId, messageId, actorId, actorType, contentMarkdown } = params

    const mentionSlugs = extractMentionSlugs(contentMarkdown)
    if (mentionSlugs.length === 0) return []

    // Partition into broadcast (@channel, @here) and user slugs
    const broadcastSlugs = mentionSlugs.filter(isBroadcastSlug)
    const userSlugs = mentionSlugs.filter((s) => !isBroadcastSlug(s))

    return withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream || stream.workspaceId !== workspaceId) return []

      // Fetch root stream once — reused by access checks, broadcast resolution, and context
      const rootStream = stream.rootStreamId ? await StreamRepository.findById(client, stream.rootStreamId) : null

      // Resolve the effective stream type for broadcast validation:
      // threads inherit their root stream's type for @channel/@here eligibility
      const effectiveType = rootStream?.type ?? stream.type

      // 1. Resolve direct @user mentions
      const userIds = new Set<string>()
      if (userSlugs.length > 0) {
        const users = await UserRepository.findBySlugs(client, workspaceId, userSlugs)
        const candidates = users.filter((u) => u.id !== actorId)
        if (candidates.length > 0) {
          const eligible = await this.filterByAccess(
            client,
            stream,
            rootStream,
            candidates.map((u) => u.id)
          )
          for (const u of candidates) {
            if (eligible.has(u.id)) userIds.add(u.id)
          }
        }
      }

      // 2. Resolve broadcast mentions to member lists
      if (broadcastSlugs.length > 0) {
        const broadcastUserIds = await this.resolveBroadcastTargets(
          client,
          broadcastSlugs,
          stream,
          rootStream,
          effectiveType
        )
        for (const id of broadcastUserIds) {
          userIds.add(id)
        }
      }

      // Exclude the actor
      userIds.delete(actorId)
      if (userIds.size === 0) return []

      const streamContext = resolveStreamContext(stream, rootStream)
      const contentPreview = contentMarkdown.slice(0, 200)
      const authorName = await this.resolveAuthorName(client, workspaceId, actorId, actorType)

      return ActivityRepository.insertBatch(client, {
        workspaceId,
        userIds: [...userIds],
        activityType: ActivityTypes.MENTION,
        streamId,
        messageId,
        actorId,
        actorType,
        context: { contentPreview, authorName, ...streamContext },
      })
    })
  }

  /**
   * Create a self-activity row for the actor's own message, if the actor is a
   * workspace user. Self rows are inserted already read so the user sees their
   * own activity in the feed without inflating unread counts or triggering push.
   */
  async processSelfMessageActivity(params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    actorType: string
    contentMarkdown: string
  }): Promise<Activity | null> {
    const { workspaceId, streamId, messageId, actorId, actorType, contentMarkdown } = params

    // Only user actors see their own activity — bots and personas don't have an Activity UI.
    if (actorType !== AuthorTypes.USER) return null

    return withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream || stream.workspaceId !== workspaceId) return null

      const rootStream = stream.rootStreamId ? await StreamRepository.findById(client, stream.rootStreamId) : null
      const streamContext = resolveStreamContext(stream, rootStream)
      const contentPreview = contentMarkdown.slice(0, 200)
      const authorName = await this.resolveAuthorName(client, workspaceId, actorId, actorType)

      const rows = await ActivityRepository.insertBatch(client, {
        workspaceId,
        userIds: [actorId],
        activityType: ActivityTypes.MESSAGE,
        streamId,
        messageId,
        actorId,
        actorType,
        context: { contentPreview, authorName, ...streamContext },
        isSelf: true,
      })

      return rows[0] ?? null
    })
  }

  /**
   * Resolve broadcast mention slugs (@channel, @here) to target user IDs.
   *
   * @channel — notifies all members of the root channel (or the channel itself if not in a thread).
   *            Only valid in channel-tree streams.
   * @here    — notifies direct members of the current stream.
   *            Valid in channel-tree and DM-tree streams.
   */
  private async resolveBroadcastTargets(
    client: PoolClient,
    broadcastSlugs: string[],
    stream: Stream,
    rootStream: Stream | null,
    effectiveType: string
  ): Promise<Set<string>> {
    const targetIds = new Set<string>()
    const memberCache = new Map<string, { memberId: string }[]>()

    const getMembers = async (streamId: string) => {
      if (!memberCache.has(streamId)) {
        memberCache.set(streamId, await StreamMemberRepository.list(client, { streamId }))
      }
      return memberCache.get(streamId)!
    }

    for (const slug of broadcastSlugs) {
      if (slug === "channel") {
        // @channel only valid in channel-tree streams
        if (effectiveType !== StreamTypes.CHANNEL) continue

        // Target: all members of the root channel (walk up from thread if needed)
        const channelId = rootStream?.id ?? stream.id
        const members = await getMembers(channelId)
        for (const m of members) targetIds.add(m.memberId)
      } else if (slug === "here") {
        // @here valid in channel-tree and DM-tree streams
        if (effectiveType !== StreamTypes.CHANNEL && effectiveType !== StreamTypes.DM) continue

        // Target: direct members of the current stream
        const members = await getMembers(stream.id)
        for (const m of members) targetIds.add(m.memberId)
      }
    }

    return targetIds
  }

  async processMessageNotifications(params: {
    workspaceId: string
    streamId: string
    messageId: string
    actorId: string
    actorType: string
    contentMarkdown: string
    excludeUserIds: Set<string>
  }): Promise<Activity[]> {
    const { workspaceId, streamId, messageId, actorId, actorType, contentMarkdown, excludeUserIds } = params

    return withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream || stream.workspaceId !== workspaceId) return []

      const streamMembers = await StreamMemberRepository.list(client, { streamId })
      if (streamMembers.length === 0) return []

      // DMs and scratchpads are direct communication — create activities for all
      // non-muted members (more permissive than channels which require ACTIVITY/EVERYTHING).
      const isDirectStream = stream.type === StreamTypes.DM || stream.type === StreamTypes.SCRATCHPAD

      // Fetch root stream once for context
      const rootStream = stream.rootStreamId ? await StreamRepository.findById(client, stream.rootStreamId) : null

      const streamContext = resolveStreamContext(stream, rootStream)
      const contentPreview = contentMarkdown.slice(0, 200)
      const authorName = await this.resolveAuthorName(client, workspaceId, actorId, actorType)

      const resolved = await resolveNotificationLevelsForStream(client, stream, streamMembers)
      const eligibleUserIds = resolved
        .filter((row) => {
          if (row.memberId === actorId) return false
          if (excludeUserIds.has(row.memberId)) return false
          if (isDirectStream) {
            return row.effectiveLevel !== NotificationLevels.MUTED
          }
          return (
            row.effectiveLevel === NotificationLevels.ACTIVITY || row.effectiveLevel === NotificationLevels.EVERYTHING
          )
        })
        .map((row) => row.memberId)

      return ActivityRepository.insertBatch(client, {
        workspaceId,
        userIds: eligibleUserIds,
        activityType: ActivityTypes.MESSAGE,
        streamId,
        messageId,
        actorId,
        actorType,
        context: { contentPreview, authorName, ...streamContext },
      })
    })
  }

  /**
   * Create a "reaction" activity for the author of the reacted-to message.
   * Semantics mirror Slack/Discord: reactions notify the original author only,
   * not every stream watcher. Notifications respect the author's per-stream
   * notification level (ACTIVITY/EVERYTHING for channels, non-MUTED for direct).
   *
   * Also creates a self-row for the reactor so they can see their own reactions
   * in the Me feed.
   *
   * Returns both rows so the outbox handler can publish activity:created events.
   */
  async processReactionAdded(params: {
    workspaceId: string
    streamId: string
    messageId: string
    emoji: string
    actorId: string
    actorType: string
  }): Promise<Activity[]> {
    const { workspaceId, streamId, messageId, emoji, actorId, actorType } = params

    return withClient(this.pool, async (client) => {
      const message = await MessageRepository.findById(client, messageId)
      if (!message) return []

      const stream = await StreamRepository.findById(client, streamId)
      if (!stream || stream.workspaceId !== workspaceId) return []

      const rootStream = stream.rootStreamId ? await StreamRepository.findById(client, stream.rootStreamId) : null
      const streamContext = resolveStreamContext(stream, rootStream)
      const contentPreview = (message.contentMarkdown ?? "").slice(0, 200)
      const actorName = await this.resolveAuthorName(client, workspaceId, actorId, actorType)

      const context = {
        contentPreview,
        authorName: actorName,
        emoji,
        ...streamContext,
      }

      const activities: Activity[] = []

      // 1. Notify the message author — only for workspace users, and only if
      // they're not the reactor. Resolve via their actual stream membership so
      // explicit per-stream levels and ancestor inheritance are honored.
      if (message.authorType === AuthorTypes.USER && message.authorId && message.authorId !== actorId) {
        const authorMember = await StreamMemberRepository.findByStreamAndMember(client, streamId, message.authorId)
        if (authorMember) {
          const isDirectStream = stream.type === StreamTypes.DM || stream.type === StreamTypes.SCRATCHPAD
          const resolved = await resolveNotificationLevelsForStream(client, stream, [authorMember])
          const level = resolved[0]?.effectiveLevel
          const shouldNotify =
            level !== undefined &&
            (isDirectStream
              ? level !== NotificationLevels.MUTED
              : level === NotificationLevels.ACTIVITY || level === NotificationLevels.EVERYTHING)

          if (shouldNotify) {
            const authorRows = await ActivityRepository.insertBatch(client, {
              workspaceId,
              userIds: [message.authorId],
              activityType: ActivityTypes.REACTION,
              streamId,
              messageId,
              actorId,
              actorType,
              context,
              emoji,
            })
            activities.push(...authorRows)
          }
        }
      }

      // 2. Self-row for the reactor (for the Me feed). Only workspace users have
      // a Me feed — personas/bots react without one, so skip the self-row for
      // non-user reactors (the author notification above still fires so the
      // human whose message was reacted to sees it).
      if (actorType === AuthorTypes.USER) {
        const selfRows = await ActivityRepository.insertBatch(client, {
          workspaceId,
          userIds: [actorId],
          activityType: ActivityTypes.REACTION,
          streamId,
          messageId,
          actorId,
          actorType,
          context,
          isSelf: true,
          emoji,
        })
        activities.push(...selfRows)
      }

      return activities
    })
  }

  /**
   * Remove the reaction activity rows that `processReactionAdded` created for
   * this exact (message, actor, emoji) triple. Other reactions from the same
   * actor on the same message are left intact.
   */
  async processReactionRemoved(params: {
    workspaceId: string
    messageId: string
    actorId: string
    emoji: string
  }): Promise<Activity[]> {
    return ActivityRepository.deleteReactionForEmoji(this.pool, params)
  }

  /**
   * Create an activity row when a saved-message reminder fires. The payload
   * already carries a resolved `SavedMessageView` so we can build the context
   * without additional DB lookups.
   *
   * Each save-then-remind lifecycle must produce its own feed row — saving,
   * firing, dismissing, re-saving, and re-firing the same message should not
   * silently upsert the older row. The dedup index explicitly excludes
   * `saved_reminder` (see migration 20260417200220) so the repository emits a
   * plain INSERT and every fire mints a distinct row. Single-delivery per
   * savedId is enforced at the service boundary via `reminder_sent_at IS NULL`.
   *
   * The savedId is stashed in `context` so the feed can link back to the
   * specific saved row if we ever want to.
   */
  async processSavedReminderFired(params: {
    workspaceId: string
    userId: string
    savedId: string
    streamId: string
    messageId: string
    contentPreview: string | null
    streamName: string | null
  }): Promise<Activity[]> {
    const context: Record<string, unknown> = {
      savedId: params.savedId,
      contentPreview: params.contentPreview ?? "",
      streamName: params.streamName,
    }
    const row = await ActivityRepository.insert(this.pool, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      activityType: ActivityTypes.SAVED_REMINDER,
      streamId: params.streamId,
      messageId: params.messageId,
      actorId: AuthorTypes.SYSTEM,
      actorType: AuthorTypes.SYSTEM,
      context,
    })
    return row ? [row] : []
  }

  /**
   * Batch-check which user IDs have access to a stream.
   * Public streams: all pass. Private: single batch membership query.
   */
  private async filterByAccess(
    client: PoolClient,
    stream: Stream,
    rootStream: Stream | null,
    userIds: string[]
  ): Promise<Set<string>> {
    if (stream.rootStreamId) {
      if (!rootStream) return new Set()
      if (rootStream.visibility === Visibilities.PUBLIC) return new Set(userIds)
      return StreamMemberRepository.filterMemberIds(client, rootStream.id, userIds)
    }

    if (stream.visibility === Visibilities.PUBLIC) return new Set(userIds)
    return StreamMemberRepository.filterMemberIds(client, stream.id, userIds)
  }

  private async resolveAuthorName(
    client: PoolClient,
    workspaceId: string,
    actorId: string,
    actorType: string
  ): Promise<string | null> {
    switch (actorType) {
      case AuthorTypes.USER: {
        const user = await UserRepository.findById(client, workspaceId, actorId)
        return user?.name ?? null
      }
      case AuthorTypes.BOT: {
        const bot = await BotRepository.findById(client, workspaceId, actorId)
        return bot?.name ?? null
      }
      case AuthorTypes.PERSONA: {
        const persona = await PersonaRepository.findById(client, actorId, workspaceId)
        return persona?.name ?? null
      }
      case AuthorTypes.SYSTEM:
        return "Threa"
      default:
        return null
    }
  }

  /**
   * Create a member_added activity for a user who was added to a stream.
   * Behaves like a mention in the activity feed but does not trigger push.
   * Skipped for bot additions: bots don't consume the activity feed, so a
   * row keyed to a bot ID would be dead data.
   */
  async processMemberAdded(params: {
    workspaceId: string
    streamId: string
    memberId: string
    event: { id: string; payload: unknown; actorType?: string | null }
  }): Promise<Activity[]> {
    const { workspaceId, streamId, memberId, event } = params

    if (event.actorType === "bot") return []

    const addedBy =
      typeof event.payload === "object" && event.payload !== null && "addedBy" in event.payload
        ? (event.payload as Record<string, unknown>).addedBy
        : null

    if (typeof addedBy !== "string") {
      logger.warn({ eventId: event.id }, "processMemberAdded: missing addedBy, skipping")
      return []
    }

    return withClient(this.pool, async (client) => {
      const stream = await StreamRepository.findById(client, streamId)
      if (!stream || stream.workspaceId !== workspaceId) return []

      const rootStream = stream.rootStreamId ? await StreamRepository.findById(client, stream.rootStreamId) : null
      const streamContext = resolveStreamContext(stream, rootStream)
      const actorName = await this.resolveAuthorName(client, workspaceId, addedBy, AuthorTypes.USER)

      const rows = await ActivityRepository.insertBatch(client, {
        workspaceId,
        userIds: [memberId],
        activityType: ActivityTypes.MEMBER_ADDED,
        streamId,
        messageId: event.id,
        actorId: addedBy,
        actorType: AuthorTypes.USER,
        context: { authorName: actorName, ...streamContext },
      })

      return rows
    })
  }

  async listFeed(
    userId: string,
    workspaceId: string,
    opts?: { limit?: number; cursor?: string; unreadOnly?: boolean; mineOnly?: boolean; othersOnly?: boolean }
  ) {
    return ActivityRepository.listByUser(this.pool, userId, workspaceId, opts)
  }

  async getUnreadCounts(
    userId: string,
    workspaceId: string
  ): Promise<{ mentionsByStream: Map<string, number>; totalByStream: Map<string, number>; total: number }> {
    return ActivityRepository.countUnreadGrouped(this.pool, userId, workspaceId)
  }

  async getUnreadCountsForStream(
    userId: string,
    workspaceId: string,
    streamId: string
  ): Promise<{ mentionCount: number; totalCount: number }> {
    return ActivityRepository.countUnreadForStream(this.pool, userId, workspaceId, streamId)
  }

  async markAsRead(activityId: string, userId: string): Promise<void> {
    await ActivityRepository.markAsRead(this.pool, activityId, userId)
  }

  async markStreamActivityAsRead(userId: string, streamId: string): Promise<void> {
    const count = await ActivityRepository.markStreamAsRead(this.pool, userId, streamId)
    if (count > 0) {
      logger.debug({ userId, streamId, count }, "Marked stream activity as read")
    }
  }

  async markAllAsRead(userId: string, workspaceId: string): Promise<void> {
    const count = await ActivityRepository.markAllAsRead(this.pool, userId, workspaceId)
    if (count > 0) {
      logger.debug({ userId, workspaceId, count }, "Marked all activity as read")
    }
  }
}

function resolveStreamName(stream: Stream): string | null {
  if (stream.type === StreamTypes.CHANNEL && stream.slug) return `#${stream.slug}`
  return stream.displayName ?? null
}

interface StreamContext {
  streamName: string | null
  rootStreamId?: string
  parentStreamName?: string | null
}

function resolveStreamContext(stream: Stream, rootStream: Stream | null): StreamContext {
  if (!stream.rootStreamId) return { streamName: resolveStreamName(stream) }

  return {
    streamName: resolveStreamName(stream),
    rootStreamId: stream.rootStreamId,
    parentStreamName: rootStream ? resolveStreamName(rootStream) : undefined,
  }
}
