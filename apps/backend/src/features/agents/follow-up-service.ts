import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import { agentFollowUpId, agentFollowUpQueueId, queueId, eventId, streamContextItemId } from "../../lib/id"
import { JobQueues, QueueRepository, enqueueQueuedJob, type PersonaAgentJobData } from "../../lib/queue"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import {
  AuthorTypes,
  FollowUpStatuses,
  type AuthorType,
  type AgentFollowUpScheduledEventPayload,
  type AgentFollowUpCancelledEventPayload,
} from "@threa/types"
import { assertStreamWritable, StreamEventRepository, StreamRepository } from "../streams"
import { MessageRepository } from "../messaging"
import { AgentSessionRepository } from "./session-repository"
import { StreamContextRepository, contextSnippet } from "../stream-context"
import { AgentFollowUpRepository, type AgentFollowUp } from "./follow-up-repository"

/** The outbox event type that carries each follow-up timeline event to the stream room. */
const FOLLOW_UP_OUTBOX_EVENT_TYPE = {
  "agent:follow_up_scheduled": "stream:agent_follow_up_scheduled",
  "agent:follow_up_cancelled": "stream:agent_follow_up_cancelled",
} as const

/** Resolves the per-workspace follow-up cap (roadmap 1.4). Narrowed so tests can stub it. */
export interface FollowUpLimitResolver {
  getSettings(workspaceId: string): Promise<{ maxPendingFollowUps: number }>
}

interface AgentFollowUpServiceDeps {
  pool: Pool
  workspaceSettingsService: FollowUpLimitResolver
}

export interface ScheduleFollowUpParams {
  workspaceId: string
  streamId: string
  requestedStreamId: string
  initiatingUserId: string
  personaId: string
  sessionId: string
  sourceConversationId: string | null
  note: string
  scheduledFor: Date
}

export type ScheduleFollowUpResult =
  | { ok: true; followUp: AgentFollowUp; pendingCount: number; limit: number }
  | { ok: false; reason: "cap_reached"; pendingCount: number; limit: number }

export type UpdateFollowUpResult =
  | { ok: true; followUp: AgentFollowUp }
  | { ok: false; reason: "not_found" | "not_pending" }

/**
 * Lifecycle owner for agent follow-ups (roadmap 1.1). A follow-up is a durable,
 * cancellable row that fires by enqueuing a PERSONA_AGENT job — never by
 * authoring a message as the user (that's what scheduled_messages does, and why
 * this is a separate substrate).
 *
 * Concurrency model:
 *  - Firing and cancelling both CAS on `status = 'pending'`, so exactly one wins.
 *    A cancel that lands first makes the fire worker's CAS return null (no-op);
 *    a fire that lands first makes cancel return null (race reported to caller).
 *  - The PERSONA_AGENT enqueue happens in the same transaction as the
 *    `pending → fired` CAS (INV-7), so a fired row always has its turn queued.
 */
export class AgentFollowUpService {
  private readonly pool: Pool
  private readonly workspaceSettingsService: FollowUpLimitResolver

  constructor(deps: AgentFollowUpServiceDeps) {
    this.pool = deps.pool
    this.workspaceSettingsService = deps.workspaceSettingsService
  }

  /**
   * The per-stream pending cap: the workspace override, or the code default when
   * unset (roadmap 1.4). `getSettings` always returns a resolved
   * `maxPendingFollowUps` — sparse override merged onto `DEFAULT_WORKSPACE_SETTINGS`
   * — so the caller never falls back here. Resolved before the insert transaction
   * so no DB connection is held across it (INV-41).
   */
  private async resolveFollowUpLimit(workspaceId: string): Promise<number> {
    const settings = await this.workspaceSettingsService.getSettings(workspaceId)
    return settings.maxPendingFollowUps
  }

  /**
   * Create a follow-up and enqueue its fire job, subject to the per-stream
   * pending cap. Returns `{ ok: false, reason: "cap_reached" }` (no row written)
   * when the stream is already at the cap so the tool can tell the model to try
   * fewer.
   */
  async schedule(params: ScheduleFollowUpParams): Promise<ScheduleFollowUpResult> {
    const limit = await this.resolveFollowUpLimit(params.workspaceId)

    return withTransaction(this.pool, async (client) => {
      await assertStreamWritable(client, {
        workspaceId: params.workspaceId,
        streamId: params.requestedStreamId,
        principal: { kind: "user", userId: params.initiatingUserId },
      })

      // Serialize concurrent creates for the same stream so the count-guarded
      // insert sees an exact pending count (INV-20). Distinct personas can run
      // sessions in one stream at the same time, so without this two near-cap
      // schedules could each read the pre-insert count and both land. The lock
      // is transaction-scoped and released on commit/rollback.
      await AgentFollowUpRepository.acquireStreamCapLock(client, params.workspaceId, params.streamId)

      const inserted = await AgentFollowUpRepository.insertIfUnderCap(
        client,
        {
          id: agentFollowUpId(),
          workspaceId: params.workspaceId,
          streamId: params.streamId,
          personaId: params.personaId,
          sessionId: params.sessionId,
          sourceConversationId: params.sourceConversationId,
          note: params.note,
          scheduledFor: params.scheduledFor,
        },
        limit
      )

      if (!inserted) {
        const pendingCount = await AgentFollowUpRepository.countPending(client, params.workspaceId, params.streamId)
        return { ok: false, reason: "cap_reached", pendingCount, limit }
      }

      const queueMessageId = await enqueueQueuedJob(client, {
        queueName: JobQueues.AGENT_FOLLOW_UP_FIRE,
        workspaceId: params.workspaceId,
        payload: { workspaceId: params.workspaceId, followUpId: inserted.id },
        processAfter: inserted.scheduledFor,
        generateId: agentFollowUpQueueId,
      })
      await AgentFollowUpRepository.setQueueMessageId(client, params.workspaceId, inserted.id, queueMessageId)

      // Scheduled agent work is never invisible state (roadmap 1.3): append the
      // capture-style broadcast row in the same transaction as the insert
      // (INV-4/7) so every stream member sees the follow-up and can cancel it.
      // The persona is the actor — it scheduled the row.
      await this.appendFollowUpEvent(client, {
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        eventType: "agent:follow_up_scheduled",
        payload: {
          followUpId: inserted.id,
          note: inserted.note,
          scheduledFor: inserted.scheduledFor.toISOString(),
          sourceConversationId: inserted.sourceConversationId,
        },
        actorId: params.personaId,
        actorType: AuthorTypes.PERSONA,
      })

      // "In this stream" landmark. Sealed streams are never indexed. Status and
      // `scheduledFor` are mutable, so they stay out of `detail` and are joined
      // live on read — a stored copy would show a cancelled follow-up as pending.
      const stream = await StreamRepository.findById(client, params.streamId)
      if (!stream) {
        logger.warn(
          { workspaceId: params.workspaceId, streamId: params.streamId, followUpId: inserted.id },
          "Follow-up scheduled against a missing stream row, skipping context landmark"
        )
      }
      if (stream && stream.e2eEnabled !== true) {
        await StreamContextRepository.insertMany(client, [
          {
            id: streamContextItemId(),
            workspaceId: params.workspaceId,
            streamId: params.streamId,
            rootStreamId: stream.rootStreamId ?? stream.id,
            category: "follow_up",
            refKind: "follow_up",
            refId: inserted.id,
            groupKey: inserted.id,
            sourceMessageId: null,
            authorId: null,
            occurredAt: inserted.createdAt,
            sequence: null,
            snippet: contextSnippet(inserted.note),
            detail: { note: inserted.note },
          },
        ])
      }

      const pendingCount = await AgentFollowUpRepository.countPending(client, params.workspaceId, params.streamId)
      return { ok: true, followUp: { ...inserted, queueMessageId }, pendingCount, limit }
    })
  }

  /**
   * Load a follow-up's context so the fired turn can be told why it woke up
   * (roadmap 1.2). Read-only single-query path, so pass the pool directly
   * (INV-30). Returns `null` when the row is gone (e.g. hard-deleted).
   */
  async getById(params: { workspaceId: string; followUpId: string }): Promise<AgentFollowUp | null> {
    return AgentFollowUpRepository.findById(this.pool, params.workspaceId, params.followUpId)
  }

  /**
   * List a stream's pending follow-ups (soonest first) so the running persona
   * can administer them via `list_follow_ups`. Read-only single query, pass the
   * pool directly (INV-30).
   */
  async listPending(params: { workspaceId: string; streamId: string }): Promise<AgentFollowUp[]> {
    return AgentFollowUpRepository.listPending(this.pool, params.workspaceId, params.streamId)
  }

  /**
   * Cancel a pending follow-up (CAS `pending → cancelled`) and tombstone its
   * fire queue row in the same tx. Returns the cancelled row, or `null` when the
   * cancel lost the race to the fire worker (already fired/cancelled). Pass
   * `streamId` (the agent-admin tools do) to also require the row belong to that
   * stream, so a turn can only cancel its own stream's follow-ups.
   */
  async cancel(params: {
    workspaceId: string
    id: string
    streamId?: string
    cancelledBy?: { actorId: string; actorType: AuthorType }
  }): Promise<AgentFollowUp | null> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = params.streamId
        ? await AgentFollowUpRepository.markCancelledInStream(client, params.workspaceId, params.streamId, params.id)
        : await AgentFollowUpRepository.markCancelled(client, params.workspaceId, params.id)
      if (!cancelled) return null
      if (cancelled.queueMessageId) {
        await QueueRepository.cancelById(client, cancelled.queueMessageId)
      }

      // Mirror the scheduled row: the cancellation is a visible broadcast row in
      // the same transaction as the CAS (roadmap 1.3, INV-4/7). Attribute to the
      // caller when known (a stream member via the card), else to the persona
      // that owns the follow-up (a `cancel_follow_up` turn).
      const actor = params.cancelledBy ?? { actorId: cancelled.personaId, actorType: AuthorTypes.PERSONA }
      await this.appendFollowUpEvent(client, {
        workspaceId: params.workspaceId,
        streamId: cancelled.streamId,
        eventType: "agent:follow_up_cancelled",
        payload: { followUpId: cancelled.id },
        actorId: actor.actorId,
        actorType: actor.actorType,
      })
      return cancelled
    })
  }

  /**
   * Append a follow-up timeline broadcast row (+ its outbox row) inside the
   * caller's transaction. Both event types ride the same envelope as the
   * memos/description capture events: the full stream event is carried on the
   * outbox payload so clients append it without a fetch.
   */
  private async appendFollowUpEvent(
    client: PoolClient,
    params: {
      workspaceId: string
      streamId: string
      eventType: keyof typeof FOLLOW_UP_OUTBOX_EVENT_TYPE
      payload: AgentFollowUpScheduledEventPayload | AgentFollowUpCancelledEventPayload
      actorId: string
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
    // Derive the outbox type from the event type so the pairing can't drift
    // (both payloads are structurally identical, so a mismatched literal
    // wouldn't be caught by the type checker).
    await OutboxRepository.insert(client, FOLLOW_UP_OUTBOX_EVENT_TYPE[params.eventType], {
      workspaceId: params.workspaceId,
      streamId: params.streamId,
      event,
    })
  }

  /**
   * Update a pending follow-up's note and/or scheduled time, stream-scoped (the
   * agent-admin `update_follow_up` path). Unspecified fields keep their current
   * value. When the time changes, the old fire job is tombstoned and a fresh one
   * enqueued at the new time in the same tx (INV-7) — mirroring the
   * scheduled-messages reschedule; `markFired`'s `scheduled_for <= NOW()` guard
   * keeps a surviving old tick from firing early. Returns `not_found` (bad id /
   * other stream) or `not_pending` (already fired/cancelled) so the tool can tell
   * the model which happened.
   */
  async update(params: {
    workspaceId: string
    streamId: string
    requestedStreamId: string
    initiatingUserId: string
    id: string
    note?: string
    scheduledFor?: Date
  }): Promise<UpdateFollowUpResult> {
    return withTransaction(this.pool, async (client) => {
      await assertStreamWritable(client, {
        workspaceId: params.workspaceId,
        streamId: params.requestedStreamId,
        principal: { kind: "user", userId: params.initiatingUserId },
      })

      // Single atomic CAS — no service-side read-then-set (INV-20). `COALESCE`
      // applies only the fields the caller changed; the returned row carries the
      // queue id as of the row lock, so the reschedule below cancels the live
      // fire job (never a pre-lock stale id that could orphan a queue row).
      const updated = await AgentFollowUpRepository.updatePending(client, {
        workspaceId: params.workspaceId,
        streamId: params.streamId,
        id: params.id,
        note: params.note ?? null,
        scheduledFor: params.scheduledFor ?? null,
      })
      if (!updated) {
        // Failure-path read only classifies the error (the row didn't mutate):
        // another stream / unknown id → not_found; else already fired/cancelled.
        const existing = await AgentFollowUpRepository.findById(client, params.workspaceId, params.id)
        if (!existing || existing.streamId !== params.streamId) return { ok: false, reason: "not_found" }
        return { ok: false, reason: "not_pending" }
      }

      // Reschedule whenever a new time was supplied: tombstone the old fire job
      // (the CAS-fresh id from `updated`) and enqueue a fresh one at the new time
      // in the same tx (INV-7). Re-enqueuing at an unchanged time is a harmless
      // no-op churn, so we don't need the pre-image to detect "changed".
      if (params.scheduledFor !== undefined) {
        if (updated.queueMessageId) {
          await QueueRepository.cancelById(client, updated.queueMessageId)
        }
        const queueMessageId = await enqueueQueuedJob(client, {
          queueName: JobQueues.AGENT_FOLLOW_UP_FIRE,
          workspaceId: params.workspaceId,
          payload: { workspaceId: params.workspaceId, followUpId: params.id },
          processAfter: updated.scheduledFor,
          generateId: agentFollowUpQueueId,
        })
        await AgentFollowUpRepository.setQueueMessageId(client, params.workspaceId, params.id, queueMessageId)
        return { ok: true, followUp: { ...updated, queueMessageId } }
      }

      return { ok: true, followUp: updated }
    })
  }

  /**
   * Worker entry. CAS `pending → fired`; on success enqueue a PERSONA_AGENT job
   * (same tx, INV-7) so the persona wakes up. Re-reads scoped to
   * (workspaceId, id) per INV-8. Returns `{ fired }` so the worker can log.
   *
   * A cancelled/already-fired row fails the CAS and this no-ops — queue delivery
   * can't be revoked, so a stale tick that lost the cancel race lands here.
   */
  async fire(params: { workspaceId: string; followUpId: string }): Promise<{ fired: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const pending = await AgentFollowUpRepository.findById(client, params.workspaceId, params.followUpId)
      if (!pending) return { fired: false }
      const sourceSession = await AgentSessionRepository.findById(client, pending.sessionId)
      const triggerMessage = sourceSession
        ? await MessageRepository.findById(client, sourceSession.triggerMessageId)
        : null
      if (!sourceSession || !triggerMessage || triggerMessage.authorType !== AuthorTypes.USER) {
        logger.warn({ ...params }, "agent follow-up fire rejected without an initiating user")
        await this.terminalizePending(client, pending)
        return { fired: false }
      }
      try {
        await assertStreamWritable(client, {
          workspaceId: pending.workspaceId,
          streamId: pending.streamId,
          principal: { kind: "user", userId: triggerMessage.authorId },
        })
      } catch (error) {
        const denial = error as { code?: string }
        if (denial.code !== "STREAM_READ_ONLY" && denial.code !== "STREAM_NOT_FOUND") throw error
        logger.warn({ ...params }, "agent follow-up fire denied by stream authority")
        await this.terminalizePending(client, pending)
        return { fired: false }
      }
      const fired = await AgentFollowUpRepository.markFired(client, params.workspaceId, params.followUpId)
      if (!fired) {
        logger.debug({ ...params }, "agent follow-up fire skipped — not pending (cancelled or already fired)")
        return { fired: false }
      }

      await this.enqueuePersonaTurn(client, fired, triggerMessage.authorId)
      logger.info(
        { workspaceId: fired.workspaceId, followUpId: fired.id, streamId: fired.streamId, personaId: fired.personaId },
        "agent follow-up fired"
      )
      return { fired: true }
    })
  }

  private async terminalizePending(client: PoolClient, pending: AgentFollowUp): Promise<void> {
    const cancelled = await AgentFollowUpRepository.markCancelled(client, pending.workspaceId, pending.id)
    if (!cancelled) return
    if (cancelled.queueMessageId) await QueueRepository.cancelById(client, cancelled.queueMessageId)
    await this.appendFollowUpEvent(client, {
      workspaceId: cancelled.workspaceId,
      streamId: cancelled.streamId,
      eventType: "agent:follow_up_cancelled",
      payload: { followUpId: cancelled.id },
      actorId: cancelled.personaId,
      actorType: AuthorTypes.PERSONA,
    })
  }

  /**
   * Enqueue the persona turn for a fired follow-up. `messageId` is synthetic —
   * there is no trigger message — so the turn runs as a companion-mode catch-up
   * until roadmap 1.2 reads `followUpId` and assembles the "why you woke up"
   * context. Enqueued in the caller's transaction for atomicity with the CAS.
   */
  private async enqueuePersonaTurn(
    client: PoolClient,
    followUp: AgentFollowUp,
    initiatingUserId: string
  ): Promise<void> {
    const payload: PersonaAgentJobData = {
      workspaceId: followUp.workspaceId,
      streamId: followUp.streamId,
      messageId: `followup_${followUp.id}`,
      personaId: followUp.personaId,
      triggeredBy: initiatingUserId,
      followUpId: followUp.id,
    }
    await enqueueQueuedJob(client, {
      queueName: JobQueues.PERSONA_AGENT,
      workspaceId: followUp.workspaceId,
      payload,
      processAfter: new Date(),
      generateId: queueId,
    })
  }
}
