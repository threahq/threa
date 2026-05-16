import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, botHasCapability } from "@threa/types"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import { OutboxRepository, parseMessagePayload, type OutboxHandler } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { StreamRepository } from "../streams"
import { BotRepository } from "../public-api/bot-repository"
import { BotRuntimeService } from "./service"
import { BotRuntimeSessionLinkRepository, StreamActiveActorRepository } from "./repository"

const DEFAULT_CONFIG = {
  batchSize: 100,
  debounceMs: 50,
  maxWaitMs: 200,
  lockDurationMs: 10_000,
  refreshIntervalMs: 5_000,
  maxRetries: 5,
  baseBackoffMs: 1_000,
}

function extractMentionSlugs(markdown: string): string[] {
  return Array.from(markdown.matchAll(/@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})/g), (match) => match[1]!.toLowerCase())
}

export class BotInvocationOutboxHandler implements OutboxHandler {
  readonly listenerId = "bot-invocations"

  private readonly pool: Pool
  private readonly cursorLock: CursorLock
  private readonly debouncer: DebounceWithMaxWait
  private readonly service: BotRuntimeService

  constructor(pool: Pool) {
    this.pool = pool
    this.service = new BotRuntimeService({ pool })
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
        if (event.eventType === "message:created") {
          await this.processMessageCreated(event.payload)
        }
        seen.push(event.id)
      }
      return { status: "processed", processedIds: seen }
    })
  }

  private async processMessageCreated(payload: unknown): Promise<void> {
    const message = parseMessagePayload(payload)
    if (!message) return
    if (message.event.actorType !== AuthorTypes.USER || !message.event.actorId) return

    const stream = await StreamRepository.findById(this.pool, message.streamId)
    if (!stream || stream.workspaceId !== message.workspaceId || stream.archivedAt) return

    const rootStreamId = stream.rootStreamId ?? stream.id
    const rootStream = rootStreamId === stream.id ? stream : await StreamRepository.findById(this.pool, rootStreamId)
    if (!rootStream || rootStream.type !== StreamTypes.SCRATCHPAD || rootStream.archivedAt) return

    const active = await StreamActiveActorRepository.findByRootStream(this.pool, message.workspaceId, rootStream.id)
    if (!active || active.actorType !== "bot") return

    const bot = await BotRepository.findById(this.pool, message.workspaceId, active.actorId)
    if (!bot || bot.archivedAt || !botHasCapability(bot, "active-scratchpad")) return

    const mentionedSlugs = extractMentionSlugs(message.event.payload.contentMarkdown)
    if (mentionedSlugs.length > 0 && bot.slug != null && !mentionedSlugs.includes(bot.slug)) return

    const link = await BotRuntimeSessionLinkRepository.findActiveByStream(this.pool, {
      workspaceId: message.workspaceId,
      botId: bot.id,
      rootStreamId: rootStream.id,
      activeStreamId: stream.id,
    })
    if (!link) return

    await this.service.createInvocation({
      workspaceId: message.workspaceId,
      rootStreamId: rootStream.id,
      activeStreamId: stream.id,
      sourceMessageId: message.event.payload.messageId,
      responseStreamId: stream.id,
      actorId: bot.id,
      trigger: "active-scratchpad",
      requiredCapability: "active-scratchpad",
      promptMarkdown: message.event.payload.contentMarkdown,
      authorUserId: message.event.actorId,
      mentionedActorSlugs: mentionedSlugs,
      targetInstanceId: link.instanceId,
      targetRuntimeSessionId: link.runtimeSessionId,
      metadata: {},
    })
  }
}
