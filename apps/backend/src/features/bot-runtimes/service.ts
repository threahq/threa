import type { Pool } from "pg"
import type { Querier } from "../../db"
import type {
  BotInvocationCapability,
  BotInvocationTrigger,
  BotRuntimeKind,
  BotRuntimeStatus,
  BotTrait,
} from "@threa/types"
import { withTransaction } from "../../db"
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
    return StreamActiveActorRepository.upsert(this.pool, {
      id: streamActiveActorId(),
      ...params,
    })
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
    await StreamActiveActorRepository.upsert(db, {
      id: streamActiveActorId(),
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
    return this.createInvocationInTransaction(this.pool, params)
  }

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
    return BotInvocationRepository.insertIdempotent(db, {
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
    return BotInvocationRepository.claimOne(this.pool, params)
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
}
