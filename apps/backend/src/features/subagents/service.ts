import type { Pool, PoolClient } from "pg"
import { withTransaction, type Querier } from "../../db"
import { eventId, queueId, streamId, subagentRunId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { logger } from "../../lib/logger"
import { JobQueues, enqueueQueuedJob, type PersonaAgentJobData } from "../../lib/queue"
import {
  AuthorTypes,
  type AuthorType,
  type SubagentCreatedEventPayload,
  type SubagentStatusChangedEventPayload,
} from "@threa/types"
import { StreamEventRepository } from "../streams"
import type { CreateThreadParams } from "../streams"
import { SUBAGENT_IDLE_EXPIRY_DAYS } from "./config"
import { SubagentRunRepository, type SubagentRun } from "./repository"

/** The outbox event type that carries each subagent timeline event to the stream room. */
const SUBAGENT_OUTBOX_EVENT_TYPE = {
  "subagent:created": "stream:subagent_created",
  "subagent:status_changed": "stream:subagent_status_changed",
} as const

/**
 * The thread-creation half of `StreamService` this feature needs, narrowed so
 * the subagent create can run it inside its own transaction (INV-6/12).
 */
export interface SubagentThreadCreator {
  createThreadOn(client: Querier, params: CreateThreadParams): Promise<{ id: string }>
}

interface SubagentServiceDeps {
  pool: Pool
  streamService: SubagentThreadCreator
  /** Idle threshold override for tests; production uses the config default. */
  idleExpiryDays?: number
}

export interface CreateSubagentParams {
  workspaceId: string
  parentStreamId: string
  parentSessionId: string | null
  triggerMessageId: string | null
  sourceConversationId: string | null
  personaId: string
  model: string
  createdBy: string
  title: string
  brief: string
}

export interface CreatedSubagent {
  run: SubagentRun
  threadStreamId: string
}

/**
 * Lifecycle owner for subagent runs: one persona turn handing a question to a
 * second model, which then talks to the user directly in a thread anchored on
 * the card the hand-off posted.
 *
 * The run row is workflow state (INV-57) — the conversation itself is ordinary
 * messages in that thread. Every transition appends its timeline event in the
 * same transaction as the status CAS (INV-4/7), so the card can never sit on a
 * status the row has moved past, and `active` is the only non-terminal state:
 * a losing racer CASes nothing and reports it (INV-20).
 */
export class SubagentService {
  private readonly pool: Pool
  private readonly streamService: SubagentThreadCreator
  private readonly idleExpiryDays: number

  constructor(deps: SubagentServiceDeps) {
    this.pool = deps.pool
    this.streamService = deps.streamService
    this.idleExpiryDays = deps.idleExpiryDays ?? SUBAGENT_IDLE_EXPIRY_DAYS
  }

  /**
   * Open a subagent run: the card, the thread it anchors, the row, and the
   * kickoff turn, all in one transaction. The card event exists before the
   * thread because the thread anchors on it; the row exists after both because
   * it stores their ids — and the `active` unique index decides the race there,
   * so a loser rolls the whole thing back rather than leaving a stray thread.
   * Throws `SubagentAlreadyActiveError` when this stream already has a live one.
   */
  async create(params: CreateSubagentParams): Promise<CreatedSubagent> {
    return withTransaction(this.pool, async (client) => {
      const id = subagentRunId()
      const cardEventId = eventId()
      const threadStreamId = streamId()

      const payload: SubagentCreatedEventPayload = {
        subagentId: id,
        title: params.title,
        model: params.model,
        personaId: params.personaId,
        threadStreamId,
        createdBy: params.createdBy,
        sourceConversationId: params.sourceConversationId,
      }
      const cardEvent = await StreamEventRepository.insert(client, {
        id: cardEventId,
        streamId: params.parentStreamId,
        eventType: "subagent:created",
        payload,
        actorId: params.personaId,
        actorType: AuthorTypes.PERSONA,
      })

      const thread = await this.streamService.createThreadOn(client, {
        id: threadStreamId,
        workspaceId: params.workspaceId,
        parentStreamId: params.parentStreamId,
        parentAnchorId: cardEventId,
        createdBy: params.createdBy,
      })
      if (thread.id !== threadStreamId) {
        // The anchor is a card minted three statements ago, so `insertThreadOrFind`
        // can only have created; a found row would mean the payload above names a
        // thread nobody will ever open.
        throw new Error(`Subagent thread id mismatch: expected ${threadStreamId}, got ${thread.id}`)
      }

      const run = await SubagentRunRepository.insert(client, {
        id,
        workspaceId: params.workspaceId,
        parentStreamId: params.parentStreamId,
        parentSessionId: params.parentSessionId,
        triggerMessageId: params.triggerMessageId,
        cardEventId,
        threadStreamId,
        personaId: params.personaId,
        model: params.model,
        createdBy: params.createdBy,
        title: params.title,
        brief: params.brief,
      })

      await OutboxRepository.insert(client, SUBAGENT_OUTBOX_EVENT_TYPE["subagent:created"], {
        workspaceId: params.workspaceId,
        streamId: params.parentStreamId,
        event: cardEvent,
      })

      await this.enqueueKickoff(client, run)

      return { run, threadStreamId }
    })
  }

  async getById(params: { workspaceId: string; id: string }): Promise<SubagentRun | null> {
    return SubagentRunRepository.findById(this.pool, params.workspaceId, params.id)
  }

  async findActiveByParentStream(params: { workspaceId: string; parentStreamId: string }): Promise<SubagentRun | null> {
    return SubagentRunRepository.findActiveByParentStreamId(this.pool, params.workspaceId, params.parentStreamId)
  }

  async findActiveByThreadStream(params: { workspaceId: string; threadStreamId: string }): Promise<SubagentRun | null> {
    return SubagentRunRepository.findActiveByThreadStreamId(this.pool, params.workspaceId, params.threadStreamId)
  }

  /**
   * The subagent closing itself out via `report_back`. The summary message was
   * already posted through the turn's normal message path, so this only settles
   * the run — a replayed call CASes nothing and returns `null`, which the tool
   * reports as "already closed" rather than posting a second closure.
   */
  async reportBack(params: {
    workspaceId: string
    id: string
    resultMessageId: string
    lastAgentMessageAt?: Date
  }): Promise<SubagentRun | null> {
    return withTransaction(this.pool, async (client) => {
      const completed = await SubagentRunRepository.complete(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        resultMessageId: params.resultMessageId,
      })
      if (!completed) return null
      await this.appendStatusEvent(client, completed, {
        actorId: completed.personaId,
        actorType: AuthorTypes.PERSONA,
        lastAgentMessageAt: params.lastAgentMessageAt ?? new Date(),
      })
      return completed
    })
  }

  /** A person stopping the run from the card. `null` = it already settled. */
  async cancel(params: {
    workspaceId: string
    id: string
    parentStreamId?: string
    cancelledBy: { actorId: string; actorType: AuthorType }
  }): Promise<SubagentRun | null> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await SubagentRunRepository.cancel(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        parentStreamId: params.parentStreamId,
      })
      if (!cancelled) return null
      await this.appendStatusEvent(client, cancelled, params.cancelledBy)
      return cancelled
    })
  }

  /**
   * The run's runtime died. Called from the session terminal-failure sites with
   * the thread it died in — a card that keeps saying "waiting for you" for a
   * subagent that can no longer answer is the dishonesty this exists to stop.
   */
  async failByThreadStream(params: {
    workspaceId: string
    threadStreamId: string
    statusNote: string
  }): Promise<SubagentRun | null> {
    return withTransaction(this.pool, async (client) => {
      const failed = await SubagentRunRepository.failByThreadStreamId(client, params)
      if (!failed) return null
      await this.appendStatusEvent(client, failed, { actorType: AuthorTypes.SYSTEM })
      return failed
    })
  }

  /**
   * Same transition inside a caller-owned transaction, for the session-failure
   * path that must flip the run atomically with the session row (INV-7).
   */
  async failByThreadStreamInTransaction(
    client: Querier,
    params: { workspaceId: string; threadStreamId: string; statusNote: string }
  ): Promise<SubagentRun | null> {
    const failed = await SubagentRunRepository.failByThreadStreamId(client, params)
    if (!failed) return null
    await this.appendStatusEvent(client, failed, { actorType: AuthorTypes.SYSTEM })
    return failed
  }

  /**
   * "Try again" on a settled card: reactivate the row and re-run the kickoff
   * turn. Races the `active` unique index like `create` — if another subagent
   * took the stream's slot meanwhile the reactivation throws
   * `SubagentAlreadyActiveError` and nothing is enqueued.
   */
  async requeue(params: {
    workspaceId: string
    id: string
    parentStreamId?: string
    requeuedBy: { actorId: string; actorType: AuthorType }
  }): Promise<SubagentRun | null> {
    return withTransaction(this.pool, async (client) => {
      const reactivated = await SubagentRunRepository.requeue(client, {
        workspaceId: params.workspaceId,
        id: params.id,
        parentStreamId: params.parentStreamId,
      })
      if (!reactivated) return null
      await this.appendStatusEvent(client, reactivated, params.requeuedBy)
      await this.enqueueKickoff(client, reactivated)
      return reactivated
    })
  }

  /**
   * Expiry-sweep entry: CAS every idle live run to `expired` (set-based,
   * INV-56) and append each card's status patch in the same transaction.
   */
  async expireIdleRuns(): Promise<SubagentRun[]> {
    return withTransaction(this.pool, async (client) => {
      const expired = await SubagentRunRepository.expireIdle(client, { idleDays: this.idleExpiryDays })
      for (const run of expired) {
        await this.appendStatusEvent(client, run, { actorType: AuthorTypes.SYSTEM })
      }
      if (expired.length > 0) {
        logger.info(
          { count: expired.length, subagentIds: expired.map((run) => run.id) },
          "subagent runs expired by sweep"
        )
      }
      return expired
    })
  }

  /**
   * The kickoff persona turn, enqueued in the caller's transaction so it can
   * never fire for a run that rolled back. `messageId` is synthetic — there is
   * no trigger message — and `subagentRunId` is what makes the worker resolve
   * a `subagent_kickoff` purpose (the fired-follow-up shape).
   */
  private async enqueueKickoff(client: PoolClient, run: SubagentRun): Promise<void> {
    const payload: PersonaAgentJobData = {
      workspaceId: run.workspaceId,
      streamId: run.threadStreamId,
      messageId: `subagent_${run.id}`,
      personaId: run.personaId,
      triggeredBy: run.createdBy,
      subagentRunId: run.id,
    }
    await enqueueQueuedJob(client, {
      queueName: JobQueues.PERSONA_AGENT,
      workspaceId: run.workspaceId,
      payload,
      processAfter: new Date(),
      generateId: queueId,
    })
  }

  /**
   * Append the patch that advances the card to the row's current status, inside
   * the caller's transaction (INV-4/7). One payload type carries every
   * transition; the optional fields reflect whatever the row now holds.
   */
  private async appendStatusEvent(
    client: Querier,
    run: SubagentRun,
    actor: { actorId?: string; actorType: AuthorType; lastAgentMessageAt?: Date }
  ): Promise<void> {
    const payload: SubagentStatusChangedEventPayload = {
      subagentId: run.id,
      status: run.status,
      statusNote: run.statusNote,
      resultMessageId: run.resultMessageId,
      lastAgentMessageAt: actor.lastAgentMessageAt?.toISOString() ?? null,
    }
    const event = await StreamEventRepository.insert(client, {
      id: eventId(),
      streamId: run.parentStreamId,
      eventType: "subagent:status_changed",
      payload,
      actorId: actor.actorId,
      actorType: actor.actorType,
    })
    await OutboxRepository.insert(client, SUBAGENT_OUTBOX_EVENT_TYPE["subagent:status_changed"], {
      workspaceId: run.workspaceId,
      streamId: run.parentStreamId,
      event,
    })
  }
}
