import type { Pool } from "pg"
import type { Querier } from "../../db"
import {
  AuthorTypes,
  LabelActorTypes,
  LabelableResourceTypes,
  MemoryModes,
  StreamTypes,
  type MemoryMode,
} from "@threa/types"
import type {
  BotInvocationCapability,
  BotInvocationTrigger,
  BotRuntimeKind,
  BotRuntimeManifest,
  BotRuntimeStatus,
  BotTrait,
} from "@threa/types"
import { withClient, withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import { BotRepository, type Bot } from "../public-api/bot-repository"
import {
  botInvocationId,
  botRuntimeInstanceId,
  botRuntimeSessionLinkId,
  eventId,
  streamActiveActorId,
} from "../../lib/id"
import { logger } from "../../lib/logger"
import { HttpError, serializeBigInt } from "@threa/backend-common"
import {
  BOT_CLAIM_MAX_ATTEMPTS,
  BotInvocationRepository,
  BotRuntimeInstanceRepository,
  BotRuntimeSessionLinkRepository,
  StreamActiveActorRepository,
  resolveControlTarget,
  type BotInvocation,
  type BotInvocationCancellation,
  type BotRuntimeInstance,
  type BotRuntimeSessionLink,
  type StreamActiveActor,
} from "./repository"
import type { LabelAssignmentService } from "../labels"
import {
  assertStreamWritable,
  StreamEventRepository,
  StreamRepository,
  type Stream,
  type StreamService,
} from "../streams"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { E2eStreamActorsRepository, E2eStreamsRepository } from "../e2e-streams"
import { MessageRepository, type InvocationSourceState } from "../messaging"
import {
  buildCanonicalInvocationPrompt,
  resolveCanonicalInvocationRoutes,
  type CanonicalInvocationRoute,
} from "./invocation-route-resolver"

interface BotRuntimeServiceDeps {
  pool: Pool
  streamService?: Pick<
    StreamService,
    "createScratchpadInTransaction" | "addBotToStreamOn" | "createThreadForPrincipalOn"
  >
  labelAssignmentService?: Pick<LabelAssignmentService, "assignByNameInTransaction">
}

class ClaimCandidateFenceLost extends Error {}

const DELETED_SOURCE_SESSION_REPAIR_BATCH_SIZE = 100

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
  if (bot.type === "personal") {
    return { ...common, type: "personal" as const, ownerUserId: bot.ownerUserId, readsAsOwner: bot.readsAsOwner }
  }
  return { ...common, type: "shared" as const, ownerUserId: null, readsAsOwner: false as const }
}

export class BotRuntimeService {
  private readonly pool: Pool
  private readonly streamService?: Pick<
    StreamService,
    "createScratchpadInTransaction" | "addBotToStreamOn" | "createThreadForPrincipalOn"
  >
  private readonly labelAssignmentService?: Pick<LabelAssignmentService, "assignByNameInTransaction">

  constructor(deps: BotRuntimeServiceDeps) {
    this.pool = deps.pool
    this.streamService = deps.streamService
    this.labelAssignmentService = deps.labelAssignmentService
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
    manifest?: BotRuntimeManifest | null
    statusText?: string | null
    publicKey?: string | null
    publicKeyId?: string | null
    mergeCapabilities?: boolean
    retainBik?: boolean
    retainManifest?: boolean
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
      manifest: params.manifest,
      statusText: params.statusText,
      publicKey: params.publicKey,
      publicKeyId: params.publicKeyId,
      mergeCapabilities: params.mergeCapabilities,
      retainBik: params.retainBik,
      retainManifest: params.retainManifest,
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
    /** Passed by session-create so reuse is kind-exact; omitted by rename (any kind). */
    runtimeKind?: BotRuntimeKind
  }): Promise<BotRuntimeSessionLink | null> {
    return BotRuntimeSessionLinkRepository.findActiveByRuntimeSession(this.pool, params)
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
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId: string
    rootStreamId: string
    activeStreamId: string
    linkedBy: string
    metadata?: Record<string, unknown>
  }): Promise<BotRuntimeSessionLink> {
    return withTransaction(this.pool, (client) => this.createOrLinkPiRemoteSessionInTransaction(client, params))
  }

  async createLinkedScratchpadSession(params: {
    workspaceId: string
    botId: string
    ownerUserId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId: string
    displayName: string
    localCwd?: string
    memoryMode?: MemoryMode
    labelName?: string
    /** Markdown description set on the new scratchpad (e.g. a handover note). */
    description?: string
    traits: readonly BotTrait[]
    /**
     * Create the scratchpad end-to-end encrypted. The flag + owner key land in
     * the create transaction (INV-E1) together with the bot's own actor grant,
     * so the very first invocation resolves a `sealed` delivery verdict; the
     * harness provisions the generation-0 SSK wraps in a follow-up call (the
     * wrap AAD binds to the stream id minted here).
     */
    e2e?: { ownerKeyId: string }
  }): Promise<{ link: BotRuntimeSessionLink; stream: Stream }> {
    const { streamService, labelAssignmentService } = this
    if (!streamService || !labelAssignmentService) {
      throw new Error("BotRuntimeService missing scratchpad session dependencies")
    }

    return withTransaction(this.pool, async (client) => {
      const stream = await streamService.createScratchpadInTransaction(client, {
        workspaceId: params.workspaceId,
        displayName: params.displayName,
        description: params.description,
        // Attribute the at-creation description note to the bot so the timeline
        // row reads "<bot> set the description".
        descriptionActor: params.description ? { id: params.botId, type: AuthorTypes.BOT } : undefined,
        // GAM extraction short-circuits on E2E streams (INV-E2), so an
        // encrypted scratchpad's memory mode is OFF regardless of the request.
        memoryMode: params.e2e ? MemoryModes.OFF : (params.memoryMode ?? MemoryModes.OFF),
        createdBy: params.ownerUserId,
        ...(params.e2e ? { e2e: { ownerKeyId: params.e2e.ownerKeyId } } : {}),
      })
      if (params.e2e) {
        // The creating harness is the scratchpad's sealed runner — grant it in
        // the same transaction so the first message's delivery verdict already
        // sees the actor row (a grant, not liveness: the claim predicate still
        // requires BIK wrap coverage before handing it a sealed turn).
        await E2eStreamActorsRepository.add(client, params.workspaceId, stream.id, "bot", params.botId, null)
        stream.e2eActors = [{ kind: "bot", actorId: params.botId, keyId: null }]
      }
      await streamService.addBotToStreamOn(client, stream.id, params.botId, params.workspaceId, params.ownerUserId)

      if (params.labelName) {
        await labelAssignmentService.assignByNameInTransaction(client, {
          workspaceId: params.workspaceId,
          actor: { type: LabelActorTypes.USER, id: params.ownerUserId },
          name: params.labelName,
          resourceType: LabelableResourceTypes.STREAM,
          resourceId: stream.id,
        })
      }

      await this.repairBotTraitsInTransaction(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        traits: params.traits,
      })
      const link = await this.createOrLinkPiRemoteSessionInTransaction(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: params.runtimeKind,
        instanceId: params.instanceId,
        runtimeSessionId: params.runtimeSessionId,
        rootStreamId: stream.id,
        activeStreamId: stream.id,
        linkedBy: params.ownerUserId,
        metadata: { displayName: params.displayName, localCwd: params.localCwd ?? null },
      })
      return { link, stream }
    })
  }

  /**
   * Link a runtime session to a NEW thread under a scratchpad the caller
   * already owns and the bot already has channel access to, rather than
   * minting a fresh scratchpad. One transaction: thread create, then the same
   * presence/active-actor/link writes `createLinkedScratchpadSession` does,
   * so a failed link insert rolls back the thread too (INV-4/6/7). A thread
   * that already carries an active link is refused rather than stolen.
   */
  async attachRuntimeSessionToThread(params: {
    workspaceId: string
    botId: string
    ownerUserId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId: string
    rootStreamId: string
    anchorId: string
    displayName: string
    localCwd?: string
    traits: readonly BotTrait[]
  }): Promise<{ link: BotRuntimeSessionLink; stream: Stream }> {
    const { streamService } = this
    if (!streamService) {
      throw new Error("BotRuntimeService missing scratchpad session dependencies")
    }

    return withTransaction(this.pool, async (client) => {
      const root = await StreamRepository.findByIdForWorkspace(client, params.rootStreamId, params.workspaceId)
      if (!root) throw new HttpError("Scratchpad not found", { status: 404, code: "NOT_FOUND" })
      if (root.type !== StreamTypes.SCRATCHPAD) {
        throw new HttpError("attachTo root must be a scratchpad", { status: 400, code: "ATTACH_ROOT_NOT_SCRATCHPAD" })
      }
      if (root.archivedAt) {
        throw new HttpError("Scratchpad is archived", { status: 409, code: "SCRATCHPAD_ARCHIVED" })
      }
      if (root.createdBy !== params.ownerUserId) {
        throw new HttpError("Scratchpad belongs to another user", { status: 403, code: "FORBIDDEN" })
      }
      // The brief that follows an attach is plaintext, so an E2E root would leave a
      // thread, a link and a running agent that can never be briefed (INV-11).
      if (await E2eStreamsRepository.isE2eStream(client, params.workspaceId, params.rootStreamId)) {
        throw new HttpError("Scratchpad is end-to-end encrypted; attach is unsupported", {
          status: 400,
          code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED",
        })
      }

      const thread = await streamService.createThreadForPrincipalOn(
        client,
        { kind: "bot", botId: params.botId },
        {
          workspaceId: params.workspaceId,
          parentStreamId: params.rootStreamId,
          parentAnchorId: params.anchorId,
          createdBy: params.botId,
          createdByType: "bot",
        }
      )

      await this.repairBotTraitsInTransaction(client, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        traits: params.traits,
      })
      const linkParams = {
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: params.runtimeKind,
        instanceId: params.instanceId,
        runtimeSessionId: params.runtimeSessionId,
        rootStreamId: params.rootStreamId,
        activeStreamId: thread.id,
        linkedBy: params.ownerUserId,
        metadata: { displayName: params.displayName, localCwd: params.localCwd ?? null },
      }
      await this.preparePiRemoteSessionInTransaction(client, linkParams)
      const link = await BotRuntimeSessionLinkRepository.upsertUnlessActive(client, {
        id: botRuntimeSessionLinkId(),
        ...linkParams,
      })
      if (!link) {
        throw new HttpError("A runtime session is already linked to this thread", {
          status: 409,
          code: "THREAD_SESSION_EXISTS",
        })
      }
      return { link, stream: thread }
    })
  }

  async createOrLinkPiRemoteSessionInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
      rootStreamId: string
      activeStreamId: string
      linkedBy: string
      metadata?: Record<string, unknown>
    }
  ): Promise<BotRuntimeSessionLink> {
    await this.preparePiRemoteSessionInTransaction(db, params)
    return BotRuntimeSessionLinkRepository.upsert(db, {
      id: botRuntimeSessionLinkId(),
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: params.runtimeKind,
      instanceId: params.instanceId,
      runtimeSessionId: params.runtimeSessionId,
      rootStreamId: params.rootStreamId,
      activeStreamId: params.activeStreamId,
      linkedBy: params.linkedBy,
      metadata: params.metadata,
    })
  }

  private async preparePiRemoteSessionInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
      rootStreamId: string
      linkedBy: string
    }
  ): Promise<void> {
    await this.upsertPiRemoteSessionPresenceInTransaction(db, params)
    await this.setActiveActorInTransaction(db, {
      workspaceId: params.workspaceId,
      rootStreamId: params.rootStreamId,
      actorType: "bot",
      actorId: params.botId,
      createdBy: params.linkedBy,
    })
  }

  async rebindPiRemoteSessionInstance(params: {
    workspaceId: string
    botId: string
    linkId: string
    instanceId: string
    runtimeSessionId: string
    newInstanceId: string
  }): Promise<BotRuntimeSessionLink | null> {
    return withTransaction(this.pool, async (db) => {
      const link = await BotRuntimeSessionLinkRepository.rebindInstance(db, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        linkId: params.linkId,
        runtimeKind: "pi-local",
        instanceId: params.instanceId,
        runtimeSessionId: params.runtimeSessionId,
        newInstanceId: params.newInstanceId,
      })
      if (!link) return null
      await this.upsertPiRemoteSessionPresenceInTransaction(db, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: "pi-local",
        instanceId: params.newInstanceId,
        runtimeSessionId: params.runtimeSessionId,
      })
      return link
    })
  }

  private async upsertPiRemoteSessionPresenceInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      runtimeKind: BotRuntimeKind
      instanceId: string
      runtimeSessionId: string
    }
  ): Promise<void> {
    await BotRuntimeInstanceRepository.upsertPresence(db, {
      id: botRuntimeInstanceId(),
      workspaceId: params.workspaceId,
      botId: params.botId,
      runtimeKind: params.runtimeKind,
      instanceId: params.instanceId,
      status: "available",
      acceptingInvocations: true,
      // Bootstrap capabilities until the runtime's own heartbeat lands. Pi gets a
      // default session-control set here. The Claude Code channel advertises its
      // own set in `bot:hello` (gated on running inside tmux), so we don't
      // presume one for it;
      // its real capabilities land within a frame of connecting.
      capabilities: {
        runtimeSessionId: params.runtimeSessionId,
        supportsActiveScratchpad: true,
        supportsPersistentSessions: true,
        ...(params.runtimeKind === "pi-local"
          ? {
              supportsSessionControlCommands: true,
              sessionControlCommands: [
                "compact",
                "model",
                "thinking",
                "skill",
                "reload",
                "shell",
                "steer",
                "stop",
                "kick",
              ],
            }
          : {}),
      },
      // Session-link writes don't carry the runtime's BIK; keep the key the
      // live session registered via bot:hello rather than nulling it.
      retainBik: true,
      retainManifest: true,
    })
  }

  /**
   * A scratchpad was archived: end every active runtime link rooted at it and
   * tell each linked runtime over the /bot socket so it can wind itself down
   * (the Claude channel pushes its branch and kills its own tmux window). Link
   * ending and the notify events commit together (INV-4/INV-7); the set-based
   * UPDATE makes consumer retries idempotent — already-ended links return no
   * rows, so nothing re-notifies.
   */
  async endSessionsForArchivedStream(params: { workspaceId: string; rootStreamId: string }): Promise<number> {
    return withTransaction(this.pool, async (db) => {
      const ended = await BotRuntimeSessionLinkRepository.archiveActiveByRootStream(db, params)
      for (const link of ended) {
        await OutboxRepository.insert(db, "bot:session_archived", {
          workspaceId: params.workspaceId,
          botId: link.botId,
          instanceId: link.instanceId,
          runtimeSessionId: link.runtimeSessionId,
          rootStreamId: params.rootStreamId,
        })
      }
      if (ended.length > 0) {
        logger.info(
          { workspaceId: params.workspaceId, rootStreamId: params.rootStreamId, endedLinks: ended.length },
          "Ended runtime session links for archived stream"
        )
      }
      return ended.length
    })
  }

  /**
   * The unarchive counterpart: revive exactly the links the archive ended
   * (status 'archived' → 'active'; normal-shutdown 'ended' links stay dead) and
   * tell each linked runtime over the /bot socket so a live agent reattaches
   * without a restart. Same INV-4/INV-7 shape as the archive path: revival and
   * the notify events commit together, and the set-based UPDATE makes consumer
   * retries idempotent.
   */
  async restoreSessionsForUnarchivedStream(params: { workspaceId: string; rootStreamId: string }): Promise<number> {
    return withTransaction(this.pool, async (db) => {
      const restored = await BotRuntimeSessionLinkRepository.reactivateArchivedByRootStream(db, params)
      for (const link of restored) {
        await OutboxRepository.insert(db, "bot:session_restored", {
          workspaceId: params.workspaceId,
          botId: link.botId,
          instanceId: link.instanceId,
          runtimeSessionId: link.runtimeSessionId,
          rootStreamId: params.rootStreamId,
        })
      }
      if (restored.length > 0) {
        logger.info(
          { workspaceId: params.workspaceId, rootStreamId: params.rootStreamId, restoredLinks: restored.length },
          "Restored runtime session links for unarchived stream"
        )
      }
      return restored.length
    })
  }

  /**
   * Session-create reattach: a runtime whose scratchpad was archived and then
   * unarchived re-issues session-create with the same identity; revive its
   * archive-ended link instead of minting a duplicate scratchpad. Presence and
   * the active-actor slot are refreshed in the same transaction so the revived
   * link dispatches turns immediately. `archived_stream` tells the caller the
   * link exists but its scratchpad is still archived (the handler 409s).
   */
  async reattachArchivedRuntimeSession(params: {
    workspaceId: string
    botId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId: string
  }): Promise<{ status: "reattached"; link: BotRuntimeSessionLink } | { status: "archived_stream" | "none" }> {
    return withTransaction(this.pool, async (db) => {
      const link = await BotRuntimeSessionLinkRepository.reactivateArchivedByRuntimeSession(db, params)
      if (!link) {
        // A concurrent reattach/unarchive that already committed leaves the
        // link 'active' (SKIP LOCKED skipped nothing; the CTE just found no
        // 'archived' row) — report it as the reattach rather than
        // misclassifying via the stale 'archived' read below. A racer that is
        // still uncommitted can't be told apart without blocking; that case
        // stays a transient archived_stream the client's probe absorbs.
        const active = await BotRuntimeSessionLinkRepository.findActiveByRuntimeSession(db, params)
        if (active) return { status: "reattached" as const, link: active }
        const archived = await BotRuntimeSessionLinkRepository.findArchivedByRuntimeSession(db, params)
        return { status: archived ? ("archived_stream" as const) : ("none" as const) }
      }
      await this.upsertPiRemoteSessionPresenceInTransaction(db, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeKind: params.runtimeKind,
        instanceId: params.instanceId,
        runtimeSessionId: params.runtimeSessionId,
      })
      await this.setActiveActorInTransaction(db, {
        workspaceId: params.workspaceId,
        rootStreamId: link.rootStreamId,
        actorType: "bot",
        actorId: params.botId,
        createdBy: link.linkedBy,
      })
      logger.info(
        { workspaceId: params.workspaceId, botId: params.botId, rootStreamId: link.rootStreamId, linkId: link.id },
        "Reattached archived runtime session link"
      )
      return { status: "reattached" as const, link }
    })
  }

  /**
   * Session-create `ifArchived: "replace"`: the caller is a cold-started
   * runtime whose deterministic identity points at an archived scratchpad the
   * user is done with. Retire that link (terminal, identity renamed out of the
   * unique key's way) so a fresh scratchpad can be created under the same
   * identity. Returns false when there was nothing to retire — either the
   * scratchpad got unarchived concurrently (the caller should retry the
   * reattach) or the link is already gone.
   */
  async retireArchivedRuntimeSession(params: {
    workspaceId: string
    botId: string
    runtimeKind: BotRuntimeKind
    instanceId: string
    runtimeSessionId: string
  }): Promise<boolean> {
    return withTransaction(this.pool, async (db) => {
      const retired = await BotRuntimeSessionLinkRepository.retireArchivedByRuntimeSession(db, params)
      if (!retired) return false
      logger.info(
        {
          workspaceId: params.workspaceId,
          botId: params.botId,
          rootStreamId: retired.rootStreamId,
          linkId: retired.id,
        },
        "Retired archived runtime session link for replacement"
      )
      return true
    })
  }

  /** Ends the link and cancels pending invocations still routed at it, in one transaction (INV-4/6/7). */
  async endRuntimeSession(params: {
    workspaceId: string
    botId: string
    instanceId: string
    runtimeSessionId: string
  }): Promise<BotRuntimeSessionLink | null> {
    return withTransaction(this.pool, async (db) => {
      const ended = await BotRuntimeSessionLinkRepository.endActiveByRuntimeSession(db, params)
      if (!ended) return null
      const cancelled = await BotInvocationRepository.cancelPendingByTargetRuntimeSession(db, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        runtimeSessionId: params.runtimeSessionId,
      })
      await this.terminalizeCancelledSessions(db, params.workspaceId, cancelled, "superseded")
      await this.emitCancellationHints(db, cancelled)
      logger.info(
        {
          workspaceId: params.workspaceId,
          botId: params.botId,
          rootStreamId: ended.rootStreamId,
          activeStreamId: ended.activeStreamId,
          linkId: ended.id,
          cancelledInvocations: cancelled.length,
        },
        "Ended runtime session link"
      )
      return ended
    })
  }

  private async terminalizeCancelledSessions(
    db: Querier,
    workspaceId: string,
    invocations: BotInvocation[],
    status: "deleted" | "superseded"
  ): Promise<void> {
    for (const invocation of invocations) {
      // A completed turn's session stays open (running or completed) for late
      // delivery; a deleted source ends it, a superseding route never does.
      const terminal = invocation.status === "cancelled" || (invocation.status === "completed" && status === "deleted")
      if (!terminal) continue
      const updated = await AgentSessionRepository.updateStatus(db, invocation.id, status, {
        error: status === "deleted" ? "Invocation source deleted" : "Invocation route superseded",
        onlyIfStatusIn:
          status === "deleted" ? [SessionStatuses.RUNNING, SessionStatuses.COMPLETED] : [SessionStatuses.RUNNING],
      })
      if (!updated || status !== "deleted") continue
      const streamEvent = await StreamEventRepository.insert(db, {
        id: eventId(),
        streamId: updated.streamId,
        eventType: "agent_session:deleted",
        payload: { sessionId: updated.id, deletedAt: updated.completedAt?.toISOString() ?? new Date().toISOString() },
        actorId: updated.personaId,
        actorType: AuthorTypes.BOT,
      })
      const stream = await StreamRepository.findByIdForWorkspace(db, updated.streamId, workspaceId)
      await OutboxRepository.insert(db, "agent_session:deleted", {
        workspaceId,
        streamId: updated.streamId,
        rootStreamId: stream?.rootStreamId ?? stream?.id,
        event: serializeBigInt(streamEvent),
      })
    }
  }

  private async emitCancellationHints(db: Querier, invocations: BotInvocation[]): Promise<void> {
    for (const invocation of invocations) {
      if (invocation.status !== "cancelled" || !invocation.cancellationReason) continue
      await OutboxRepository.insert(db, "bot_invocation:cancelled", {
        workspaceId: invocation.workspaceId,
        botId: invocation.actorId,
        invocationId: invocation.id,
        sourceRevision: invocation.sourceMessageRevision,
        ...resolveControlTarget(invocation),
        reason: invocation.cancellationReason,
      })
    }
  }

  private async cancelInvocationsForDeletedSourceInTransaction(
    db: Querier,
    params: { workspaceId: string; sourceMessageId: string },
    options: { locksHeld?: boolean } = {}
  ): Promise<number> {
    const cancelled = await BotInvocationRepository.cancelActiveBySource(
      db,
      { ...params, reason: "source_deleted" },
      options
    )
    await this.terminalizeCancelledSessions(
      db,
      params.workspaceId,
      [...cancelled.transitioned, ...cancelled.sessionRepairCandidates],
      "deleted"
    )
    await this.emitCancellationHints(db, cancelled.transitioned)
    return cancelled.transitioned.length + cancelled.sessionRepairCandidates.length
  }

  async cancelInvocationsForDeletedSource(params: { workspaceId: string; sourceMessageId: string }): Promise<number> {
    return withTransaction(this.pool, (db) => this.cancelInvocationsForDeletedSourceInTransaction(db, params))
  }

  async repairDeletedSourceSession(params: { workspaceId: string; sessionId: string }): Promise<boolean> {
    const source = await BotInvocationRepository.findDeletedSourceForRunningSession(this.pool, params)
    if (!source) return false
    await this.cancelInvocationsForDeletedSource(source)
    return true
  }

  /**
   * Repair rows a migration cancelled before application lifecycle code could
   * run. The RUNNING-session predicate is the CAS: concurrent backend startups
   * may discover the same source, but only one transaction emits each deletion.
   */
  async repairDeletedSourceSessions(): Promise<number> {
    let repairedSources = 0
    for (;;) {
      const sources = await BotInvocationRepository.findDeletedSourcesWithRunningSessions(
        this.pool,
        DELETED_SOURCE_SESSION_REPAIR_BATCH_SIZE
      )
      if (sources.length === 0) return repairedSources
      for (const source of sources) {
        await this.cancelInvocationsForDeletedSource(source)
        repairedSources += 1
      }
    }
  }

  private async insertCanonicalRoute(
    db: Querier,
    source: InvocationSourceState,
    sourceMessageId: string,
    route: CanonicalInvocationRoute,
    options: { locksHeld?: boolean } = {}
  ): Promise<void> {
    const { invocation, wasNewlyInserted, didAdvanceSourceRevision, routingDestinationChanged } =
      await BotInvocationRepository.insertIdempotent(
        db,
        {
          id: botInvocationId(),
          workspaceId: source.workspaceId,
          rootStreamId: route.rootStreamId,
          activeStreamId: route.activeStreamId,
          sourceMessageId,
          responseStreamId: route.responseStreamId,
          actorType: "bot",
          actorId: route.actorId,
          trigger: route.trigger,
          requiredCapability: route.requiredCapability,
          promptMarkdown: route.promptMarkdown,
          sourceMessageRevision: source.revision,
          authorUserId: route.authorUserId,
          mentionedActorSlugs: route.mentionedActorSlugs,
          targetInstanceId: route.targetInstanceId,
          targetRuntimeSessionId: route.targetRuntimeSessionId,
          metadata: {},
        },
        options
      )
    if (!wasNewlyInserted) {
      if (routingDestinationChanged && invocation.status === "pending") {
        await this.emitAvailabilityHint(db, invocation)
        return
      }
      if (!didAdvanceSourceRevision || invocation.status !== "claimed") return
      if (invocation.claimedInputUpdateMode === "live") {
        await OutboxRepository.insert(db, "bot_invocation:input_updated", {
          workspaceId: invocation.workspaceId,
          botId: invocation.actorId,
          invocationId: invocation.id,
          sourceRevision: invocation.sourceMessageRevision,
          ...resolveControlTarget(invocation),
        })
        return
      }
      if (invocation.claimedInputUpdateMode === "restart") {
        const cancelled = await BotInvocationRepository.cancelClaim(db, {
          workspaceId: invocation.workspaceId,
          invocationId: invocation.id,
          reason: "input_restart",
          expectedSourceRevision: invocation.sourceMessageRevision,
          bumpToRevision: invocation.sourceMessageRevision,
        })
        if (!cancelled) return
        await this.terminalizeCancelledSessions(db, invocation.workspaceId, [cancelled], "superseded")
        await this.emitCancellationHints(db, [cancelled])
        await this.insertCanonicalRoute(db, source, sourceMessageId, route, { locksHeld: true })
      }
      return
    }
    await this.emitAvailabilityHint(db, invocation)
  }

  private async emitAvailabilityHint(db: Querier, invocation: BotInvocation): Promise<void> {
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

  private async reconcileInvocationSourceInTransaction(
    db: Querier,
    params: { workspaceId: string; sourceMessageId: string },
    options: { locksHeld?: boolean; source?: InvocationSourceState | null } = {}
  ): Promise<Array<{ botId: string; streamId: string; rootStreamId: string; contentMarkdown: string }>> {
    if (options.source === undefined && !options.locksHeld) await BotInvocationRepository.lockSource(db, params)
    const source =
      options.source === undefined
        ? await MessageRepository.findInvocationSourceStateForShare(db, {
            workspaceId: params.workspaceId,
            messageId: params.sourceMessageId,
          })
        : options.source
    if (!source || source.deleted) {
      await this.cancelInvocationsForDeletedSourceInTransaction(db, params, options)
      return []
    }

    const routes = await resolveCanonicalInvocationRoutes(db, source)
    const dispatchable = routes.filter((route) => !route.missingLinkNotice)
    const cancelled = await BotInvocationRepository.cancelActiveRoutesNotDesired(
      db,
      {
        ...params,
        sourceMessageRevision: source.revision,
        desiredRoutes: dispatchable.map((route) => ({
          actorId: route.actorId,
          trigger: route.trigger,
          activeStreamId: route.activeStreamId,
          responseStreamId: route.responseStreamId,
          targetInstanceId: route.targetInstanceId,
          targetRuntimeSessionId: route.targetRuntimeSessionId,
        })),
      },
      options
    )
    await this.terminalizeCancelledSessions(db, params.workspaceId, cancelled, "superseded")
    await this.emitCancellationHints(db, cancelled)
    const orderedDispatchable = dispatchable.toSorted((left, right) => left.actorId.localeCompare(right.actorId))
    for (const route of orderedDispatchable) {
      await this.insertCanonicalRoute(db, source, params.sourceMessageId, route, options)
    }

    return routes.flatMap((route) =>
      route.missingLinkNotice
        ? [
            {
              botId: route.actorId,
              streamId: source.streamId,
              rootStreamId: route.rootStreamId,
              contentMarkdown: route.missingLinkNotice,
            },
          ]
        : []
    )
  }

  async reconcileInvocationSource(params: {
    workspaceId: string
    sourceMessageId: string
  }): Promise<Array<{ botId: string; streamId: string; rootStreamId: string; contentMarkdown: string }>> {
    return withTransaction(this.pool, (db) => this.reconcileInvocationSourceInTransaction(db, params))
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
  }): Promise<{ invocation: BotInvocation; wasNewlyInserted: boolean }> {
    return withTransaction(this.pool, (db) => this.createInvocationInTransaction(db, params))
  }

  /**
   * Inserts a `bot_invocations` row and emits `bot_invocation:available` in the
   * same tx — but only when the insert actually created a new row. The idempotent
   * conflict path returns the existing invocation untouched (`wasNewlyInserted:
   * false`) so we do not re-push duplicates to listeners after a retried HTTP
   * call, and so dispatch can report the turn as deduplicated.
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
  ): Promise<{ invocation: BotInvocation; wasNewlyInserted: boolean }> {
    await assertStreamWritable(db, {
      workspaceId: params.workspaceId,
      streamId: params.responseStreamId,
      principal: { kind: "bot", botId: params.actorId },
    })
    const source =
      params.trigger === "session-control"
        ? null
        : await MessageRepository.findInvocationSourceStateForShare(db, {
            workspaceId: params.workspaceId,
            messageId: params.sourceMessageId,
          })
    if (
      params.trigger !== "session-control" &&
      (!source || source.deleted || source.streamId !== params.activeStreamId)
    ) {
      throw new Error(`Invocation source is unavailable: ${params.sourceMessageId}`)
    }
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
      promptMarkdown: source ? buildCanonicalInvocationPrompt(source) : params.promptMarkdown,
      sourceMessageRevision: source?.revision ?? 0,
      authorUserId: params.authorUserId,
      mentionedActorSlugs: params.mentionedActorSlugs ?? [],
      targetInstanceId: params.targetInstanceId ?? null,
      targetRuntimeSessionId: params.targetRuntimeSessionId ?? null,
      metadata: params.metadata ?? {},
    })
    if (
      invocation.workspaceId !== params.workspaceId ||
      invocation.actorType !== "bot" ||
      invocation.actorId !== params.actorId
    ) {
      throw new Error("Idempotent bot invocation identity mismatch")
    }
    if (wasNewlyInserted) await this.emitAvailabilityHint(db, invocation)
    return { invocation, wasNewlyInserted }
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
    recentCancellations: BotInvocationCancellation[]
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
        const bootstrap = await BotInvocationRepository.findBootstrapInvocations(db, {
          workspaceId: params.workspaceId,
          botId: params.botId,
          instanceId: params.instanceId,
          runtimeSessionId: params.runtimeSessionId ?? null,
          supportedCapabilities: params.supportedCapabilities,
          since,
          maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
        })
        const activeActorByStream = await StreamActiveActorRepository.findActiveForBot(db, {
          workspaceId: params.workspaceId,
          botId: params.botId,
        })
        const activeSessionLinks = await BotRuntimeSessionLinkRepository.findActiveByBotInstance(db, {
          workspaceId: params.workspaceId,
          botId: params.botId,
          instanceId: params.instanceId,
        })
        await db.query("COMMIT")
        return {
          serverGeneratedAt: now,
          available: bootstrap.available,
          ownedClaims: bootstrap.ownedClaims,
          recentCancellations: bootstrap.recentCancellations,
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
    /** Only claim invocations answering into this stream (see `claimOne`). */
    responseStreamId?: string
  }): Promise<BotInvocation | null> {
    // Parking is independent lifecycle cleanup. Commit it before taking any
    // stream authority locks so exhausted-row cleanup can never invert the
    // stream-first order used by invocation creation and callback acceptance.
    const parked = await withTransaction(this.pool, (db) =>
      BotInvocationRepository.parkExhausted(db, {
        workspaceId: params.workspaceId,
        botId: params.botId,
        maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
      })
    )
    for (const invocation of parked) {
      logger.warn(
        {
          invocationId: invocation.id,
          workspaceId: invocation.workspaceId,
          botId: invocation.actorId,
          attempts: invocation.attempts,
        },
        "Parked bot invocation after exhausting claim attempts"
      )
    }

    try {
      return await withTransaction(this.pool, async (db) => {
        // Snapshot only: authority must lock the effective stream/root and grant
        // before claimOne takes the invocation row lock. claimOne is then scoped
        // to the same response stream; if this exact candidate lost a race it may
        // claim the next FIFO row for that already-authorized stream, or no-op.
        const candidate = await BotInvocationRepository.findNextClaimable(db, {
          ...params,
          maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
        })
        if (!candidate) return null

        let authorityDenial: { details?: { reason?: string } } | null = null
        try {
          await assertStreamWritable(db, {
            workspaceId: candidate.workspaceId,
            streamId: candidate.responseStreamId,
            principal: { kind: "bot", botId: candidate.actorId },
          })
        } catch (error) {
          const denial = error as { code?: string; details?: { reason?: string } }
          if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") throw error
          authorityDenial = denial
        }

        for (;;) {
          const claimed = await BotInvocationRepository.claimOne(db, {
            ...params,
            responseStreamId: candidate.responseStreamId,
            maxAttempts: BOT_CLAIM_MAX_ATTEMPTS,
          })
          if (!claimed) return null
          let pinned = claimed
          if (claimed.trigger !== "session-control") {
            const source = await MessageRepository.findInvocationSourceStateForShare(db, {
              workspaceId: claimed.workspaceId,
              messageId: claimed.sourceMessageId,
            })
            const cancelCandidate = async (reason: "source_deleted" | "routing_changed") => {
              const cancelled = await BotInvocationRepository.cancelClaim(db, {
                workspaceId: claimed.workspaceId,
                invocationId: claimed.id,
                instanceId: params.instanceId,
                claimToken: params.claimToken,
                reason,
              })
              if (!cancelled) throw new ClaimCandidateFenceLost()
              await this.terminalizeCancelledSessions(
                db,
                claimed.workspaceId,
                [cancelled],
                reason === "source_deleted" ? "deleted" : "superseded"
              )
            }
            if (!source || source.deleted) {
              await cancelCandidate(source?.deleted ? "source_deleted" : "routing_changed")
              continue
            }
            // A bot that lost write authority fails below with the reason; the
            // resolver would only drop it as undesired and hide why.
            const promptMarkdown = authorityDenial
              ? claimed.promptMarkdown
              : (await resolveCanonicalInvocationRoutes(db, source)).find(
                  (candidate) =>
                    !candidate.missingLinkNotice &&
                    candidate.actorId === claimed.actorId &&
                    candidate.trigger === claimed.trigger &&
                    candidate.activeStreamId === claimed.activeStreamId &&
                    candidate.responseStreamId === claimed.responseStreamId &&
                    candidate.targetInstanceId === claimed.targetInstanceId &&
                    candidate.targetRuntimeSessionId === claimed.targetRuntimeSessionId
                )?.promptMarkdown
            if (promptMarkdown === undefined) {
              await cancelCandidate("routing_changed")
              continue
            }
            const refreshed = await BotInvocationRepository.pinClaimSource(db, {
              workspaceId: claimed.workspaceId,
              invocationId: claimed.id,
              instanceId: params.instanceId,
              claimToken: params.claimToken,
              revision: source.revision,
              promptMarkdown,
            })
            if (!refreshed) throw new ClaimCandidateFenceLost()
            pinned = refreshed
          }
          // The pin above is what lets failClaim's source-revision fence match.
          if (authorityDenial) {
            await BotInvocationRepository.failClaim(db, {
              workspaceId: pinned.workspaceId,
              botId: pinned.actorId,
              invocationId: pinned.id,
              instanceId: params.instanceId,
              claimToken: params.claimToken,
              errorMessage: `STREAM_READ_ONLY:${authorityDenial.details?.reason ?? "not_a_member"}`,
            })
            return null
          }

          // Siblings on the same bot need to stop racing this invocation. The
          // narrow payload deliberately omits the winning instance — see
          // `BotInvocationClaimedOutboxPayload`.
          await OutboxRepository.insert(db, "bot_invocation:claimed", {
            workspaceId: pinned.workspaceId,
            botId: pinned.actorId,
            invocationId: pinned.id,
          })
          return pinned
        }
      })
    } catch (error) {
      if (error instanceof ClaimCandidateFenceLost) return null
      throw error
    }
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

  async findInvocationForCallback(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId?: string
      claimToken: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.findForCallback(db, params)
  }

  async findActiveClaimForUpdate(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId?: string
      claimToken: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.findActiveClaimForUpdate(db, params)
  }

  async findActiveClaimForUpdateByToken(
    db: Querier,
    params: { workspaceId: string; botId: string; invocationId: string; claimToken: string }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.findActiveClaimForUpdate(db, params)
  }

  async findCompletedInvocationForReplay(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      claimToken: string
      instanceId?: string
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.findCompletedForReplay(db, params)
  }

  /** Share-lock the active runtime identity that authorizes a completed claim's late writes. */
  async findActiveSessionLinkForCompletedClaim(
    db: Querier,
    params: { workspaceId: string; botId: string; instanceId: string; runtimeSessionId: string }
  ): Promise<BotRuntimeSessionLink | null> {
    return BotRuntimeSessionLinkRepository.findActiveByRuntimeSessionForShare(db, params)
  }

  async validateClaimSourceForCompletion(
    db: Querier,
    claim: BotInvocation,
    suppliedRevision?: number
  ): Promise<boolean> {
    if (claim.trigger === "session-control")
      return claim.claimedSourceMessageRevision === 0 && (suppliedRevision == null || suppliedRevision === 0)
    const source = await MessageRepository.findInvocationSourceStateForShare(db, {
      workspaceId: claim.workspaceId,
      messageId: claim.sourceMessageId,
    })
    if (!source || source.deleted || source.streamId !== claim.activeStreamId) return false
    if (suppliedRevision == null) return source.revision === claim.claimedSourceMessageRevision
    if (suppliedRevision === claim.claimedSourceMessageRevision) return source.revision === suppliedRevision
    return (
      claim.claimedInputUpdateMode === "live" &&
      suppliedRevision > (claim.claimedSourceMessageRevision ?? -1) &&
      suppliedRevision === source.revision
    )
  }

  async reconcileStaleCompletionInTransaction(db: Querier, claim: BotInvocation): Promise<void> {
    const source =
      claim.trigger === "session-control"
        ? null
        : await MessageRepository.findInvocationSourceStateForShare(db, {
            workspaceId: claim.workspaceId,
            messageId: claim.sourceMessageId,
          })
    if (claim.claimedByInstanceId == null || claim.claimToken == null || claim.claimedSourceMessageRevision == null)
      return
    const cancelled = await BotInvocationRepository.cancelClaim(db, {
      workspaceId: claim.workspaceId,
      botId: claim.actorId,
      invocationId: claim.id,
      reason: "input_stale",
      instanceId: claim.claimedByInstanceId,
      claimToken: claim.claimToken,
      expectedClaimedRevision: claim.claimedSourceMessageRevision,
      bumpToRevision: source?.revision ?? claim.sourceMessageRevision,
    })
    if (!cancelled) return
    await this.terminalizeCancelledSessions(db, claim.workspaceId, [cancelled], "superseded")
    await this.emitCancellationHints(db, [cancelled])
    if (claim.trigger === "session-control") return
    await this.reconcileInvocationSourceInTransaction(
      db,
      { workspaceId: claim.workspaceId, sourceMessageId: claim.sourceMessageId },
      { locksHeld: true, source }
    )
  }

  async renewInvocationClaimInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId: string
      claimToken: string
      claimTtlSeconds: number
      knownSourceRevision?: number
      restartRequiredRevision?: number
    }
  ): Promise<BotInvocation | null> {
    let control = await BotInvocationRepository.findClaimControl(db, params)
    if (!control) return null
    if (control.status === "cancelled") return control
    if (control.trigger !== "session-control") {
      const source = await MessageRepository.findInvocationSourceStateForShare(db, {
        workspaceId: params.workspaceId,
        messageId: control.sourceMessageId,
      })
      // `findClaimControl` owns the source and current-actor advisory locks, but
      // reconciliation can discover other actors after opening the canonical
      // source. Let the repositories acquire that complete actor set rather
      // than pretending the one claim's actor lock covers every route.
      await this.reconcileInvocationSourceInTransaction(
        db,
        { workspaceId: params.workspaceId, sourceMessageId: control.sourceMessageId },
        { source }
      )
    }
    control = await BotInvocationRepository.findClaimControl(db, params, { locksHeld: true })
    if (!control || control.status === "cancelled") return control
    if (
      params.knownSourceRevision != null &&
      (params.knownSourceRevision < (control.claimedSourceMessageRevision ?? 0) ||
        params.knownSourceRevision > control.sourceMessageRevision)
    )
      return null
    if (params.restartRequiredRevision != null) {
      if (
        control.claimedInputUpdateMode !== "live" ||
        params.restartRequiredRevision !== control.sourceMessageRevision ||
        params.restartRequiredRevision <= (control.claimedSourceMessageRevision ?? 0) ||
        params.knownSourceRevision !== params.restartRequiredRevision
      )
        return null
      const cancelled = await BotInvocationRepository.cancelClaim(db, {
        workspaceId: params.workspaceId,
        invocationId: params.invocationId,
        reason: "adapter_restart_required",
        instanceId: params.instanceId,
        claimToken: params.claimToken,
        expectedSourceRevision: params.restartRequiredRevision,
        bumpToRevision: params.restartRequiredRevision,
      })
      if (!cancelled) return null
      await this.terminalizeCancelledSessions(db, params.workspaceId, [cancelled], "superseded")
      await this.emitCancellationHints(db, [cancelled])
      if (cancelled.trigger !== "session-control") {
        const source = await MessageRepository.findInvocationSourceStateForShare(db, {
          workspaceId: params.workspaceId,
          messageId: cancelled.sourceMessageId,
        })
        await this.reconcileInvocationSourceInTransaction(
          db,
          { workspaceId: params.workspaceId, sourceMessageId: cancelled.sourceMessageId },
          { locksHeld: true, source }
        )
      }
      return cancelled
    }
    return BotInvocationRepository.renewClaim(db, params)
  }

  async renewInvocationClaim(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
    claimTtlSeconds: number
    knownSourceRevision?: number
    restartRequiredRevision?: number
  }): Promise<BotInvocation | null> {
    return withTransaction(this.pool, (db) => this.renewInvocationClaimInTransaction(db, params))
  }

  async cancelOwnedClaimForKeyGrantLossInTransaction(
    db: Querier,
    control: BotInvocation
  ): Promise<BotInvocation | null> {
    if (control.status !== "claimed" || control.claimedByInstanceId == null || control.claimToken == null)
      return control
    const cancelled = await BotInvocationRepository.cancelClaim(db, {
      workspaceId: control.workspaceId,
      invocationId: control.id,
      reason: "key_grant_lost",
      instanceId: control.claimedByInstanceId,
      claimToken: control.claimToken,
      expectedSourceRevision: control.sourceMessageRevision,
      bumpToRevision: control.sourceMessageRevision,
    })
    if (!cancelled) return null
    await this.terminalizeCancelledSessions(db, control.workspaceId, [cancelled], "superseded")
    await this.emitCancellationHints(db, [cancelled])
    return cancelled
  }

  async completeInvocation(params: {
    workspaceId: string
    botId: string
    invocationId: string
    instanceId: string
    claimToken: string
    sourceRevision: number
  }): Promise<BotInvocation | null> {
    return BotInvocationRepository.completeClaim(this.pool, params)
  }

  // `instanceId` is optional: the sealed bot completion authenticates by the
  // per-claim callback token and omits it (see `completeClaim`).
  async completeInvocationInTransaction(
    db: Querier,
    params: {
      workspaceId: string
      botId: string
      invocationId: string
      instanceId?: string
      claimToken: string
      sourceRevision: number
    }
  ): Promise<BotInvocation | null> {
    return BotInvocationRepository.completeClaim(db, params, { locksHeld: true })
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
      instanceId?: string
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
