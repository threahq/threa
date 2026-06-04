import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { StreamRepository, StreamEventRepository } from "../streams"
import { OutboxRepository } from "../../lib/outbox"
import { withTransaction } from "../../db"
import { eventId } from "../../lib/id"
import { logger } from "../../lib/logger"

export interface OrphanSessionCleanup {
  start(): void
  stop(): void
}

const ORPHAN_ERROR = "Session orphaned (stale heartbeat)"

/**
 * Mark one RUNNING session FAILED and emit the failure lifecycle (stream event +
 * outbox + session-room socket), mirroring the in-process failure path. Returns
 * whether we won the RUNNING→FAILED transition (false if it terminated under us).
 * Shared by orphan cleanup and the enclave dispatch worker (assign-failure path),
 * which can't rely on cleanup as a backstop: cleanup only scans RUNNING sessions,
 * so a session it marks FAILED itself must emit its own lifecycle.
 */
export async function failSessionWithLifecycle(
  pool: Pool,
  io: Server,
  session: { id: string; streamId: string; personaId: string },
  error: string
): Promise<boolean> {
  const { id: sessionId, streamId, personaId } = session
  // Resolve the workspace from the stream (agent_sessions don't carry it) so we
  // can address the workspace-scoped rooms, same as the enclave complete path.
  const stream = await StreamRepository.findById(pool, streamId)

  // Mark FAILED + write the lifecycle event in one transaction (INV-7), and only
  // when we actually win the RUNNING→FAILED transition — so a session that
  // completed concurrently isn't clobbered and we don't double-emit a failure.
  const won = await withTransaction(pool, async (tx) => {
    const failed = await AgentSessionRepository.updateStatus(tx, sessionId, SessionStatuses.FAILED, {
      error,
      onlyIfStatus: SessionStatuses.RUNNING,
    })
    if (!failed) return false
    // The stream event + outbox is what unblocks the UI (clears the inline
    // indicator and keeps a refresh consistent). Without a stream we can't address
    // the rooms, but the session is still durably FAILED.
    if (stream) {
      const steps = await AgentSessionRepository.findStepsBySession(tx, sessionId)
      const streamEvent = await StreamEventRepository.insert(tx, {
        id: eventId(),
        streamId,
        eventType: "agent_session:failed",
        payload: {
          sessionId,
          stepCount: steps.length,
          error,
          traceId: sessionId,
          failedAt: new Date().toISOString(),
        },
        actorId: personaId,
        actorType: "persona",
      })
      await OutboxRepository.insert(tx, "agent_session:failed", {
        workspaceId: stream.workspaceId,
        streamId,
        event: streamEvent,
      })
    }
    return true
  })

  // Live-update an open trace dialog (session room) the way the in-process
  // `trace.notifyFailed()` does — the outbox only reaches the stream room.
  if (won && stream) {
    io.to(`ws:${stream.workspaceId}:agent_session:${sessionId}`).emit("agent_session:failed", { sessionId })
  }
  return won
}

/**
 * Periodically cleans up orphaned agent sessions.
 *
 * Sessions can become orphaned if:
 * - Server crashes during AI work
 * - completeSession() fails after work succeeded
 * - Process killed without graceful shutdown
 * - An enclave that owned an E2E turn restarts mid-session (its heartbeats stop)
 *
 * The cleanup marks these sessions as FAILED *and emits the failure lifecycle*
 * (an `agent_session:failed` stream event + outbox, plus a session-room socket
 * event) — exactly like the in-process failure path. Without that emission the
 * status flips in the DB but the UI never hears: the inline "Ariadne is working…"
 * indicator and an open trace dialog hang forever until a manual refresh.
 */
export function createOrphanSessionCleanup(
  pool: Pool,
  io: Server,
  options: {
    intervalMs?: number
    staleThresholdSeconds?: number
  } = {}
): OrphanSessionCleanup {
  const { intervalMs = 15_000, staleThresholdSeconds = 60 } = options

  let timer: ReturnType<typeof setInterval> | null = null

  const cleanup = async () => {
    try {
      const orphaned = await AgentSessionRepository.findOrphaned(pool, staleThresholdSeconds)

      if (orphaned.length === 0) return

      logger.info({ count: orphaned.length }, "Found orphaned sessions, marking as failed")

      for (const session of orphaned) {
        try {
          const won = await failSessionWithLifecycle(pool, io, session, ORPHAN_ERROR)
          if (won) {
            logger.info({ sessionId: session.id, streamId: session.streamId }, "Marked orphaned session as failed")
          }
        } catch (err) {
          logger.error({ err, sessionId: session.id }, "Failed to mark orphaned session as failed")
        }
      }
    } catch (err) {
      logger.error({ err }, "Error during orphan session cleanup")
    }
  }

  return {
    start() {
      if (timer) return
      logger.info({ intervalMs, staleThresholdSeconds }, "Starting orphan session cleanup")
      timer = setInterval(cleanup, intervalMs)
      // Run immediately on start to catch any orphans from previous crash
      cleanup()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
        logger.info("Stopped orphan session cleanup")
      }
    },
  }
}
