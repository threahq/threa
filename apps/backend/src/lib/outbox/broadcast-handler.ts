import { Server, type Namespace } from "socket.io"
import type { Pool } from "pg"
import {
  OutboxRepository,
  isOutboxEventType,
  type OutboxEvent,
  type BotInvocationAvailableOutboxPayload,
  type BotInvocationClaimedOutboxPayload,
  type BotActiveActorChangedOutboxPayload,
  type BotResyncOutboxPayload,
} from "./repository"
import { resolveDeliveryGroups, groupToRoom } from "./delivery-groups"
import { logger } from "../logger"
import { SyncLogRepository, type SyncLogEntryInput } from "../../features/sync"
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

/** Per-event routing computed once per batch: delivery groups + assigned sync id. */
interface RoutedEvent {
  groups: string[] | null
  syncId?: bigint
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
  // Resolved once at construction so `dispatchBotEvent` stays a pure
  // emit-to-room call and `BroadcastHandler` doesn't reach into the
  // server for a feature-specific namespace name on every event.
  private readonly botNamespace: Namespace
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly batchSize: number

  constructor(db: Pool, io: Server, botNamespace: Namespace, config?: BroadcastHandlerConfig) {
    this.db = db
    this.io = io
    this.botNamespace = botNamespace
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

      // Sequence the whole batch into the sync log BEFORE any emit: the log
      // entry is the durable record, the socket emit is best-effort delivery.
      // A failure here retries the batch via the cursor; appendForWorkspace is
      // idempotent, so retried events keep their already-assigned sync ids.
      let routed: Map<bigint, RoutedEvent>
      try {
        routed = await this.sequenceEvents(events)
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        return { status: "error", error }
      }

      const seen: bigint[] = []

      try {
        for (const event of events) {
          this.broadcastEvent(event, routed.get(event.id))
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

  /**
   * Resolves every event's delivery groups once and appends client-routed
   * events to their workspace's sync log, in outbox-visibility order.
   * Bot-scoped events (groups === null) stay off the log; events with no
   * resolvable audience (groups === []) are logged by the resolver and
   * dropped.
   */
  private async sequenceEvents(events: OutboxEvent[]): Promise<Map<bigint, RoutedEvent>> {
    const routed = new Map<bigint, RoutedEvent>()
    const byWorkspace = new Map<string, SyncLogEntryInput[]>()

    for (const event of events) {
      const groups = resolveDeliveryGroups(event)
      routed.set(event.id, { groups })
      if (groups === null || groups.length === 0) {
        continue
      }
      const { workspaceId } = event.payload
      let entries = byWorkspace.get(workspaceId)
      if (!entries) {
        entries = []
        byWorkspace.set(workspaceId, entries)
      }
      entries.push({ outboxEventId: event.id, eventType: event.eventType, groups, payload: event.payload })
    }

    for (const [workspaceId, entries] of byWorkspace) {
      const syncIds = await SyncLogRepository.appendForWorkspace(this.db, workspaceId, entries)
      for (const [outboxEventId, syncId] of syncIds) {
        const entry = routed.get(outboxEventId)
        if (entry) {
          entry.syncId = syncId
        }
      }
    }

    return routed
  }

  private broadcastEvent(event: OutboxEvent, routedEvent: RoutedEvent | undefined): void {
    // Explicit undefined check, not `??`: bot-scoped events carry groups ===
    // null, which must pass through without re-resolving routing.
    const groups = routedEvent !== undefined ? routedEvent.groups : resolveDeliveryGroups(event)

    // Bot-scoped events ride the `/bot` namespace and use bot/instance/session
    // rooms so siblings on the same bot can stop racing each other (claimed,
    // cancelled) and steered work reaches exactly one instance/session.
    if (groups === null) {
      this.dispatchBotEvent(event)
      return
    }

    if (groups.length === 0) {
      return
    }

    // One emit to the union of rooms — Socket.io dedupes sockets present in
    // several of them, so an event never reaches the same connection twice.
    // The payload carries the sync id (string, like stream sequences on the
    // wire) so future clients can keep a sync-log cursor; current clients
    // ignore it.
    const { workspaceId } = event.payload
    const rooms = groups.map((group) => groupToRoom(workspaceId, group))
    const payload = routedEvent?.syncId ? { ...event.payload, syncId: routedEvent.syncId.toString() } : event.payload
    this.io.to(rooms).emit(event.eventType, payload)
  }

  /**
   * Routes bot-scoped outbox events to the `/bot` namespace. Picks the
   * narrowest room a payload supports so steered work reaches exactly one
   * runtime and broadcast events still reach every racing sibling.
   *
   * Room scheme (set up by the `/bot` namespace handler on connect):
   *   bot:{workspaceId}                                          — workspace-wide
   *   bot:{workspaceId}:bot:{botId}                              — every instance of one bot
   *   bot:{workspaceId}:bot:{botId}:instance:{instanceId}        — one instance
   *   bot:{workspaceId}:bot:{botId}:session:{runtimeSessionId}   — one Pi-local session
   */
  private dispatchBotEvent(event: OutboxEvent): void {
    const { workspaceId } = event.payload
    const botNs = this.botNamespace

    if (isOutboxEventType(event, "bot_invocation:available")) {
      const payload = event.payload as BotInvocationAvailableOutboxPayload
      if (payload.targetRuntimeSessionId) {
        botNs
          .to(`bot:${workspaceId}:bot:${payload.botId}:session:${payload.targetRuntimeSessionId}`)
          .emit(event.eventType, payload)
      } else if (payload.targetInstanceId) {
        botNs
          .to(`bot:${workspaceId}:bot:${payload.botId}:instance:${payload.targetInstanceId}`)
          .emit(event.eventType, payload)
      } else {
        botNs.to(`bot:${workspaceId}:bot:${payload.botId}`).emit(event.eventType, payload)
      }
      return
    }

    if (isOutboxEventType(event, "bot_invocation:claimed")) {
      const payload = event.payload as BotInvocationClaimedOutboxPayload
      // Tell every sibling on this bot to stop racing — the winner already
      // owns the row in Postgres, so an extra emit to the winner is harmless.
      botNs.to(`bot:${workspaceId}:bot:${payload.botId}`).emit(event.eventType, payload)
      return
    }

    if (isOutboxEventType(event, "bot:active_actor_changed")) {
      const payload = event.payload as BotActiveActorChangedOutboxPayload
      // `affectedBotIds` covers the displaced and the new bot (when either is
      // a bot). Empty array = persona<->persona swap with no bots to notify.
      for (const botId of payload.affectedBotIds) {
        botNs.to(`bot:${workspaceId}:bot:${botId}`).emit(event.eventType, payload)
      }
      return
    }

    if (isOutboxEventType(event, "bot:resync")) {
      const payload = event.payload as BotResyncOutboxPayload
      if (payload.instanceId && payload.botId) {
        botNs
          .to(`bot:${workspaceId}:bot:${payload.botId}:instance:${payload.instanceId}`)
          .emit(event.eventType, payload)
      } else if (payload.botId) {
        botNs.to(`bot:${workspaceId}:bot:${payload.botId}`).emit(event.eventType, payload)
      } else {
        botNs.to(`bot:${workspaceId}`).emit(event.eventType, payload)
      }
      return
    }

    // Should be unreachable — every BotScopedEventType must have a routing
    // branch above. If we hit this it means someone added an event type to
    // BOT_SCOPED_EVENTS without wiring the dispatcher, and the event would
    // silently disappear instead of reaching connected runtimes.
    logger.warn({ eventType: event.eventType }, "dispatchBotEvent: unhandled bot-scoped event type")
  }
}
