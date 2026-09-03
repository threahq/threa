import type { Pool } from "pg"
import { AuthorTypes } from "@threa/types"
import { parseMarkdown } from "@threa/prosemirror"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import {
  OutboxRepository,
  parseMessagePayload,
  type OutboxHandler,
  type StreamArchivedOutboxPayload,
  type StreamUnarchivedOutboxPayload,
} from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { BotRuntimeService } from "./service"
import { EventService } from "../messaging"

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

export class BotInvocationOutboxHandler implements OutboxHandler {
  readonly listenerId = "bot-invocations"

  private readonly pool: Pool
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly service: BotRuntimeService
  private readonly eventService: EventService

  constructor(pool: Pool, eventService = new EventService(pool)) {
    this.pool = pool
    this.service = new BotRuntimeService({ pool })
    this.eventService = eventService
    this.cursorLock = new CursorLock({
      pool,
      listenerId: this.listenerId,
      lockDurationMs: DEFAULT_CONFIG.lockDurationMs,
      refreshIntervalMs: DEFAULT_CONFIG.refreshIntervalMs,
      maxRetries: DEFAULT_CONFIG.maxRetries,
      baseBackoffMs: DEFAULT_CONFIG.baseBackoffMs,
      batchSize: DEFAULT_CONFIG.batchSize,
    })
    this.debouncer = new DebounceWithMaxWait(
      () => this.processEvents(),
      DEFAULT_CONFIG.debounceMs,
      DEFAULT_CONFIG.maxWaitMs,
      (err) => logger.error({ err, listenerId: this.listenerId }, "BotInvocationOutboxHandler debouncer error")
    )
  }

  async ensureListener(): Promise<void> {
    await ensureListenerFromLatest(this.pool, this.listenerId)
    await this.service.repairDeletedSourceSessions()
  }

  handle(): void {
    this.debouncer.trigger()
  }

  private async processEvents(): Promise<void> {
    await this.cursorLock.run(async (cursor, processedIds): Promise<ProcessResult> => {
      const events = await OutboxRepository.fetchAfterId(this.pool, cursor, DEFAULT_CONFIG.batchSize, processedIds)
      if (events.length === 0) return { status: "no_events" }

      const seen: bigint[] = []
      for (const event of events) {
        if (event.eventType === "message:created" || event.eventType === "message:edited") {
          await this.processMessageMutation(event.payload)
        } else if (event.eventType === "message:deleted") {
          await this.processMessageDeleted(event.payload)
        } else if (event.eventType === "agent_session:started") {
          await this.processAgentSessionStarted(event.payload)
        } else if (event.eventType === "stream:archived") {
          await this.processStreamArchived(event.payload as StreamArchivedOutboxPayload)
        } else if (event.eventType === "stream:unarchived") {
          await this.processStreamUnarchived(event.payload as StreamUnarchivedOutboxPayload)
        }
        seen.push(event.id)
      }
      return { status: "processed", processedIds: seen }
    })
  }

  /**
   * Archiving a scratchpad ends its runtime session links and notifies each
   * linked runtime so it can shut itself down. The service call is idempotent
   * (set-based end of still-active links), so a retried batch is a no-op.
   */
  private async processStreamArchived(payload: StreamArchivedOutboxPayload): Promise<void> {
    if (!payload?.workspaceId || !payload?.streamId) return
    await this.service.endSessionsForArchivedStream({
      workspaceId: payload.workspaceId,
      rootStreamId: payload.streamId,
    })
  }

  /**
   * The unarchive counterpart: revive the links the archive ended and notify
   * each linked runtime so a live agent reattaches without a restart. Same
   * idempotency shape as the archive branch — already-active links return no
   * rows, so a retried batch re-notifies nothing.
   */
  private async processStreamUnarchived(payload: StreamUnarchivedOutboxPayload): Promise<void> {
    if (!payload?.workspaceId || !payload?.streamId) return
    await this.service.restoreSessionsForUnarchivedStream({
      workspaceId: payload.workspaceId,
      rootStreamId: payload.streamId,
    })
  }

  private async processAgentSessionStarted(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return
    const value = payload as Record<string, unknown>
    const event = value.event
    if (!event || typeof event !== "object") return
    const eventPayload = (event as Record<string, unknown>).payload
    if (!eventPayload || typeof eventPayload !== "object") return
    const sessionId = (eventPayload as Record<string, unknown>).sessionId
    if (typeof value.workspaceId !== "string" || typeof sessionId !== "string") return
    await this.service.repairDeletedSourceSession({ workspaceId: value.workspaceId, sessionId })
  }

  private async processMessageDeleted(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== "object") return
    const value = payload as Record<string, unknown>
    if (typeof value.workspaceId !== "string" || typeof value.messageId !== "string") return
    await this.reconcileMessage(value.workspaceId, value.messageId)
  }

  private async processMessageMutation(payload: unknown): Promise<void> {
    const message = parseMessagePayload(payload)
    if (!message?.event.actorId) return
    await this.reconcileMessage(message.workspaceId, message.event.payload.messageId)
  }

  private async reconcileMessage(workspaceId: string, sourceMessageId: string): Promise<void> {
    const notices = await this.service.reconcileInvocationSource({ workspaceId, sourceMessageId })
    for (const notice of notices) {
      await this.createMissingLinkNotice({
        workspaceId,
        botId: notice.botId,
        streamId: notice.streamId,
        contentMarkdown: notice.contentMarkdown,
        rootStreamId: notice.rootStreamId,
        sourceMessageId,
      })
    }
  }

  private async createMissingLinkNotice(params: {
    workspaceId: string
    botId: string
    streamId: string
    contentMarkdown: string
    rootStreamId: string
    sourceMessageId: string
  }): Promise<void> {
    try {
      await this.eventService.createGeneratedMessage(
        { kind: "bot", botId: params.botId },
        {
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          authorId: AuthorTypes.SYSTEM,
          authorType: AuthorTypes.SYSTEM,
          contentJson: parseMarkdown(params.contentMarkdown),
          contentMarkdown: params.contentMarkdown,
          clientMessageId: `bot-runtime-unlinked:${params.rootStreamId}:${params.sourceMessageId}`,
          metadata: { "bot_runtime.notice": "missing_session_link" },
        }
      )
    } catch (error) {
      const denial = error as { code?: string }
      if (denial.code === "STREAM_READ_ONLY" || denial.code === "STREAM_NOT_FOUND") return
      throw error
    }
  }
}
