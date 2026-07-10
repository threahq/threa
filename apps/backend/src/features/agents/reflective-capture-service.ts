import type { Pool } from "pg"
import type { MemoServiceLike } from "../memos"
import { AgentSessionRepository, SessionStatuses } from "./session-repository"
import { buildSessionDigest } from "./session-digest"
import { logger } from "../../lib/logger"

export interface ReflectiveCaptureServiceDeps {
  pool: Pool
  memoService: MemoServiceLike
}

/**
 * Reflective capture at session completion (roadmap 6.3): after a research-heavy
 * companion session finishes, distil its tool-work digest + reply into at most a
 * couple of agent-authored memos so the research doesn't evaporate with the turn.
 *
 * Orchestration only — it owns the session gate, the digest, and the
 * once-only claim; the classify → memorize → write is `MemoService`'s
 * `captureSessionReflection` (a second caller of the GAM pipeline, INV-35). No DB
 * connection is held across that AI work (INV-41): the digest reads and the claim
 * are single pooled queries, and the memo service opens its own transaction.
 */
export class ReflectiveCaptureService {
  constructor(private readonly deps: ReflectiveCaptureServiceDeps) {}

  /**
   * Capture one completed session. Idempotent and best-effort: no-ops when the
   * row is gone, not yet completed, already captured, or carries no research
   * residue to distil. The `reflectiveCapturedAt` CAS is claimed before the
   * classifier runs, so a re-delivered job never double-classifies or stacks a
   * second differently-worded capture.
   */
  async capture(params: { workspaceId: string; sessionId: string }): Promise<{ captured: number }> {
    const { workspaceId, sessionId } = params
    const { pool, memoService } = this.deps

    const session = await AgentSessionRepository.findById(pool, sessionId)
    if (!session) {
      logger.debug({ sessionId }, "reflective capture skipped — session not found")
      return { captured: 0 }
    }
    if (session.status !== SessionStatuses.COMPLETED) {
      // Not finished — don't claim; a later completed-state delivery will handle it.
      return { captured: 0 }
    }
    if (session.reflectiveCapturedAt !== null) {
      return { captured: 0 }
    }

    const digest = await buildSessionDigest(pool, session)
    // Reflective capture is specifically for tool/research work — a session that
    // ran no tools leaves no residue the passive pipeline doesn't already capture
    // from its messages. It also needs a real in-stream message to anchor to.
    if (!digest || !digest.hasResearch || !digest.anchorMessageId) {
      // Claim anyway so a non-research session isn't re-evaluated on every redelivery.
      await AgentSessionRepository.setReflectiveCaptured(pool, sessionId, new Date())
      logger.debug({ sessionId }, "reflective capture skipped — no research residue to capture")
      return { captured: 0 }
    }

    // Claim once before the expensive AI work so concurrent/redelivered jobs
    // can't both classify+memorize and stack duplicate captures (INV-20).
    const claimed = await AgentSessionRepository.setReflectiveCaptured(pool, sessionId, new Date())
    if (!claimed) {
      logger.debug({ sessionId }, "reflective capture skipped — already claimed")
      return { captured: 0 }
    }

    try {
      const result = await memoService.captureSessionReflection({
        workspaceId,
        streamId: session.streamId,
        sessionId,
        digest: digest.text,
        anchorMessageId: digest.anchorMessageId,
        participantIds: digest.participantUserIds,
      })
      logger.info({ sessionId, workspaceId, ...result }, "reflective capture processed")
      return { captured: result.captured }
    } catch (err) {
      // The claim was taken before the fallible AI + save work; that work
      // committed nothing on failure (the memo writes are transactional), so
      // release the claim to keep the session retryable rather than marking it
      // captured-with-zero-memos forever. Unlike the episode summarizer (whose
      // CAS is its terminal write, so a mid-flight failure leaves it NULL), the
      // claim here precedes the AI calls — the release restores that same
      // retry-on-transient-failure behavior while keeping the no-duplicate
      // guarantee (only the delivery that won the atomic claim reaches here).
      await AgentSessionRepository.clearReflectiveCaptured(pool, sessionId).catch((clearErr) =>
        logger.error({ sessionId, err: clearErr }, "reflective capture — failed to release claim after error")
      )
      throw err
    }
  }
}
