import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, TitleSources } from "@threahq/types"
import { logger } from "../../lib/logger"
import { isOutboxEventType, parseMessagePayload } from "../../lib/outbox"
import { DebouncedOutboxHandler, type DebouncedOutboxHandlerConfig, type OutboxEvent } from "../../lib/outbox"
import { JobQueues, type QueueManager } from "../../lib/queue"
import { ConversationRepository } from "../conversations"
import { E2eStreamsRepository } from "../e2e-streams"
import { StreamRepository } from "../streams"
import { MessageRepository } from "../messaging"
import { DYNAMIC_NAMING_QUIET_MS } from "./config"
import { DynamicNamingStateRepository } from "./state-repository"
import type { DynamicNamingService } from "./service"
import type { DynamicNamingJobScheduler, DynamicNamingTargetKind } from "./types"

export class QueueDynamicNamingScheduler implements DynamicNamingJobScheduler {
  constructor(private readonly queue: QueueManager) {}

  async schedule(
    data: { workspaceId: string; targetKind: DynamicNamingTargetKind; targetId: string },
    processAfter?: Date
  ): Promise<void> {
    await this.queue.send(JobQueues.DYNAMIC_NAMING_EVALUATE, data, { processAfter })
  }
}

export class DynamicNamingOutboxHandler extends DebouncedOutboxHandler {
  constructor(
    pool: Pool,
    private readonly scheduler: DynamicNamingJobScheduler,
    private readonly lifecycle?: Pick<DynamicNamingService, "recordStructuralEvent">,
    config?: DebouncedOutboxHandlerConfig
  ) {
    super(pool, { listenerId: "dynamic-naming", ...config })
  }

  protected async processBatch(events: OutboxEvent[]): Promise<bigint[]> {
    const requested = new Map<string, OutboxEvent>()
    const ordinary = new Map<string, OutboxEvent>()
    const structural = new Map<
      string,
      {
        ref: { workspaceId: string; targetKind: "conversation"; targetId: string }
        eventId: bigint
        messageId: string
        initiatingUserId?: string
      }
    >()
    for (const event of events) {
      if (isOutboxEventType(event, "dynamic_naming:requested")) {
        requested.set(`${event.payload.workspaceId}:${event.payload.targetKind}:${event.payload.targetId}`, event)
      } else if (isOutboxEventType(event, "conversation:message_reassigned")) {
        for (const targetId of [event.payload.fromConversationId, event.payload.toConversationId]) {
          const key = `${event.payload.workspaceId}:conversation:${targetId}`
          const previous = structural.get(key)
          if (!previous || event.id > previous.eventId) {
            structural.set(key, {
              ref: { workspaceId: event.payload.workspaceId, targetKind: "conversation", targetId },
              eventId: event.id,
              messageId: event.payload.messageId,
              initiatingUserId: event.payload.initiatingUserId,
            })
          }
        }
      } else if (isOutboxEventType(event, "conversation:message_assigned")) {
        if (event.payload.isPrimary) {
          ordinary.set(`${event.payload.workspaceId}:conversation:${event.payload.conversationId}`, event)
        }
      } else if (event.eventType === "message:created") {
        const payload = parseMessagePayload(event.payload)
        if (payload) ordinary.set(`${payload.workspaceId}:stream:${payload.streamId}`, event)
      }
    }
    for (const event of requested.values()) await this.processEvent(event)
    for (const event of ordinary.values()) await this.processEvent(event)
    if (this.lifecycle) {
      await Promise.all(
        [...structural.values()].map(async ({ ref, eventId, messageId, initiatingUserId }) => {
          const authorityUserId = await this.resolveInitiatingUserId(messageId, initiatingUserId)
          if (!authorityUserId) {
            logger.warn(
              { workspaceId: ref.workspaceId, targetKind: ref.targetKind, targetId: ref.targetId, messageId },
              "Skipping dynamic naming structural event: no initiating user could be resolved"
            )
            return false
          }
          return this.lifecycle!.recordStructuralEvent(
            { ...ref, initiatingUserId: authorityUserId },
            eventId.toString()
          )
        })
      )
    }
    return events.map((event) => event.id)
  }

  protected async processEvent(event: OutboxEvent): Promise<void> {
    if (isOutboxEventType(event, "dynamic_naming:requested")) {
      if (event.payload.deferred) return
      if (!event.payload.initiatingUserId) {
        logger.warn(
          {
            workspaceId: event.payload.workspaceId,
            targetKind: event.payload.targetKind,
            targetId: event.payload.targetId,
          },
          "Skipping requested dynamic naming: no initiating user could be resolved"
        )
        return
      }
      await this.scheduler.schedule({
        workspaceId: event.payload.workspaceId,
        targetKind: event.payload.targetKind,
        targetId: event.payload.targetId,
        initiatingUserId: event.payload.initiatingUserId,
      })
      return
    }
    if (isOutboxEventType(event, "conversation:message_assigned")) {
      const payload = event.payload
      if (!payload.isPrimary || !(await this.isEligibleConversation(payload.workspaceId, payload.conversationId)))
        return
      const initiatingUserId = await this.resolveInitiatingUserId(payload.messageId, payload.initiatingUserId)
      if (!initiatingUserId) {
        logger.warn(
          {
            workspaceId: payload.workspaceId,
            targetKind: "conversation",
            conversationId: payload.conversationId,
            messageId: payload.messageId,
          },
          "Skipping dynamic naming for assigned message: no initiating user could be resolved"
        )
        return
      }
      await this.scheduler.schedule(
        {
          workspaceId: payload.workspaceId,
          targetKind: "conversation",
          targetId: payload.conversationId,
          initiatingUserId,
        },
        new Date(event.createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
      )
      return
    }
    if (isOutboxEventType(event, "conversation:message_reassigned")) {
      if (!this.lifecycle) return
      const payload = event.payload
      const initiatingUserId = await this.resolveInitiatingUserId(payload.messageId, payload.initiatingUserId)
      if (!initiatingUserId) {
        logger.warn(
          {
            workspaceId: payload.workspaceId,
            targetKind: "conversation",
            fromConversationId: payload.fromConversationId,
            toConversationId: payload.toConversationId,
            messageId: payload.messageId,
          },
          "Skipping dynamic naming for reassigned message: no initiating user could be resolved"
        )
        return
      }
      await Promise.all([
        this.lifecycle.recordStructuralEvent(
          {
            workspaceId: payload.workspaceId,
            targetKind: "conversation",
            targetId: payload.fromConversationId,
            initiatingUserId,
          },
          event.id.toString()
        ),
        this.lifecycle.recordStructuralEvent(
          {
            workspaceId: payload.workspaceId,
            targetKind: "conversation",
            targetId: payload.toConversationId,
            initiatingUserId,
          },
          event.id.toString()
        ),
      ])
      return
    }
    if (event.eventType !== "message:created") return
    const payload = parseMessagePayload(event.payload)
    if (!payload || payload.event.actorType !== AuthorTypes.USER || !payload.event.actorId) return

    const stream = await StreamRepository.findById(this.db, payload.streamId)
    if (!stream || stream.workspaceId !== payload.workspaceId || stream.archivedAt) return
    if (
      stream.type !== StreamTypes.SCRATCHPAD &&
      stream.type !== StreamTypes.THREAD &&
      stream.type !== StreamTypes.ASIDE
    )
      return
    if (await E2eStreamsRepository.isE2eStream(this.db, payload.workspaceId, payload.streamId)) return
    const source = stream.displayNameSource ?? (stream.displayName ? TitleSources.LEGACY : null)
    if (source !== null && source !== TitleSources.GENERATED) return
    const state = await DynamicNamingStateRepository.find(this.db, payload.workspaceId, "stream", payload.streamId)
    if (state?.completedAt && state.structureVersion <= state.lastEvaluatedStructureVersion) return

    await this.scheduler.schedule(
      {
        workspaceId: payload.workspaceId,
        targetKind: "stream",
        targetId: payload.streamId,
        initiatingUserId: payload.event.actorId,
      },
      new Date(event.createdAt.getTime() + DYNAMIC_NAMING_QUIET_MS)
    )
  }

  private async resolveInitiatingUserId(messageId: string, explicitUserId?: string): Promise<string | null> {
    if (explicitUserId) return explicitUserId
    const message = await MessageRepository.findById(this.db, messageId)
    return message?.authorType === AuthorTypes.USER ? message.authorId : null
  }

  private async isEligibleConversation(workspaceId: string, conversationId: string): Promise<boolean> {
    const conversation = await ConversationRepository.findById(this.db, conversationId)
    if (!conversation || conversation.workspaceId !== workspaceId) return false
    const stream = await StreamRepository.findById(this.db, conversation.streamId)
    if (!stream || stream.workspaceId !== workspaceId) return false
    if (stream.type === StreamTypes.SCRATCHPAD || stream.type === StreamTypes.ASIDE) return false
    if (await E2eStreamsRepository.isE2eStream(this.db, workspaceId, conversation.streamId)) return false
    const source = conversation.topicSummarySource ?? (conversation.topicSummary ? TitleSources.LEGACY : null)
    if (source !== null && source !== TitleSources.GENERATED) return false
    const state = await DynamicNamingStateRepository.find(this.db, workspaceId, "conversation", conversationId)
    return !state?.completedAt || state.structureVersion > state.lastEvaluatedStructureVersion
  }
}
