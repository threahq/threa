import type { Pool } from "pg"
import type { Querier } from "../../db"
import type {
  BotInvocationCapability,
  BotInvocationTrigger,
  BotRuntimeKind,
  BotRuntimeStatus,
  BotTrait,
} from "@threa/types"
import { withClient, withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { BotRepository, type Bot } from "../public-api/bot-repository"
import { botInvocationId, botRuntimeInstanceId, botRuntimeSessionLinkId, streamActiveActorId } from "../../lib/id"
import {
  BotInvocationRepository,
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
  type BotInvocation,
  type BotRuntimeInstance,
  type BotRuntimeSessionLink,
  type StreamActiveActor,
} from "./repository"

interface BotRuntimeServiceDeps {
  pool: Pool
}

function serializeBotForOutbox(bot: Bot) {
  const common = {
    id: bot.id,
    workspaceId: bot.workspaceId,
    traits: bot.traits,
    slug: bot.slug,
    name: bot.name,
    description: bot.description,
    avatarEmoji: bot.avatarEmoji,
    avatarUrl: bot.avatarUrl,
    archivedAt: bot.archivedAt?.toISOString() ?? null,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  }
  if (bot.type === "personal") return { ...common, type: "personal" as const, ownerUserId: bot.ownerUserId }
  return { ...common, type: "shared" as const, ownerUserId: null }
}

export class BotRuntimeService {
  private readonly pool: Pool

  constructor(deps: BotRuntimeServiceDeps) {
    this.pool = deps.pool
  }

  async findLatestPresence(params: { workspaceId: string; botId: string }): Promise<BotRuntimeInstance | null> {
    return BotRuntimeInstanceRepository.findLatestForBot(this.pool, params.workspaceId, params.botId)
  }

  async findPresenceByInstance(params: {
    workspaceId: string
    botId: string
    instanceId: string
  }): Promise<BotRuntimeInstance | null> {
    return BotRuntimeInstanceRepository.findByInstance(this.pool, params)
  }

  async findLatestPresences(params: {
    workspaceId: string
    botIds: string[]
  }): Promise<Map<string, BotRuntimeInstance>> {
    return BotRuntimeInstanceRepository.findLatestForBots(this.pool, params.workspaceId, params.botIds)
  }

  async upsertPresenceFromBotKey(params: {
    workspaceId: string
    botId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    displayName?: string | null
    status: BotRuntimeStatus
    acceptingInvocations: boolean
    capabilities?: Record<string, unknown>
    statusText?: string | null
    mergeCapabilities?: boolean
  }): Promise<BotRuntimeInstance> {
    return BotRuntimeInstanceRepository.upsertPresence(this.pool, {
      id: botRuntimeInstanceId(),
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: params.runtimeKind,
      instanceId: params.instanceId,
      displayName: params.displayName,
      status: params.status,
      acceptingInvocations: params.acceptingInvocations,
      capabilities: params.capabilities ?? {},
      statusText: params.statusText,
      mergeCapabilities: params.mergeCapabilities,
    })
  }

  async setActiveActor(params: {
    workspaceId: string
    rootStreamId: string
    actorType: "persona" | "bot"
    actorId: string
    createdBy: string
  }): Promise<StreamActiveActor> {
    return withTransaction(this.pool, (db) => this.setActiveActorInTransaction(db, params))
  }

  /**
   * Single mutation path for `stream_active_actors`. Reads the existing row in
   * the same tx, upserts, and emits `bot:active_actor_changed` only when the
   * actor identity actually changed. `affectedBotIds` lists both the displaced
   * and the new bot (if either is a bot) so the dispatcher can fan out to both.
   *
   * Direct calls to `StreamActiveActorRepository.upsert` skip the outbox emit
   * and leave bots without the "you've been displaced" hint — go through this
   * wrapper instead.
   */
  async setActiveActorInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      rootStreamId: string
      actorType: "persona" | "bot"
      actorId: string
      createdBy: string
    }
  ): Promise<StreamActiveActor> {
    // Advisory lock keyed by (workspaceId, rootStreamId) serializes the whole
    // read→upsert pair. `SELECT ... FOR UPDATE` alone doesn't help when the
    // row doesn't exist yet: two concurrent inserts both see `existing=null`
    // and the loser's ON CONFLICT UPDATE then emits `bot:active_actor_changed`
    // with `previousActorId=null`, silently dropping the displaced bot from
    // `affectedBotIds`. The advisory lock holds for the transaction (INV-20).
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `stream_active_actors:${params.workspaceId}:${params.rootStreamId}`,
    ])
    const existing = await StreamActiveActorRepository.findByRootStream(db, params.workspaceId, params.rootStreamId)
    const upserted = await StreamActiveActorRepository.upsert(db, {
      id: streamActiveActorId(),
      ...params,
    })
    const previousActorType = existing?.actorType ?? null
    const previousActorId = existing?.actorId ?? null
    const identityChanged = previousActorId !== upserted.actorId || previousActorType !== upserted.actorType
    if (!identityChanged) return upserted

    const affectedBotIds: string[] = []
    if (previousActorType === "bot" && previousActorId) affectedBotIds.push(previousActorId)
    if (upserted.actorType === "bot" && upserted.actorId !== previousActorId) affectedBotIds.push(upserted.actorId)

    await OutboxRepository.insert(db, "bot:active_actor_changed", {
      workspaceId: params.workspaceId,
      rootStreamId: params.rootStreamId,
      previousActorType,
      previousActorId,
      newActorType: upserted.actorType,
      newActorId: upserted.actorId,
      affectedBotIds,
    })
    return upserted
  }

  async findActivePiRemoteSession(params: {
    workspaceId: string
    botId: string
    instanceId: string
    runtimeSessionId: string
  }): Promise<BotRuntimeSessionLink | null> {
    return BotRuntimeSessionLinkRepository.findActiveByRuntimeSession(this.pool, {
      ...params,
      runtimeKind: "pi-local",
    })
  }

  async findActivePiRemoteSessionsForStreams(params: {
    workspaceId: string
    botId: string
    streamIds: string[]
  }): Promise<Map<string, BotRuntimeSessionLink>> {
    return BotRuntimeSessionLinkRepository.findActiveByStreams(this.pool, {
      workspaceId: params.workspaceId,
      botId: params.botId,
      activeStreamIds: params.streamIds,
    })
  }

  async findActivePiRemoteSessionsForBotsInStream(params: {
    workspaceId: string
    botIds: string[]
    streamId: string
  }): Promise<Map<string, BotRuntimeSessionLink>> {
    return BotRuntimeSessionLinkRepository.findActiveByBotsAndStream(this.pool, {
      workspaceId: params.workspaceId,
      botIds: params.botIds,
      activeStreamId: params.streamId,
    })
  }

  async repairBotTraitsInTransaction(
    db: Querier,
    params: { workspaceId: string; botId: string; traits: readonly BotTrait[] }
  ): Promise<void> {
    const updated = await BotRepository.addTraitsIfMissing(db, params.botId, params.workspaceId, params.traits)
    if (!updated) return
    await OutboxRepository.insert(db, "bot:updated", {
      workspaceId: params.workspaceId,
      bot: serializeBotForOutbox(updated),
    })
  }

  async createOrLinkPiRemoteSession(params: {
    workspaceId: string
    botId: string
    instanceId: string
    runtimeSessionId: string
    rootStreamId: string
    activeStreamId: string
    linkedBy: string
    metadata?: Record<string, unknown>
  }): Promise<BotRuntimeSessionLink> {
    return withTransaction(this.pool, (client) => this.createOrLinkPiRemoteSessionInTransaction(client, params))
  }

  async createOrLinkPiRemoteSessionInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      instanceId: string
      runtimeSessionId: string
      rootStreamId: string
      activeStreamId: string
      linkedBy: string
      metadata?: Record<string, unknown>
    }
  ): Promise<BotRuntimeSessionLink> {
    await BotRuntimeInstanceRepository.upsertPresence(db, {
      id: botRuntimeInstanceId(),
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: "pi-local",
      instanceId: params.instanceId,
      status: "available",
      acceptingInvocations: true,
      capabilities: {
        supportsActiveScratchpad: true,
        supportsPersistentSessions: true,
        supportsSessionControlCommands: true,
        sessionControlCommands: ["compact", "model", "thinking", "skill"],
      },
    })
    await this.setActiveActorInTransaction(db, {
      workspaceId: params.workspaceId,
      rootStreamId: params.rootStreamId,
      actorType: "bot",
      actorId: params.botId,
      createdBy: params.linkedBy,
    })
    return BotRuntimeSessionLinkRepository.upsert(db, {
      id: botRuntimeSessionLinkId(),
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: "pi-local",
      instanceId: params.instanceId,
      runtimeSessionId: params.runtimeSessionId,
      rootStreamId: params.rootStreamId,
      activeStreamId: params.activeStreamId,
      linkedBy: params.linkedBy,
      metadata: params.metadata,
    })
  }

  async createInvocation(params: {
    workspaceId: string
    rootStreamId: string
    activeStreamId: string
    sourceMessageId: string
    responseStreamId: string
    actorId: string
    trigger: BotInvocationTrigger
    requiredCapability: BotInvocationCapability
    promptMarkdown: string
    authorUserId: string
    mentionedActorSlugs?: string[]
    targetInstanceId?: string | null
    targetRuntimeSessionId?: string | null
    metadata?: Record<string, unknown>
  }): Promise<BotInvocation> {
    return withTransaction(this.pool, (db) => this.createInvocationInTransaction(db, params))
  }

  /**
   * Inserts a `bot_invocations` row and emits `bot_invocation:available` in the
   * same tx — but only when the insert actually created a new row. The idempotent
   * conflict path returns the existing invocation untouched so we do not re-push
   * duplicates to listeners after a retried HTTP call.
   */
  async createInvocationInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      rootStreamId: string
      activeStreamId: string
      sourceMessageId: string
      responseStreamId: string
      actorId: string
      trigger: BotInvocationTrigger
      requiredCapability: BotInvocationCapability
      promptMarkdown: string
      authorUserId: string
      mentionedActorSlugs?: string[]
      targetInstanceId?: string | null
      targetRuntimeSessionId?: string | null
      metadata?: Record<string, unknown>
    }
  ): Promise<BotInvocation> {
    const { invocation, wasNewlyInserted } = await BotInvocationRepository.insertIdempotent(db, {
      id: botInvocationId(),
      workspaceId: params.workspaceId,
      rootStreamId: params.rootStreamId,
      activeStreamId: params.activeStreamId,
      sourceMessageId: params.sourceMessageId,
      responseStreamId: params.responseStreamId,
      actorType: "bot",
      actorId: params.actorId,
      trigger: params.trigger,
      requiredCapability: params.requiredCapability,
      promptMarkdown: params.promptMarkdown,
      authorUserId: params.authorUserId,
      mentionedActorSlugs: params.mentionedActorSlugs ?? [],
      targetInstanceId: params.targetInstanceId ?? null,
      targetRuntimeSessionId: params.targetRuntimeSessionId ?? null,
      metadata: params.metadata ?? {},
    })
    if (wasNewlyInserted) {
      await OutboxRepository.insert(db, "bot_invocation:available", {
        workspaceId: invocation.workspaceId,
        botId: invocation.actorId,
        invocationId: invocation.id,
        requiredCapability: invocation.requiredCapability,
        targetInstanceId: invocation.targetInstanceId,
        targetRuntimeSessionId: invocation.targetRuntimeSessionId,
        createdAt: invocation.createdAt.toISOString(),
      })
    }
    return invocation
  }

  /**
   * Snapshot the runtime needs on socket connect or resync. Runs all reads on
   * one connection inside a `REPEATABLE READ READ ONLY` tx so all four sub-
   * selects (available, ownedClaims, active actors, session links) see the
   * same MVCC point-in-time — otherwise an invocation claimed mid-bootstrap
   * could appear in neither list.
   *
   * Cursor floor is the smaller of `sinceCursor` and `now - 24h`. A future
   * cursor (clock-skewed bot) falls back to the 24h floor rather than
   * silently emptying the result set.
   *
   * The `serverGeneratedAt` echo lets the runtime reuse this exact timestamp
   * as `sinceCursor` on the next bootstrap without trusting its local clock.
   */
  async getBootstrapForRuntime(params: {
    workspaceId: string
    botId: string
    instanceId: string
    runtimeSessionId?: string | null
    supportedCapabilities: BotInvocationCapability[]
    sinceCursor?: Date | null
  }): Promise<{
    serverGeneratedAt: Date
    available: BotInvocation[]
    ownedClaims: BotInvocation[]
    activeActorByStream: StreamActiveActor[]
    activeSessionLinks: BotRuntimeSessionLink[]
  }> {
    const now = new Date()
    const lookbackFloor = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const cursor = params.sinceCursor ?? null
    const since = cursor && cursor > lookbackFloor && cursor <= now ? cursor : lookbackFloor
    return withClient(this.pool, async (db) => {
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      try {
        const [bootstrap, activeActorByStream, activeSessionLinks] = await Promise.all([
          BotInvocationRepository.findBootstrapInvocations(db, {
            workspaceId: params.workspaceId,
            botId: params.botId,
            instanceId: params.instanceId,
            runtimeSessionId: params.runtimeSessionId ?? null,
            supportedCapabilities: params.supportedCapabilities,
            since,
          }),
          StreamActiveActorRepository.findActiveForBot(db, {
            workspaceId: params.workspaceId,
            botId: params.botId,
          }),
          BotRuntimeSessionLinkRepository.findActiveByBotInstance(db, {
            workspaceId: params.workspaceId,
            botId: params.botId,
            instanceId: params.instanceId,
          }),
        ])
        await db.query("COMMIT")
        return {
          serverGeneratedAt: now,
          available: bootstrap.available,
          ownedClaims: bootstrap.ownedClaims,
          activeActorByStream,
          activeSessionLinks,
        }
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {})
        throw err
      }
    })
  }

  async claimNextInvocation(params: {
    workspaceId: string
    botId: string
    instanceId: string
    runtimeSessionId?: string
    runtimeKind: BotRuntimeKind
    claimToken: string
    supportedCapabilities: BotInvocationCapability[]
    claimTtlSeconds: number
  }): Promise<BotInvocation | null> {
    return withTransaction(this.pool, async (db) => {
      const claimed = await BotInvocationRepository.claimOne(db, params)
      if (!claimed) return null
      // Siblings on the same bot need to stop racing this invocation. The
      // narrow payload deliberately omits the winning instance — see
      // `BotInvocationClaimedOutboxPayload`.
      await OutboxRepository.insert(db, "bot_invocation:claimed", {
        workspaceId: claimed.workspaceId,
        botId: claimed.actorId,
        invocationId: claimed.id,
      })
      return claimed
    })
  }

  async findActiveClaim(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.findActiveClaim(this.pool, params)
  }

  async findActiveClaimForUpdate(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.findActiveClaimForUpdate(db, params)
  }

  async renewInvocationClaim(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
    claimTtlSeconds: number
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.renewClaim(this.pool, params)
  }

  async completeInvocation(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.completeClaim(this.pool, params)
  }

  async completeInvocationInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.completeClaim(db, params)
  }

  async failInvocation(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
    errorMessage: string
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.failClaim(this.pool, params)
  }

  async failInvocationInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
      errorMessage: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.failClaim(db, params)
  }

  /**
   * Tells one bot, one instance, or all bots in a workspace to drop their
   * in-memory state and re-bootstrap over WebSocket. Routing narrows to the
   * most-specific target available — `instanceId` requires `botId`.
   */
  async requestResync(params: {
    workspaceId: string
    botId?: string | null
    instanceId?: string | null
    reason: string
  }): Promise<void> {
    return withTransaction(this.pool, (db) => this.requestResyncInTransaction(db, params))
  }

  async requestResyncInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId?: string | null
      instanceId?: string | null
      reason: string
    }
  ): Promise<void> {
    const botId = params.botId ?? null
    const instanceId = params.instanceId ?? null
    if (instanceId && !botId) {
      throw new Error("requestResync: instanceId requires botId")
    }
    await OutboxRepository.insert(db, "bot:resync", {
      workspaceId: params.workspaceId,
      botId,
      instanceId,
      reason: params.reason,
    })
  }
}
