import { APICallError } from "ai"
import type { Pool } from "pg"
import type { AgentSessionRerunContext } from "@threahq/types"
import { withTransaction, type Querier } from "../../../db"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "../session-repository"
import { collectSessionEffects } from "../session-effects"
import { OutboxRepository } from "../../../lib/outbox"
import { StreamEventRepository } from "../../streams"
import { eventId, sessionId } from "../../../lib/id"
import { logger } from "../../../lib/logger"

export type WithSessionResult =
  | { status: "skipped"; sessionId: string | null; reason: string }
  | { status: "completed"; sessionId: string; messagesSent: number; sentMessageIds: string[]; lastSeenSequence: bigint }
  | { status: "failed"; sessionId: string; willRetry: boolean; retryable: boolean }

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
    const existingSession = await AgentSessionRepository.findByTriggerMessage(db, triggerMessageId)

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
        const session = await AgentSessionRepository.updateStatus(db, existingSession.id, SessionStatuses.RUNNING, {
          serverId,
          onlyIfStatusIn: [SessionStatuses.RUNNING, SessionStatuses.PENDING, SessionStatuses.FAILED],
        })
        if (!session) {
          return { status: "skipped" as const, sessionId: null, reason: "failed to resume session" }
        }
        return { status: "ready" as const, session }
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
    })

    if (!session) {
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

  if (setupResult.status === "skipped") {
    return setupResult
  }

  const { session } = setupResult

  // Phase 2: Run work WITHOUT holding connection
  let heartbeatInterval: ReturnType<typeof setInterval> | undefined

  try {
    heartbeatInterval = setInterval(async () => {
      try {
        await AgentSessionRepository.updateHeartbeat(pool, session.id)
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

      return {
        status: "skipped" as const,
        sessionId: session.id,
        reason: "session terminated before completion",
      }
    }

    logger.info({ sessionId: session.id, messagesSent, sentMessageIds }, "Session completed")

    return {
      status: "completed" as const,
      sessionId: session.id,
      messagesSent,
      sentMessageIds,
      lastSeenSequence,
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

    await withTransaction(pool, async (db) => {
      const failed = await AgentSessionRepository.updateStatus(db, session.id, SessionStatuses.FAILED, {
        error: String(err),
      })
      if (failed) {
        const steps = await AgentSessionRepository.findStepsBySession(db, session.id)

        if (willRetry) {
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
          const streamEvent = await StreamEventRepository.insert(db, {
            id: eventId(),
            streamId,
            eventType: "agent_session:failed",
            payload: {
              sessionId: session.id,
              stepCount: steps.length,
              error: String(err),
              traceId: session.id,
              effects: collectSessionEffects(steps),
              failedAt: new Date().toISOString(),
            },
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
      }
    }).catch((e) => logger.error({ err: e }, "Failed to mark session as failed"))

    return { status: "failed" as const, sessionId: session.id, willRetry, retryable }
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval)
  }
}
