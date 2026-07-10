import type { Pool } from "pg"
import { AuthorTypes, StreamTypes, botHasCapability } from "@threa/types"
import { resolveDeliveryVerdict, TrustTiers, TurnDeliveries } from "@threa/agent-runtime"
import { collectMentionActorRefs, parseMarkdown, type JSONContent } from "@threa/prosemirror"
import { CursorLock, DebounceWithMaxWait, ensureListenerFromLatest, type ProcessResult } from "@threa/backend-common"
import {
  OutboxRepository,
  parseMessagePayload,
  type OutboxHandler,
  type StreamArchivedOutboxPayload,
  type StreamUnarchivedOutboxPayload,
} from "../../lib/outbox"
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
 * Raw mention-node slugs in document order. PROTOCOL-ONLY display data for the
 * external turn (`mentionedActorSlugs`) — it never drives selection or
 * notification (those read resolved ids via collectMentionActorRefs, INV-64).
 */
function collectMentionSlugsForProtocol(content: JSONContent): string[] {
  const slugs: string[] = []
  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const slug = node.attrs?.slug
      if (typeof slug === "string" && slug.length > 0) slugs.push(slug)
    }
    if (node.content) for (const child of node.content) walk(child)
  }
  walk(content)
  return slugs
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

  private async processMessageCreated(payload: unknown): Promise<void> {
    const message = parseMessagePayload(payload)
    if (!message) return
    if (!message.event.actorId) return
    // System-authored messages never trigger a bot turn. Critically, the
    // missing-link notice below is itself a system message:created — reacting
    // to it would feed this handler its own output forever (notice → event →
    // notice …), flooding the stream and every per-message pipeline behind it.
    if (message.event.actorType === AuthorTypes.SYSTEM) return

    const stream = await StreamRepository.findById(this.pool, message.streamId)
    if (!stream || stream.workspaceId !== message.workspaceId || stream.archivedAt) return

    const rootStreamId = stream.rootStreamId ?? stream.id
    const rootStream = rootStreamId === stream.id ? stream : await StreamRepository.findById(this.pool, rootStreamId)
    const invocationRootStreamId = rootStream?.id ?? stream.id
    const isUserAuthored = message.event.actorType === AuthorTypes.USER
    // Selection reads the RESOLVED actor ids on the canonical contentJson mention
    // nodes (INV-64) — the ingestion resolver rewrote each node's `attrs.id` to a
    // prefixed actor id, so `actorType` comes from that prefix and never from the
    // slug. Bare-slug (unresolved) nodes are skipped by collectMentionActorRefs.
    const contentJson = message.event.payload.contentJson
    const mentionRefs = isUserAuthored && contentJson ? collectMentionActorRefs(contentJson) : []
    const mentionedBotIds = mentionRefs.filter((ref) => ref.actorType === "bot").map((ref) => ref.actorId)
    const hasMentionedPersona = mentionRefs.some((ref) => ref.actorType === "persona")
    const mentionedBots =
      mentionedBotIds.length > 0
        ? await BotRepository.findVisibleByIds(this.pool, message.workspaceId, message.event.actorId, mentionedBotIds)
        : []
    const mentionableBots = mentionedBots.filter((mentionedBot) => botHasCapability(mentionedBot, "mentionable"))

    // Protocol-only display data for external bots: the raw mention slugs as
    // authored. Carried verbatim on the turn protocol (`mentionedActorSlugs`);
    // it drives NO selection or notification decision (those read ids above).
    const mentionedSlugs = isUserAuthored && contentJson ? collectMentionSlugsForProtocol(contentJson) : []

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
    const activeExplicitlyMentioned = mentionedBotIds.includes(bot.id)
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
   * E2EE-11 → Phase 2.4: a bot turn dispatches only when the delivery verdict
   * says a payload variant may be minted for this bot on this stream — either
   * `plaintext` (non-E2E streams) or `sealed` (an E2E stream the bot holds a key
   * grant on, with the policy switch on). A `denied` verdict (E2E without a
   * grant, or the sealed policy switched off) keeps the bot out without a
   * bespoke guard. The skip is logged, never silent. On E2E streams mention
   * extraction already sees nothing (mentions ride in the ciphertext, the outbox
   * payload carries the placeholder), so in practice the sealed path is the
   * active-scratchpad one. Inert until the switch flips: `resolveSealingContext`
   * reports `externalSealedDelivery` off, so no verdict resolves to `sealed`.
   */
  private async verdictAllowsExternalDispatch(workspaceId: string, streamId: string, botId: string): Promise<boolean> {
    const sealing = await resolveSealingContext(this.pool, { workspaceId, streamId, actor: { kind: "bot", botId } })
    const verdict = resolveDeliveryVerdict({ trust: TrustTiers.THIRD_PARTY, sealing })
    if (verdict.delivery === "plaintext" || verdict.delivery === "sealed") return true
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
