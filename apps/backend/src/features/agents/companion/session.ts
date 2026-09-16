import { APICallError } from "ai"
import type { Pool } from "pg"
import {
  SpendingDeniedError,
  SpendingDuplicateRequestError,
  SpendingOutcomeUnknownError,
  SpendingResultUnavailableError,
} from "@threahq/agent-runtime"
import {
  AI_SPENDING_STAGES,
  AgentSessionStopReasons,
  type AISpendingDenialCode,
  type AgentSessionFailedPayload,
  type AgentSessionRerunContext,
  type AgentSessionSpendingStop,
} from "@threahq/types"
import { withTransaction, type Querier } from "../../../db"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "../session-repository"
import { collectSessionEffects } from "../session-effects"
import { OutboxRepository } from "../../../lib/outbox"
import { StreamEventRepository } from "../../streams"
import { eventId, sessionId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import { ORPHAN_SESSION_STALE_SECONDS } from "../orphan-session-cleanup"

/**
 * `sessionId` on a skip is set only when the session is deleted or superseded:
 * terminal rows no generation can claim again, so ending their live activity
 * cannot end a newer execution's. A skip this execution lost to a replacement
 * or to orphan cleanup carries no session: whoever committed that transition
 * owns its notifications.
 */
export type WithSessionResult =
  | { status: "skipped"; sessionId: string | null; reason: string }
  | {
      status: "completed"
      sessionId: string
      messagesSent: number
      sentMessageIds: string[]
      lastSeenSequence: bigint
      /** The generation whose completion this execution committed. */
      committedGeneration: number
    }
  | {
      status: "failed"
      sessionId: string
      willRetry: boolean
      retryable: boolean
      /** The generation whose failure this execution committed; null when orphan cleanup failed it first and already notified. */
      committedGeneration: number | null
    }
  /** Another live execution holds the session; nothing ran and nothing was written. */
  | { status: "busy"; sessionId: string; heartbeatAt: Date }

/**
 * A spending outcome that ends the session for good. Every one of these is
 * unsafe to replay: a denial was already decided under this operation, an
 * unknown outcome keeps its commitment, and a duplicate means this step's
 * attempt already exists. The execution still holding the session gets a
 * persisted stop; a fenced one loses the generation check and stays silent.
 *
 * The stop is broadcast to the stream, so it is built field by field and never
 * copies the error's details: those hold amounts, attempt ids and receipts.
 */
export function spendingStopOf(err: unknown): AgentSessionSpendingStop | null {
  if (err instanceof SpendingDeniedError) {
    const code: AISpendingDenialCode = err.code
    const stage = AI_SPENDING_STAGES.find((known) => known === err.details.stage)
    return { reason: AgentSessionStopReasons.SPENDING_DENIED, code, ...(stage ? { stage } : {}) }
  }
  if (err instanceof SpendingOutcomeUnknownError) return { reason: AgentSessionStopReasons.SPENDING_OUTCOME_UNKNOWN }
  if (err instanceof SpendingDuplicateRequestError) return { reason: AgentSessionStopReasons.SPENDING_REPLAY_BLOCKED }
  if (err instanceof SpendingResultUnavailableError)
    return { reason: AgentSessionStopReasons.SPENDING_RESULT_UNAVAILABLE }
  return null
}

/**
 * Manages the complete lifecycle of an agent session.
 *
 * Connection lifecycle (INV-41):
 * 1. Phase 1: Acquire connection -> atomically create/find session -> release
 * 2. Phase 2: Run work (AI call) WITHOUT holding connection
 * 3. Phase 3: Acquire connection -> atomically complete session -> release
 *
 * Race condition prevention:
 * - Uses a partial unique index (stream_id WHERE status='running') to ensure
 *   only one running session per stream
 * - INSERT with ON CONFLICT DO NOTHING atomically checks and creates
 */
export async function withCompanionSession(
  params: {
    pool: Pool
    triggerMessageId: string
    streamId: string
    rootStreamId?: string
    personaId: string
    personaName: string
    workspaceId: string
    /** The turn's sponsor. Written on a new session; an existing session sponsored by someone else is never resumed. */
    initiatingUserId: string
    serverId: string
    initialSequence: bigint
    triggerMessageRevision?: number | null
    supersedesSessionId?: string | null
    rerunContext?: AgentSessionRerunContext
    /**
     * Queue retry accounting. When a turn throws and `attempt + 1 < maxAttempts`,
     * the queue will retry the SAME session, so we emit a non-terminal
     * `agent_session:interrupted` ("Interrupted, retrying…") instead of the
     * terminal `agent_session:failed` — the card must not flash red before the
     * retry lands. Absent (evals/tests/non-queue callers) → a failure is terminal.
     */
    attempt?: number
    maxAttempts?: number
    /**
     * Runs in the same transaction as a TERMINAL failure (INV-7) — never on a
     * retryable attempt, which stays non-terminal. Wired to the subagent run
     * CAS: a subagent whose turn died for good must not leave a card claiming it
     * is still waiting on the user.
     */
    onTerminalFailure?: (db: Querier, error: string) => Promise<void>
    /**
     * Runs in the same transaction as a completion that actually posted
     * something (INV-7). Wired to the subagent card's "the delegated model
     * spoke last" stamp, which is what separates "waiting for you" from
     * "working" — derived from a patch that lands with the message, never from
     * a later poll.
     */
    onCompletedWithMessages?: (db: Querier, at: Date) => Promise<void>
  },
  work: (
    session: AgentSession,
    pool: Pool
  ) => Promise<{ messagesSent: number; sentMessageIds: string[]; lastSeenSequence: bigint }>
): Promise<WithSessionResult> {
  const {
    pool,
    triggerMessageId,
    streamId,
    rootStreamId = streamId,
    personaId,
    personaName,
    workspaceId,
    initiatingUserId,
    serverId,
    initialSequence,
    triggerMessageRevision,
    supersedesSessionId,
    rerunContext,
    attempt,
    maxAttempts,
    onTerminalFailure,
    onCompletedWithMessages,
  } = params

  // Phase 1: Session setup (short-lived transaction)
  const setupResult = await withTransaction(pool, async (db) => {
    const existingSession = await AgentSessionRepository.lockCompanionTurn(db, {
      streamId,
      triggerMessageId,
      personaId,
    })

    if (existingSession) {
      if (existingSession.status === SessionStatuses.COMPLETED) {
        logger.info({ sessionId: existingSession.id }, "Session already completed")
        return { status: "skipped" as const, sessionId: null, reason: "session already completed" }
      }

      if (
        existingSession.status === SessionStatuses.RUNNING ||
        existingSession.status === SessionStatuses.PENDING ||
        existingSession.status === SessionStatuses.FAILED
      ) {
        const refusal = resumeRefusal(existingSession, initiatingUserId)
        if (refusal) {
          logger.warn({ sessionId: existingSession.id, reason: refusal }, "Session resume refused")
          return { status: "skipped" as const, sessionId: null, reason: refusal }
        }
        const session = await AgentSessionRepository.claimExecution(db, existingSession.id, {
          serverId,
          staleThresholdSeconds: ORPHAN_SESSION_STALE_SECONDS,
        })
        if (session) return { status: "ready" as const, session }
        if (existingSession.status === SessionStatuses.RUNNING) {
          return {
            status: "busy" as const,
            sessionId: existingSession.id,
            heartbeatAt: existingSession.heartbeatAt ?? new Date(),
          }
        }
        return { status: "skipped" as const, sessionId: null, reason: "failed to resume session" }
      }
    }

    const session = await AgentSessionRepository.insertRunningOrSkip(db, {
      id: sessionId(),
      streamId,
      personaId,
      triggerMessageId,
      serverId,
      initialSequence,
      triggerMessageRevision,
      supersedesSessionId,
      initiatingUserId,
    })

    if (!session) {
      // Another persona answering this same trigger holds the stream. Defer
      // like any busy session so this turn runs its own session once that one
      // ends: a plain skip would acknowledge the only delivery of this turn. A
      // session for a different trigger already consumes this message, so that
      // conflict is skipped rather than requeued.
      const owners = await AgentSessionRepository.listByTriggerMessage(db, triggerMessageId)
      const owner = owners.find((s) => s.streamId === streamId && s.status === SessionStatuses.RUNNING)
      if (owner) {
        return { status: "busy" as const, sessionId: owner.id, heartbeatAt: owner.heartbeatAt ?? new Date() }
      }
      logger.info({ streamId }, "Agent already running for stream (concurrent insert), skipping")
      return { status: "skipped" as const, sessionId: null, reason: "agent already running for stream" }
    }

    const streamEvent = await StreamEventRepository.insert(db, {
      id: eventId(),
      streamId,
      eventType: "agent_session:started",
      payload: {
        sessionId: session.id,
        personaId,
        personaName,
        triggerMessageId,
        rerunContext: rerunContext ?? null,
        startedAt: session.createdAt.toISOString(),
      },
      actorId: personaId,
      actorType: "persona",
    })
    await OutboxRepository.insert(db, "agent_session:started", {
      workspaceId,
      streamId,
      rootStreamId,
      event: streamEvent,
    })

    return { status: "ready" as const, session }
  })

  if (setupResult.status !== "ready") {
    return setupResult
  }

  const { session } = setupResult
  const generation = session.executionGeneration

  // Phase 2: Run work WITHOUT holding connection
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined

  try {
    heartbeatInterval = setInterval(async () => {
      try {
        await AgentSessionRepository.updateHeartbeat(pool, session.id, generation)
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "Heartbeat update failed")
      }
    }, 15_000)

    const { messagesSent, sentMessageIds, lastSeenSequence } = await work(session, pool)

    // Phase 3: Complete session + emit completed event atomically
    let completionCommitted = false
    try {
      await withTransaction(pool, async (db) => {
        const completed = await AgentSessionRepository.completeSession(db, session.id, {
          lastSeenSequence,
          responseMessageId: sentMessageIds[0] ?? null,
          sentMessageIds,
          expectedGeneration: generation,
        })

        if (!completed) {
          logger.info({ sessionId: session.id }, "Session already terminated before completion")
          return
        }

        const steps = await AgentSessionRepository.findStepsBySession(db, session.id)
        const completedAt = completed.completedAt ?? new Date()
        const duration = completedAt.getTime() - session.createdAt.getTime()

        const streamEvent = await StreamEventRepository.insert(db, {
          id: eventId(),
          streamId,
          eventType: "agent_session:completed",
          payload: {
            sessionId: session.id,
            stepCount: steps.length,
            messageCount: messagesSent,
            duration,
            effects: collectSessionEffects(steps),
            completedAt: completedAt.toISOString(),
          },
          actorId: personaId,
          actorType: "persona",
        })
        await OutboxRepository.insert(db, "agent_session:completed", {
          workspaceId,
          streamId,
          rootStreamId,
          event: streamEvent,
        })
        if (messagesSent > 0 && onCompletedWithMessages) await onCompletedWithMessages(db, completedAt)
        completionCommitted = true
      })
    } catch (err) {
      logger.error({ err, sessionId: session.id }, "Failed to complete session, orphan cleanup will recover")
      throw err
    }

    if (!completionCommitted) {
      const latestSession = await AgentSessionRepository.findById(pool, session.id)
      if (latestSession?.status === SessionStatuses.DELETED || latestSession?.status === SessionStatuses.SUPERSEDED) {
        return {
          status: "skipped" as const,
          sessionId: latestSession.id,
          reason: `session ${latestSession.status} before completion`,
        }
      }
      if (latestSession && latestSession.executionGeneration !== generation) {
        return { status: "skipped" as const, sessionId: null, reason: EXECUTION_SUPERSEDED }
      }

      return { status: "skipped" as const, sessionId: null, reason: "session terminated before completion" }
    }

    logger.info({ sessionId: session.id, messagesSent, sentMessageIds }, "Session completed")

    return {
      status: "completed" as const,
      sessionId: session.id,
      messagesSent,
      sentMessageIds,
      lastSeenSequence,
      committedGeneration: generation,
    }
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "Session failed")

    const latestSession = await AgentSessionRepository.findById(pool, session.id)
    if (latestSession?.status === SessionStatuses.DELETED || latestSession?.status === SessionStatuses.SUPERSEDED) {
      return {
        status: "skipped" as const,
        sessionId: latestSession.id,
        reason: `session ${latestSession.status}`,
      }
    }

    const insertFailedEvent = async (
      db: Querier,
      publicError: string,
      extra: Pick<AgentSessionFailedPayload, "spendingStop">
    ) => {
      const steps = await AgentSessionRepository.findStepsBySession(db, session.id)
      const payload: AgentSessionFailedPayload = {
        sessionId: session.id,
        stepCount: steps.length,
        error: publicError,
        traceId: session.id,
        effects: collectSessionEffects(steps),
        failedAt: new Date().toISOString(),
        ...extra,
      }
      const streamEvent = await StreamEventRepository.insert(db, {
        id: eventId(),
        streamId,
        eventType: "agent_session:failed",
        payload,
        actorId: personaId,
        actorType: "persona",
      })
      await OutboxRepository.insert(db, "agent_session:failed", {
        workspaceId,
        streamId,
        rootStreamId,
        event: streamEvent,
      })
    }

    const spendingStop = spendingStopOf(err)
    if (spendingStop) {
      // Not caught: if the stop cannot be persisted the delivery must fail and
      // come back, where the ledger's request key keeps the step from being
      // bought twice. Acknowledging an unpersisted stop would lose it.
      const stopped = await withTransaction(pool, async (db) => {
        const failure = await failThisExecution(db, session.id, {
          generation,
          error: String(err),
          stopReason: spendingStop.reason,
        })
        if (!failure) return null
        if (failure.alreadyFailed) return { committedGeneration: null }
        if (onTerminalFailure) await onTerminalFailure(db, String(err))
        await insertFailedEvent(db, spendingStop.reason, { spendingStop })
        return { committedGeneration: generation }
      })
      if (!stopped) return lostExecution(pool, session.id, generation)
      logger.warn({ err, sessionId: session.id, spendingStop }, "Session stopped for a spending reason")
      return {
        status: "failed" as const,
        sessionId: session.id,
        willRetry: false,
        retryable: false,
        committedGeneration: stopped.committedGeneration,
      }
    }

    // The queue will retry the same session while attempts remain, so a failure
    // here is only *terminal* on the last attempt. On a retryable attempt we still
    // mark the row FAILED (orphan cleanup scans RUNNING only, and the retry resumes
    // FAILED→RUNNING) but emit a non-terminal `agent_session:interrupted` so the
    // card shows "Interrupted, retrying…" instead of flashing red. When retry
    // accounting is absent (non-queue callers), treat the failure as terminal.
    // `retryable: false` is the provider's own verdict (an AI SDK APICallError that
    // says don't retry) — repeating a deterministic rejection only burns tokens. It
    // is not the same as `willRetry: false`, which also covers the last attempt of
    // an ordinary failure.
    const errorCode =
      typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : null
    const authorityDenial = errorCode === "STREAM_READ_ONLY" || errorCode === "STREAM_NOT_FOUND"
    const retryable = !authorityDenial && !(APICallError.isInstance(err) && err.isRetryable === false)
    const willRetry = retryable && attempt !== undefined && maxAttempts !== undefined && attempt + 1 < maxAttempts

    // Not caught: an unpersisted failure must fail the delivery, never report a terminal outcome nobody wrote.
    const won = await withTransaction(pool, async (db) => {
      const failure = await failThisExecution(db, session.id, { generation, error: String(err) })
      if (!failure) return null
      if (failure.alreadyFailed) return { committedGeneration: null }
      if (willRetry) {
        const steps = await AgentSessionRepository.findStepsBySession(db, session.id)
        const streamEvent = await StreamEventRepository.insert(db, {
          id: eventId(),
          streamId,
          eventType: "agent_session:interrupted",
          payload: {
            sessionId: session.id,
            stepCount: steps.length,
            attempt: attempt!,
            maxAttempts: maxAttempts!,
            error: String(err),
            effects: collectSessionEffects(steps),
            interruptedAt: new Date().toISOString(),
          },
          actorId: personaId,
          actorType: "persona",
        })
        await OutboxRepository.insert(db, "agent_session:interrupted", {
          workspaceId,
          streamId,
          rootStreamId,
          event: streamEvent,
        })
      } else {
        if (onTerminalFailure) await onTerminalFailure(db, String(err))
        await insertFailedEvent(db, String(err), {})
      }
      return { committedGeneration: generation }
    })
    if (!won) return lostExecution(pool, session.id, generation)

    return {
      status: "failed" as const,
      sessionId: session.id,
      willRetry,
      retryable,
      committedGeneration: won.committedGeneration,
    }
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval)
  }
}

const EXECUTION_SUPERSEDED = "execution superseded"

function resumeRefusal(existing: AgentSession, initiatingUserId: string): string | null {
  if (existing.stopReason) return `stopped:${existing.stopReason}`
  if (existing.initiatingUserId !== null && existing.initiatingUserId !== initiatingUserId) {
    return "sponsor_mismatch"
  }
  return null
}

/**
 * Fail the execution holding `generation`. `alreadyFailed` means orphan cleanup
 * failed this same generation first and already emitted the terminal event and
 * settled its hooks, so the caller persists its own outcome without a second one.
 */
async function failThisExecution(
  db: Querier,
  id: string,
  params: Parameters<typeof AgentSessionRepository.failExecution>[2]
): Promise<{ alreadyFailed: boolean } | null> {
  const prior = await AgentSessionRepository.findByIdForUpdate(db, id)
  const failed = await AgentSessionRepository.failExecution(db, id, params)
  if (!failed) return null
  return { alreadyFailed: prior?.status === SessionStatuses.FAILED }
}

/** This execution lost its lifecycle write: another generation or a terminal state owns the row now. */
async function lostExecution(pool: Pool, id: string, generation: number): Promise<WithSessionResult> {
  const latest = await AgentSessionRepository.findById(pool, id)
  if (!latest || latest.executionGeneration !== generation) {
    return { status: "skipped", sessionId: null, reason: EXECUTION_SUPERSEDED }
  }
  const terminal = latest.status === SessionStatuses.DELETED || latest.status === SessionStatuses.SUPERSEDED
  return { status: "skipped", sessionId: terminal ? latest.id : null, reason: `session ${latest.status}` }
}
