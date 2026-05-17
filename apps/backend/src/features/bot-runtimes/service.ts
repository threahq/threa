import type { Pool } from "pg"
import type { BotInvocationCapability, BotRuntimeKind, BotRuntimeStatus } from "@threa/types"
import { withTransaction } from "../../db"
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

export class BotRuntimeService {
  private readonly pool: Pool

  constructor(deps: BotRuntimeServiceDeps) {
    this.pool = deps.pool
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
    return withTransaction(this.pool, async (client) => {
      await BotRuntimeInstanceRepository.upsertPresence(client, {
        id: botRuntimeInstanceId(),
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: "pi-local",
        instanceId: params.instanceId,
        status: "available",
        acceptingInvocations: true,
        capabilities: { supportsActiveScratchpad: true, supportsPersistentSessions: true },
      })
      await StreamActiveActorRepository.upsert(client, {
        id: streamActiveActorId(),
        workspaceId: params.workspaceId,
        rootStreamId: params.rootStreamId,
        actorType: "bot",
        actorId: params.botId,
        createdBy: params.linkedBy,
      })
      return BotRuntimeSessionLinkRepository.upsert(client, {
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
    })
  }

  async createInvocation(params: {
    workspaceId: string
    rootStreamId: string
    activeStreamId: string
    sourceMessageId: string
    responseStreamId: string
    actorId: string
    trigger: "mention" | "active-scratchpad"
    requiredCapability: BotInvocationCapability
    promptMarkdown: string
    authorUserId: string
    mentionedActorSlugs?: string[]
    targetInstanceId?: string | null
    targetRuntimeSessionId?: string | null
    metadata?: Record<string, unknown>
  }): Promise<BotInvocation> {
    return BotInvocationRepository.insertIdempotent(this.pool, {
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

  async completeInvocation(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.completeClaim(this.pool, params)
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
}
