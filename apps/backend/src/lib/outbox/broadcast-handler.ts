import { Server } from "socket.io"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threa/types"
import {
  OutboxRepository,
  isStreamScopedEvent,
  isOutboxEventType,
  isOneOfOutboxEventType,
  isAuthorScopedEvent,
  isUserScopedEvent,
  type OutboxEvent,
  type StreamCreatedOutboxPayload,
  type StreamMemberAddedOutboxPayload,
  type ActivityCreatedOutboxPayload,
  type StreamDisplayNameUpdatedPayload,
  type AttachmentTranscodedOutboxPayload,
  type AttachmentThumbnailedOutboxPayload,
  type MessagesMovedOutboxPayload,
} from "./repository"
import { logger } from "../logger"
import { CursorLock, ensureListenerFromLatest, DebounceWithMaxWait, type ProcessResult } from "@threa/backend-common"
import type { OutboxHandler } from "@threa/backend-common"
import { invalidatePointersForEvent } from "../../features/messaging/sharing"

export interface BroadcastHandlerConfig {
  batchSize?: number
  debounceMs?: number
  maxWaitMs?: number
  lockDurationMs?: number
  refreshIntervalMs?: number
  maxRetries?: number
  baseBackoffMs?: number
}

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 10, // Low debounce for real-time responsiveness
  maxWaitMs: 50,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

/**
 * Handler that broadcasts outbox events to Socket.io rooms.
 *
 * Stream-scoped events (messages, reactions) are broadcast to stream rooms: `ws:${workspaceId}:stream:${streamId}`
 * Workspace-scoped events (stream metadata, attachments) are broadcast to workspace rooms: `ws:${workspaceId}`
 * User-scoped events (activity) are broadcast to user rooms: `ws:${workspaceId}:user:${userId}`
 * Author-scoped events (commands, read state) are broadcast to user rooms: `ws:${workspaceId}:user:${authorId}`
 *
 * User rooms eliminate DB queries during broadcast — the workosUserId→userId mapping
 * is resolved once at socket connect time, not per-event.
 *
 * Uses time-based cursor locking for exclusive access without
 * holding database connections during processing.
 */
export class BroadcastHandler implements OutboxHandler {
  readonly listenerId = "broadcast"

  private readonly db: Pool
  private readonly io: Server
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, io: Server, config?: BroadcastHandlerConfig) {
    this.db = db
    this.io = io
    this.batchSize = config?.batchSize ?? DEFAULT_CONFIG.batchSize

    this.cursorLock = new CursorLock({
      pool: db,
      listenerId: this.listenerId,
      lockDurationMs: config?.lockDurationMs ?? DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: config?.refreshIntervalMs ?? DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: config?.maxRetries ?? DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: config?.baseBackoffMs ?? DEFAULT_CONFIG.baseBackoffMs,
      batchSize: this.batchSize,
    })

    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      config?.debounceMs ?? DEFAULT_CONFIG.debounceMs,
      config?.maxWaitMs ?? DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "BroadcastHandler debouncer error")
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
          this.broadcastEvent(event)
          // After the normal per-event emit, fan out any pointer-invalidated
          // hints so clients subscribed to target streams refresh their
          // hydrated pointer content (see features/messaging/sharing, D7).
          await invalidatePointersForEvent(event, this.db, this.io)
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

  private broadcastEvent(event: OutboxEvent): void {
    const { workspaceId } = event.payload

    // User-scoped events: emit to the target user's room
    if (isUserScopedEvent(event)) {
      const { targetUserId } = event.payload as ActivityCreatedOutboxPayload
      this.io.to(`ws:${workspaceId}:user:${targetUserId}`).emit(event.eventType, event.payload)
      return
    }

    // Author-scoped events: emit to the author's user room
    if (isAuthorScopedEvent(event)) {
      const { authorId } = event.payload as { authorId: string }
      this.io.to(`ws:${workspaceId}:user:${authorId}`).emit(event.eventType, event.payload)
      return
    }

    // Special handling for stream:created - route threads to parent stream room
    if (isOutboxEventType(event, "stream:created")) {
      const payload = event.payload as StreamCreatedOutboxPayload
      if (payload.stream.parentMessageId) {
        this.io.to(`ws:${workspaceId}:stream:${payload.streamId}`).emit(event.eventType, event.payload)
      } else if (payload.stream.type === StreamTypes.DM && payload.dmUserIds?.length === 2) {
        for (const userId of new Set(payload.dmUserIds)) {
          this.io.to(`ws:${workspaceId}:user:${userId}`).emit(event.eventType, event.payload)
        }
      } else if (payload.stream.visibility === Visibilities.PRIVATE) {
        // Private streams (scratchpads, private channels) — only notify the creator.
        // Additional members are notified via stream:member_added events.
        this.io.to(`ws:${workspaceId}:user:${payload.stream.createdBy}`).emit(event.eventType, event.payload)
      } else {
        this.io.to(`ws:${workspaceId}`).emit(event.eventType, event.payload)
      }
      return
    }

    // stream:member_added: emit to stream room (existing members) AND the added
    // user's room directly — they haven't joined the stream room yet.
    if (isOutboxEventType(event, "stream:member_added")) {
      const { streamId, memberId } = event.payload as StreamMemberAddedOutboxPayload
      this.io.to(`ws:${workspaceId}:stream:${streamId}`).emit(event.eventType, event.payload)
      this.io.to(`ws:${workspaceId}:user:${memberId}`).emit(event.eventType, event.payload)
      return
    }

    // Conversation events broadcast to stream + optionally parent stream for discoverability.
    // `conversation:message_assigned` rides the same fan-out so thread-message membership
    // updates reach parent-channel subscribers; `conversation:message_reassigned` has no
    // parent dimension (it's keyed to the moved message's own stream).
    if (
      isOneOfOutboxEventType(event, ["conversation:created", "conversation:updated", "conversation:message_assigned"])
    ) {
      const payload = event.payload as { streamId: string; parentStreamId?: string }
      this.io.to(`ws:${workspaceId}:stream:${payload.streamId}`).emit(event.eventType, event.payload)
      if (payload.parentStreamId) {
        this.io.to(`ws:${workspaceId}:stream:${payload.parentStreamId}`).emit(event.eventType, event.payload)
      }
      return
    }

    if (isOutboxEventType(event, "messages:moved")) {
      const payload = event.payload as MessagesMovedOutboxPayload
      this.io
        .to(`ws:${workspaceId}:stream:${payload.sourceStreamId}`)
        .to(`ws:${workspaceId}:stream:${payload.destinationStreamId}`)
        .emit(event.eventType, event.payload)
      return
    }

    // Display name updates for public streams go to the workspace room so all
    // workspace users can update their bootstrap cache (e.g. for activity/search
    // name resolution on streams the user isn't a member of). Private stream names
    // stay stream-scoped to avoid leaking DM/scratchpad thread names.
    if (isOutboxEventType(event, "stream:display_name_updated")) {
      const payload = event.payload as StreamDisplayNameUpdatedPayload
      if (payload.visibility === "public") {
        this.io.to(`ws:${workspaceId}`).emit(event.eventType, event.payload)
      } else {
        this.io.to(`ws:${workspaceId}:stream:${payload.streamId}`).emit(event.eventType, event.payload)
      }
      return
    }

    // attachment:transcoded — stream-scoped when attached to a message, workspace-scoped otherwise
    if (isOutboxEventType(event, "attachment:transcoded")) {
      const payload = event.payload as AttachmentTranscodedOutboxPayload
      if (payload.streamId) {
        this.io.to(`ws:${workspaceId}:stream:${payload.streamId}`).emit(event.eventType, event.payload)
      } else {
        this.io.to(`ws:${workspaceId}`).emit(event.eventType, event.payload)
      }
      return
    }

    // attachment:thumbnailed — same scoping as transcoded
    if (isOutboxEventType(event, "attachment:thumbnailed")) {
      const payload = event.payload as AttachmentThumbnailedOutboxPayload
      if (payload.streamId) {
        this.io.to(`ws:${workspaceId}:stream:${payload.streamId}`).emit(event.eventType, event.payload)
      } else {
        this.io.to(`ws:${workspaceId}`).emit(event.eventType, event.payload)
      }
      return
    }

    if (isStreamScopedEvent(event)) {
      const { streamId } = event.payload
      this.io.to(`ws:${workspaceId}:stream:${streamId}`).emit(event.eventType, event.payload)
    } else {
      this.io.to(`ws:${workspaceId}`).emit(event.eventType, event.payload)
    }
  }
}
