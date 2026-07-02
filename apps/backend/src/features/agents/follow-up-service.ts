import type { Pool, PoolClient } from "pg"
import { withTransaction } from "../../db"
import { agentFollowUpId, agentFollowUpQueueId, queueId } from "../../lib/id"
import {
  JobQueues,
  QueueRepository,
  enqueueQueuedJob,
  type QueueManager,
  type PersonaAgentJobData,
} from "../../lib/queue"
import { logger } from "../../lib/logger"
import { DEFAULT_MAX_PENDING_FOLLOW_UPS } from "./config"
import { AgentFollowUpRepository, type AgentFollowUp } from "./follow-up-repository"

interface AgentFollowUpServiceDeps {
  pool: Pool
  jobQueue: QueueManager
}

export interface ScheduleFollowUpParams {
  workspaceId: string
  streamId: string
  personaId: string
  sessionId: string
  sourceConversationId: string | null
  note: string
  scheduledFor: Date
}

export type ScheduleFollowUpResult =
  | { ok: true; followUp: AgentFollowUp; pendingCount: number; limit: number }
  | { ok: false; reason: "cap_reached"; pendingCount: number; limit: number }

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
  private readonly jobQueue: QueueManager

  constructor(deps: AgentFollowUpServiceDeps) {
    this.pool = deps.pool
    this.jobQueue = deps.jobQueue
  }

  /**
   * The per-stream pending cap. Reads only the code default today; the seam
   * exists so roadmap 1.4's workspace override slots in here without touching
   * the cap check at the insert site.
   */
  private async resolveFollowUpLimit(_workspaceId: string): Promise<number> {
    return DEFAULT_MAX_PENDING_FOLLOW_UPS
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

      const pendingCount = await AgentFollowUpRepository.countPending(client, params.workspaceId, params.streamId)
      return { ok: true, followUp: { ...inserted, queueMessageId }, pendingCount, limit }
    })
  }

  /**
   * Cancel a pending follow-up (CAS `pending → cancelled`) and tombstone its
   * fire queue row in the same tx. Returns the cancelled row, or `null` when the
   * cancel lost the race to the fire worker (already fired/cancelled).
   */
  async cancel(params: { workspaceId: string; id: string }): Promise<AgentFollowUp | null> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await AgentFollowUpRepository.markCancelled(client, params.workspaceId, params.id)
      if (!cancelled) return null
      if (cancelled.queueMessageId) {
        await QueueRepository.cancelById(client, cancelled.queueMessageId)
      }
      return cancelled
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
      const fired = await AgentFollowUpRepository.markFired(client, params.workspaceId, params.followUpId)
      if (!fired) {
        logger.debug({ ...params }, "agent follow-up fire skipped — not pending (cancelled or already fired)")
        return { fired: false }
      }

      await this.enqueuePersonaTurn(client, fired)
      logger.info(
        { workspaceId: fired.workspaceId, followUpId: fired.id, streamId: fired.streamId, personaId: fired.personaId },
        "agent follow-up fired"
      )
      return { fired: true }
    })
  }

  /**
   * Enqueue the persona turn for a fired follow-up. `messageId` is synthetic —
   * there is no trigger message — so the turn runs as a companion-mode catch-up
   * until roadmap 1.2 reads `followUpId` and assembles the "why you woke up"
   * context. Enqueued in the caller's transaction for atomicity with the CAS.
   */
  private async enqueuePersonaTurn(client: PoolClient, followUp: AgentFollowUp): Promise<void> {
    const payload: PersonaAgentJobData = {
      workspaceId: followUp.workspaceId,
      streamId: followUp.streamId,
      messageId: `followup_${followUp.id}`,
      personaId: followUp.personaId,
      triggeredBy: "system",
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
