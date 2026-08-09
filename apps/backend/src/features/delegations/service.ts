import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import { delegationId, eventId, streamContextItemId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import {
  AuthorTypes,
  type AuthorType,
  type DelegationCreatedEventPayload,
  type DelegationReopenReason,
  type DelegationStatusChangedEventPayload,
} from "@threa/types"
import { assertStreamWritable, StreamEventRepository, StreamRepository, type StreamWritePrincipal } from "../streams"
import { StreamContextRepository, contextSnippet } from "../stream-context"
import { hashCallbackToken } from "../agents"
import { DELEGATION_CLAIM_TTL_SECONDS } from "./config"
import { DelegatedTaskRepository, type DelegatedTask, type DelegatedTaskWithEvent } from "./repository"

/** The outbox event type that carries each delegation timeline event to the stream room. */
const DELEGATION_OUTBOX_EVENT_TYPE = {
  "delegation:created": "stream:delegation_created",
  "delegation:status_changed": "stream:delegation_status_changed",
} as const

interface DelegationServiceDeps {
  pool: Pool
  /** Claim TTL override for tests; production uses the config default. */
  claimTtlSeconds?: number
}

export interface CreateDelegationParams {
  workspaceId: string
  streamId: string
  sessionId: string | null
  sourceConversationId: string | null
  createdByKind: AuthorType
  createdById: string
  title: string
  brief: string
  contextRefs: string[]
}

export type ClaimDelegationResult =
  | { ok: true; delegation: DelegatedTask; claimToken: string }
  | { ok: false; reason: "not_found" | "not_open" }

/**
 * Lifecycle owner for delegated tasks (roadmap 5.1). A delegation is a durable
 * hand-off from a companion turn to the user's local agent: Threa compiles the
 * brief, the local agent claims it via the public API (5.3) and executes with
 * the user's own credentials. Sessions stay minutes-bounded (INV-65) — this
 * substrate is where longer-horizon work goes instead.
 *
 * Every transition appends a timeline event in the same transaction as the
 * status CAS (INV-4/7): `delegation:created` is the visible card row; every
 * later transition is a `delegation:status_changed` patch on it, so the card
 * can never sit on stale state.
 *
 * Concurrency model (INV-20): claim CASes on `open|expired`, cancel on any
 * recoverable status, and claim-authenticated transitions guard on the token
 * hash + unexpired TTL — so claim-vs-cancel resolves to exactly one winner and
 * a lapsed claim can act on nothing.
 */
export class DelegationService {
  private readonly pool: Pool
  private readonly claimTtlSeconds: number

  constructor(deps: DelegationServiceDeps) {
    this.pool = deps.pool
    this.claimTtlSeconds = deps.claimTtlSeconds ?? DELEGATION_CLAIM_TTL_SECONDS
  }

  /** Create an open delegation and its visible card row atomically. */
  async create(params: CreateDelegationParams): Promise<DelegatedTask> {
    return this.createWithAuthority(params)
  }

  async createGenerated(
    principal: StreamWritePrincipal,
    params: CreateDelegationParams & { requestedStreamId: string }
  ): Promise<DelegatedTask> {
    return this.createWithAuthority(params, principal)
  }

  private async createWithAuthority(
    params: CreateDelegationParams & { requestedStreamId?: string },
    principal?: StreamWritePrincipal
  ): Promise<DelegatedTask> {
    return withTransaction(this.pool, async (client) => {
      if (principal) {
        await assertStreamWritable(client, {
          workspaceId: params.workspaceId,
          streamId: params.requestedStreamId ?? params.streamId,
          principal,
        })
      }
      const inserted = await DelegatedTaskRepository.insert(client, {
        id: delegationId(),
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        sessionId: params.sessionId,
        sourceConversationId: params.sourceConversationId,
        createdByKind: params.createdByKind,
        createdById: params.createdById,
        title: params.title,
        brief: params.brief,
        contextRefs: params.contextRefs,
      })

      const payload: DelegationCreatedEventPayload = {
        delegationId: inserted.id,
        title: inserted.title,
        brief: inserted.brief,
        contextRefs: inserted.contextRefs,
        sourceConversationId: inserted.sourceConversationId,
      }
      await this.appendDelegationEvent(client, {
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        eventType: "delegation:created",
        payload,
        actorId: params.createdById,
        actorType: params.createdByKind,
      })

      // "In this stream" landmark. Sealed streams are never indexed.
      const stream = await StreamRepository.findById(client, params.streamId)
      if (!stream) {
        logger.warn(
          { workspaceId: params.workspaceId, streamId: params.streamId, delegationId: inserted.id },
          "Delegation created against a missing stream row, skipping context landmark"
        )
      }
      if (stream && stream.e2eEnabled !== true) {
        await StreamContextRepository.insertMany(client, [
          {
            id: streamContextItemId(),
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            rootStreamId: stream.rootStreamId ?? stream.id,
            category: "delegation",
            refKind: "delegation",
            refId: inserted.id,
            groupKey: inserted.id,
            sourceMessageId: null,
            authorId: params.createdByKind === AuthorTypes.USER ? params.createdById : null,
            occurredAt: inserted.createdAt,
            sequence: null,
            snippet: contextSnippet(inserted.title),
            detail: { title: inserted.title },
          },
        ])
      }

      return inserted
    })
  }

  /** Read a delegation, workspace-scoped. Single query — pass the pool (INV-30). */
  async getById(params: { workspaceId: string; id: string }): Promise<DelegatedTask | null> {
    return DelegatedTaskRepository.findById(this.pool, params.workspaceId, params.id)
  }

  /**
   * Read a delegation plus its `delegation:created` event id — the first-party
   * by-id GET and the link-preview resolver, both of which deep-link the card.
   */
  async getByIdWithEvent(params: { workspaceId: string; id: string }): Promise<DelegatedTaskWithEvent | null> {
    return DelegatedTaskRepository.findByIdWithEvent(this.pool, params.workspaceId, params.id)
  }

  /** A workspace's claimable delegations, oldest first (the 5.3 list surface). */
  async listOpen(params: { workspaceId: string; since?: Date }): Promise<DelegatedTask[]> {
    return DelegatedTaskRepository.listOpen(this.pool, params.workspaceId, { since: params.since })
  }

  /** A stream's delegations with live statuses, newest first (the "In this stream" panel). */
  async listByStream(params: { workspaceId: string; streamId: string }): Promise<DelegatedTaskWithEvent[]> {
    return DelegatedTaskRepository.listByStream(this.pool, params.workspaceId, params.streamId)
  }

  /**
   * Cancel a non-terminal delegation — a person's action from the card (or the
   * creating persona changing its mind). Cancelling a claimed/running task is
   * deliberate: the executing agent's next token-guarded write no-ops and it
   * discovers the cancellation then. Returns `null` when the delegation already
   * reached a terminal state (the cancel lost the race).
   */
  async cancel(params: {
    workspaceId: string
    id: string
    streamId?: string
    cancelledBy: { actorId: string; actorType: AuthorType }
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await DelegatedTaskRepository.markCancelled(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        streamId: params.streamId,
      })
      if (!cancelled) return null
      await this.appendStatusEvent(client, cancelled, params.cancelledBy)
      return cancelled
    })
  }

  /**
   * A person's "Mark as done" from the card — the terminal transition for work
   * executed outside the API loop (the copy-paste path). Same access model as
   * cancel; the acting user is the event's actor. No result message is linked —
   * the doer reports in chat like any human. Returns `null` when the delegation
   * already reached a terminal state (the mark-done lost the race).
   */
  async markDone(params: {
    workspaceId: string
    id: string
    streamId?: string
    completedBy: { actorId: string; actorType: AuthorType }
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const done = await DelegatedTaskRepository.markDone(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        streamId: params.streamId,
      })
      if (!done) return null
      await this.appendStatusEvent(client, done, params.completedBy)
      return done
    })
  }

  /**
   * Claim an open delegation for a local agent (the 5.3 claim endpoint's core).
   * Mints the claim token here — the cleartext goes back to the claimer once,
   * only its hash is stored (a DB read can never impersonate a claim).
   *
   * `idempotencyKey` (persisted by the runner BEFORE calling) makes the claim
   * crash-recoverable: a retry bearing the key of the delegation's live claim
   * re-keys it — fresh token, fresh lease, old token dead — instead of a 409
   * that strands the task until expiry. No status change, so no card event.
   */
  async claim(params: {
    workspaceId: string
    id: string
    claimedByLabel: string
    idempotencyKey?: string
  }): Promise<ClaimDelegationResult> {
    const claimToken = randomUUID()
    const result = await withTransaction(this.pool, async (client) => {
      const claimed = await DelegatedTaskRepository.claim(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        claimTokenHash: hashCallbackToken(claimToken),
        claimIdempotencyKey: params.idempotencyKey ?? null,
        claimedByLabel: params.claimedByLabel,
        ttlSeconds: this.claimTtlSeconds,
      })
      if (!claimed) return null
      await this.appendStatusEvent(client, claimed, SYSTEM_ACTOR)
      return claimed
    })
    if (result) return { ok: true, delegation: result, claimToken }

    if (params.idempotencyKey) {
      const rekeyed = await DelegatedTaskRepository.reclaimByIdempotencyKey(this.pool, {
        workspaceId: params.workspaceId,
        id: params.id,
        claimIdempotencyKey: params.idempotencyKey,
        claimTokenHash: hashCallbackToken(claimToken),
        ttlSeconds: this.claimTtlSeconds,
      })
      if (rekeyed) return { ok: true, delegation: rekeyed, claimToken }
    }

    // Failure-path read only classifies the error (nothing mutated).
    const existing = await DelegatedTaskRepository.findById(this.pool, params.workspaceId, params.id)
    return { ok: false, reason: existing ? "not_open" : "not_found" }
  }

  async release(params: { workspaceId: string; id: string; claimToken: string }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const reopened = await DelegatedTaskRepository.release(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        claimTokenHash: hashCallbackToken(params.claimToken),
      })
      if (!reopened) return null
      await this.appendStatusEvent(client, reopened, SYSTEM_ACTOR, { reason: "claim_released" })
      return reopened
    })
  }

  async requeue(params: {
    workspaceId: string
    id: string
    streamId?: string
    requeuedBy: { actorId: string; actorType: AuthorType }
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const reopened = await DelegatedTaskRepository.requeue(client, params)
      if (!reopened) return null
      await this.appendStatusEvent(client, reopened, params.requeuedBy, { reason: "requeued" })
      return reopened
    })
  }

  /**
   * Heartbeat: push the claim's expiry forward. No status change, no event —
   * liveness is not card-visible state. Returns the fresh expiry or `null`
   * when the claim is gone (lapsed, cancelled, or not this holder's).
   */
  async heartbeat(params: { workspaceId: string; id: string; claimToken: string }): Promise<Date | null> {
    const renewed = await DelegatedTaskRepository.renewClaim(this.pool, {
      workspaceId: params.workspaceId,
      id: params.id,
      claimTokenHash: hashCallbackToken(params.claimToken),
      ttlSeconds: this.claimTtlSeconds,
    })
    return renewed?.claimExpiresAt ?? null
  }

  /**
   * Progress report: `claimed|running → running`, carrying an optional free-text
   * note onto the card. Repeat reports are legitimate (each replaces the note)
   * and every one renews the claim TTL — a reporting agent is a live agent.
   */
  async markRunning(params: {
    workspaceId: string
    id: string
    claimToken: string
    statusNote?: string
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const running = await DelegatedTaskRepository.markRunning(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        claimTokenHash: hashCallbackToken(params.claimToken),
        ttlSeconds: this.claimTtlSeconds,
        statusNote: params.statusNote ?? null,
      })
      if (!running) return null
      await this.appendStatusEvent(client, running, SYSTEM_ACTOR)
      return running
    })
  }

  /** Terminal success: `claimed|running → completed`, linking the result message when given. */
  async complete(params: {
    workspaceId: string
    id: string
    claimToken: string
    resultMessageId?: string
    threadStreamId?: string
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, (client) => this.completeInTransaction(client, params))
  }

  /**
   * The delegation's `delegation:created` event id — the card its result thread
   * anchors on. Callable on a transaction client so the completion flow resolves
   * the anchor inside its claim-locked envelope (INV-30 single query → the
   * caller's querier).
   */
  async findCreatedEventId(client: PoolClient, params: { workspaceId: string; id: string }): Promise<string | null> {
    return DelegatedTaskRepository.findCreatedEventId(client, params.workspaceId, params.id)
  }

  /**
   * Lock the live claim (token-validated, FOR UPDATE) inside the caller's
   * transaction — the completion flow validates the claim BEFORE writing the
   * result message, so an invalid or lapsed token does no work (the
   * `findActiveClaimForUpdate` shape from bot-invocations).
   */
  async findClaimedForUpdate(
    client: PoolClient,
    params: { workspaceId: string; id: string; claimToken: string }
  ): Promise<DelegatedTask | null> {
    return DelegatedTaskRepository.findClaimedForUpdate(client, {
      workspaceId: params.workspaceId,
      id: params.id,
      claimTokenHash: hashCallbackToken(params.claimToken),
    })
  }

  /**
   * Transaction-scoped completion for callers that pair the CAS with other
   * writes — the public API posts the result message via
   * `eventService.createMessageInTransaction` in the same transaction, so a
   * lost claim race rolls the message back with the CAS (the
   * `completeBotInvocation` shape).
   */
  async completeInTransaction(
    client: PoolClient,
    params: { workspaceId: string; id: string; claimToken: string; resultMessageId?: string; threadStreamId?: string }
  ): Promise<DelegatedTask | null> {
    const completed = await DelegatedTaskRepository.complete(client, {
      workspaceId: params.workspaceId,
      id: params.id,
      claimTokenHash: hashCallbackToken(params.claimToken),
      resultMessageId: params.resultMessageId ?? null,
    })
    if (!completed) return null
    await this.appendStatusEvent(client, completed, SYSTEM_ACTOR, { threadStreamId: params.threadStreamId })
    return completed
  }

  /** Terminal failure: `claimed|running → failed`, recording why. */
  async fail(params: {
    workspaceId: string
    id: string
    claimToken: string
    statusNote: string
  }): Promise<DelegatedTask | null> {
    return withTransaction(this.pool, async (client) => {
      const failed = await DelegatedTaskRepository.fail(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        claimTokenHash: hashCallbackToken(params.claimToken),
        statusNote: params.statusNote,
      })
      if (!failed) return null
      await this.appendStatusEvent(client, failed, SYSTEM_ACTOR)
      return failed
    })
  }

  /**
   * Expiry-sweep entry: CAS every lapsed claim back to `open` (set-based, INV-56)
   * and append each card's status event in the same transaction. Concurrent
   * sweeps are idempotent — the loser's UPDATE matches nothing.
   */
  async reopenLapsedClaims(): Promise<DelegatedTask[]> {
    return withTransaction(this.pool, async (client) => {
      const reopened = await DelegatedTaskRepository.reopenLapsedClaims(client)
      for (const delegation of reopened) {
        await this.appendStatusEvent(client, delegation, SYSTEM_ACTOR, { reason: "claim_expired" })
      }
      if (reopened.length > 0) {
        logger.info(
          { count: reopened.length, delegationIds: reopened.map((d) => d.id) },
          "delegation claims reopened by sweep"
        )
      }
      return reopened
    })
  }

  /**
   * Append the patch event that advances the card to the row's current status,
   * inside the caller's transaction (INV-4/7). One payload type carries every
   * transition; the optional fields reflect whatever the row now holds.
   */
  private async appendStatusEvent(
    client: PoolClient,
    delegation: DelegatedTask,
    actor: { actorId?: string; actorType: AuthorType },
    extra: { threadStreamId?: string; reason?: DelegationReopenReason } = {}
  ): Promise<void> {
    const payload: DelegationStatusChangedEventPayload = {
      delegationId: delegation.id,
      status: delegation.status,
      reason: extra.reason,
      claimedByLabel: delegation.claimedByLabel,
      resultMessageId: delegation.resultMessageId,
      threadStreamId: extra.threadStreamId,
      statusNote: delegation.statusNote,
    }
    await this.appendDelegationEvent(client, {
      workspaceId: delegation.workspaceId,
      streamId: delegation.streamId,
      eventType: "delegation:status_changed",
      payload,
      actorId: actor.actorId,
      actorType: actor.actorType,
    })
  }

  /**
   * Append a delegation timeline event (+ its outbox row) inside the caller's
   * transaction. Same envelope as the follow-up events: the full stream event
   * rides on the outbox payload so clients append it without a fetch.
   */
  private async appendDelegationEvent(
    client: PoolClient,
    params: {
      workspaceId: string
      streamId: string
      eventType: keyof typeof DELEGATION_OUTBOX_EVENT_TYPE
      payload: DelegationCreatedEventPayload | DelegationStatusChangedEventPayload
      actorId?: string
      actorType: AuthorType
    }
  ): Promise<void> {
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: params.streamId,
      eventType: params.eventType,
      payload: params.payload,
      actorId: params.actorId,
      actorType: params.actorType,
    })
    await OutboxRepository.insert(client, DELEGATION_OUTBOX_EVENT_TYPE[params.eventType], {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event,
    })
  }
}

/**
 * Machine transitions (claim/running/complete/fail/reopen) act as the system
 * (no actorId, like `memos:captured`): the executing local agent is not a
 * workspace actor — `claimedByLabel` on the payload carries its human-readable
 * identity instead.
 */
const SYSTEM_ACTOR = { actorType: AuthorTypes.SYSTEM } as const
