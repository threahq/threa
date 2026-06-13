import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, botHasCapability } from "@threa/types"
import { resolveDeliveryVerdict, TrustTiers, TurnDeliveries } from "@threa/agent-runtime"
import { collectMentionSlugs, parseMarkdown } from "@threa/prosemirror"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import { OutboxRepository, parseMessagePayload, type OutboxHandler } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { StreamRepository } from "../streams"
import { resolveSealingContext } from "../e2e-streams"
import { BotRepository } from "../public-api/bot-repository"
import { BotRuntimeService } from "./service"
import { ExternalTurnDriver } from "./external-turn-driver"
import {
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
} from "./repository"
import { resolveRuntimeKindConfig } from "./runtime-kind-config"
import { EventService } from "../messaging"
import { PersonaRepository } from "../agents"

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
  private readonly turnDriver: ExternalTurnDriver
  private readonly eventService: EventService

  constructor(pool: Pool, eventService = new EventService(pool)) {
    this.pool = pool
    this.service = new BotRuntimeService({ pool })
    this.turnDriver = new ExternalTurnDriver({ service: this.service })
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
    if (!message.event.actorId) return

    const stream = await StreamRepository.findById(this.pool, message.streamId)
    if (!stream || stream.workspaceId !== message.workspaceId || stream.archivedAt) return

    const rootStreamId = stream.rootStreamId ?? stream.id
    const rootStream = rootStreamId === stream.id ? stream : await StreamRepository.findById(this.pool, rootStreamId)
    const invocationRootStreamId = rootStream?.id ?? stream.id
    const isUserAuthored = message.event.actorType === AuthorTypes.USER
    // Mentions come from the canonical contentJson mention nodes (INV-58) —
    // produced by the editor's mention picker and by parseMarkdown on the API
    // path — not from a pattern over serialized markdown, so non-Latin slugs
    // dispatch the same as ASCII ones (INV-54).
    const contentJson = message.event.payload.contentJson
    const mentionedSlugs = isUserAuthored && contentJson ? collectMentionSlugs(contentJson) : []
    const uniqueMentionedSlugs = Array.from(new Set(mentionedSlugs))
    const [mentionedBots, mentionedPersonas] =
      uniqueMentionedSlugs.length > 0
        ? await Promise.all([
            BotRepository.findVisibleBySlugs(
              this.pool,
              message.workspaceId,
              message.event.actorId,
              uniqueMentionedSlugs
            ),
            Promise.all(
              uniqueMentionedSlugs.map((slug) => PersonaRepository.findBySlug(this.pool, slug, message.workspaceId))
            ),
          ])
        : [[], []]
    const mentionableBots = mentionedBots.filter((mentionedBot) => botHasCapability(mentionedBot, "mentionable"))
    const hasMentionedPersona = mentionedPersonas.some(Boolean)

    for (const mentionedBot of mentionableBots) {
      if (!(await this.verdictAllowsExternalDispatch(message.workspaceId, stream.id, mentionedBot.id))) continue
      await this.turnDriver.dispatchTurn(
        {
          delivery: TurnDeliveries.EXTERNAL,
          messages: [{ role: "user", content: message.event.payload.contentMarkdown }],
        },
        {
          workspaceId: message.workspaceId,
          actorId: mentionedBot.id,
          rootStreamId: invocationRootStreamId,
          activeStreamId: stream.id,
          responseStreamId: stream.id,
          sourceMessageId: message.event.payload.messageId,
          authorUserId: message.event.actorId,
          trigger: "mention",
          requiredCapability: "mentionable",
          mentionedActorSlugs: mentionedSlugs,
          metadata: {},
        }
      )
    }

    if (!rootStream || rootStream.type !== StreamTypes.SCRATCHPAD || rootStream.archivedAt) return

    const active = await StreamActiveActorRepository.findByRootStream(this.pool, message.workspaceId, rootStream.id)
    if (!active || active.actorType !== "bot") return

    const bot = await BotRepository.findById(this.pool, message.workspaceId, active.actorId)
    if (!bot || bot.archivedAt || !botHasCapability(bot, "active-scratchpad")) return
    if (message.event.actorType === AuthorTypes.BOT && message.event.actorId === bot.id) return
    if (mentionableBots.some((mentionedBot) => mentionedBot.id === bot.id)) return
    const activeExplicitlyMentioned = bot.slug != null && mentionedSlugs.includes(bot.slug)
    if ((mentionableBots.length > 0 || hasMentionedPersona) && !activeExplicitlyMentioned) return

    // Before any side effect: the missing-link notice below writes a plaintext
    // system message, which must never reach a stream the verdict won't let a
    // plaintext turn into (INV-E1).
    if (!(await this.verdictAllowsExternalDispatch(message.workspaceId, stream.id, bot.id))) return

    let link = await BotRuntimeSessionLinkRepository.findActiveByStream(this.pool, {
      workspaceId: message.workspaceId,
      botId: bot.id,
      rootStreamId: rootStream.id,
      activeStreamId: stream.id,
    })
    if (!link && stream.id !== rootStream.id) {
      link = await BotRuntimeSessionLinkRepository.findActiveByStream(this.pool, {
        workspaceId: message.workspaceId,
        botId: bot.id,
        rootStreamId: rootStream.id,
        activeStreamId: rootStream.id,
      })
    }
    if (!link) {
      // No link: whether that blocks dispatch is a per-runtime-kind policy.
      // Resolve the kind from the bot's latest runtime instance; link-free
      // kinds fall through to an untargeted invocation below.
      const instances = await BotRuntimeInstanceRepository.findLatestForBots(this.pool, message.workspaceId, [bot.id])
      const kindConfig = resolveRuntimeKindConfig(instances.get(bot.id)?.runtimeKind ?? null)
      if (kindConfig.sessionLinking === "required") {
        await this.createMissingLinkNotice({
          workspaceId: message.workspaceId,
          streamId: stream.id,
          contentMarkdown: kindConfig.missingSessionLinkNotice(bot.name),
          rootStreamId: rootStream.id,
          sourceMessageId: message.event.payload.messageId,
        })
        return
      }
    }

    const promptMarkdown = isUserAuthored
      ? message.event.payload.contentMarkdown
      : [
          "A non-user message was posted in your active Threa scratchpad.",
          "Use the stream context to decide whether a reply is useful. If no reply is needed, respond exactly: THREA_NO_RESPONSE",
          "",
          message.event.payload.contentMarkdown,
        ].join("\n")
    await this.turnDriver.dispatchTurn(
      {
        delivery: TurnDeliveries.EXTERNAL,
        messages: [{ role: "user", content: promptMarkdown }],
      },
      {
        workspaceId: message.workspaceId,
        actorId: bot.id,
        rootStreamId: rootStream.id,
        activeStreamId: stream.id,
        responseStreamId: stream.id,
        sourceMessageId: message.event.payload.messageId,
        authorUserId: message.event.actorId,
        trigger: "active-scratchpad",
        requiredCapability: "active-scratchpad",
        mentionedActorSlugs: mentionedSlugs,
        targetInstanceId: link?.instanceId ?? null,
        targetRuntimeSessionId: link?.runtimeSessionId ?? null,
        metadata: {},
      }
    )
  }

  /**
   * E2EE-11 → Phase 2.4a: the external wire carries plaintext, so a bot turn
   * dispatches only when the delivery verdict says plaintext may be minted
   * for this bot on this stream. E2E streams come back `denied` (or `sealed`
   * once a grant plus the policy switch exist — still not plaintext), keeping
   * external bots out of E2E without a bespoke guard. The skip is logged,
   * never silent. On E2E streams mention extraction already sees nothing
   * (mentions ride in the ciphertext, the outbox payload carries the
   * placeholder), so in practice this gates the active-scratchpad path.
   */
  private async verdictAllowsExternalDispatch(workspaceId: string, streamId: string, botId: string): Promise<boolean> {
    const sealing = await resolveSealingContext(this.pool, { workspaceId, streamId, actor: { kind: "bot", botId } })
    const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
    if (verdict.delivery === "plaintext") return true
    logger.info(
      { workspaceId, streamId, botId, verdict },
      "BotInvocationOutboxHandler: skipping dispatch — external wire cannot carry the delivery verdict"
    )
    return false
  }

  private async createMissingLinkNotice(params: {
    workspaceId: string
    streamId: string
    contentMarkdown: string
    rootStreamId: string
    sourceMessageId: string
  }): Promise<void> {
    await this.eventService.createMessage({
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      authorId: AuthorTypes.SYSTEM,
      authorType: AuthorTypes.SYSTEM,
      contentJson: parseMarkdown(params.contentMarkdown),
      contentMarkdown: params.contentMarkdown,
      clientMessageId: `bot-runtime-unlinked:${params.rootStreamId}:${params.sourceMessageId}`,
      metadata: { "bot_runtime.notice": "missing_session_link" },
    })
  }
}
