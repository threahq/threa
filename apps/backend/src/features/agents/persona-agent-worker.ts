import type { Pool } from "pg"
import type { PersonaAgentJobData, JobHandler } from "../../lib/queue"
import { JobQueues } from "../../lib/queue"
import { AgentTriggers } from "@threa/types"
import type { QueueManager } from "../../lib/queue"
import type { PersonaAgentInput, PersonaAgentResult } from "./persona-agent"
import { resolveTurnPurpose } from "./turn-purpose"
import { StreamEventRepository } from "../streams"
import { logger } from "../../lib/logger"

export interface PersonaAgentLike {
  run(input: PersonaAgentInput): Promise<PersonaAgentResult>
}

export interface PersonaAgentWorkerDeps {
  agent: PersonaAgentLike
  serverId: string
  /** Pool for checking unseen messages after job completion */
  pool: Pool
  /** Job queue for dispatching follow-up jobs */
  jobQueue: QueueManager
}

/**
 * Create the persona agent job handler for queue system.
 *
 * This is a thin wrapper that extracts job data and delegates to the persona agent.
 * All business logic lives in the agent module for reusability and testability.
 *
 * IMPORTANT: After job completion, checks for unseen messages and dispatches
 * a follow-up job if needed. This handles the race condition where messages
 * arrive while a session is running and the listener skips dispatching jobs
 * for them (since a session is already active).
 */
export function createPersonaAgentWorker(deps: PersonaAgentWorkerDeps): JobHandler<PersonaAgentJobData> {
  const { agent, serverId, pool, jobQueue } = deps

  return async (job) => {
    const { workspaceId, streamId, messageId, personaId, trigger, followUpId } = job.data

    logger.info({ jobId: job.id, streamId, messageId, personaId, trigger, followUpId }, "Processing persona agent job")

    // Map the in-flight wire payload to the turn's purpose at the boundary — the
    // job fields stay as-is so already-enqueued rows still decode (roadmap 1.5).
    const result = await agent.run({
      workspaceId,
      streamId,
      messageId,
      personaId,
      serverId,
      purpose: resolveTurnPurpose(job.data),
      // Retry accounting so a failed-but-retryable turn emits a non-terminal
      // "Interrupted, retrying…" event instead of a terminal `failed` that would
      // flash red on the card before the retry completes.
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
    })

    if (result.status === "failed") {
      // Re-throw to trigger queue system retry
      throw new Error(`Persona agent failed for session ${result.sessionId}`)
    }

    logger.info({ jobId: job.id, ...result }, "Persona agent job completed")

    // Summarize the finished session into an episode summary for later turns
    // (roadmap 3.1). Deferred to its own job so no summarizer AI call runs inline
    // here (INV-41). Only sessions that actually replied are worth remembering —
    // a silent no-op turn has nothing to condense. Best-effort: a lost enqueue
    // just means one session is absent from "Previous sessions" context.
    if (result.status === "completed" && result.sessionId && result.messagesSent > 0) {
      await jobQueue.send(JobQueues.AGENT_EPISODE_SUMMARIZE, { workspaceId, sessionId: result.sessionId })
    }

    // Check for unseen messages that arrived while the session was running.
    // The companion listener skips dispatching jobs for messages when a session
    // is already active (RUNNING/PENDING), so we need to catch up here.
    // Skip for mentions — they work in threads with a different sequence space
    // than the channel, and new mentions get their own jobs via mention-invoke.
    if (result.status === "completed" && result.lastSeenSequence !== undefined && trigger !== AgentTriggers.MENTION) {
      await checkForUnseenMessages({
        pool,
        jobQueue,
        workspaceId,
        streamId: result.streamId ?? streamId,
        personaId: result.personaId ?? personaId,
        lastSeenSequence: result.lastSeenSequence,
        trigger,
        previousJobId: job.id,
      })
    }
  }
}

/**
 * Check if there are USER messages that arrived after lastSeenSequence and dispatch
 * a follow-up PERSONA_AGENT job if needed.
 *
 * IMPORTANT: We only check for USER messages, not all messages. Otherwise the
 * agent's own responses would trigger follow-up jobs in an infinite loop.
 *
 * Exported because any worker that holds the `(stream_id) WHERE status='running'`
 * session slot during its AI call must call this on completion — `CompanionHandler`
 * suppresses duplicate dispatches while a session is active, so without a follow-up
 * nudge any user message that lands during the AI call gets stranded.
 */
export async function checkForUnseenMessages(params: {
  pool: Pool
  jobQueue: QueueManager
  workspaceId: string
  streamId: string
  personaId: string
  lastSeenSequence: bigint
  trigger?: typeof AgentTriggers.MENTION
  previousJobId: string
}): Promise<void> {
  const { pool, jobQueue, workspaceId, streamId, personaId, lastSeenSequence, trigger, previousJobId } = params

  // Only check for USER messages - ignore persona responses to avoid infinite loops (single query, INV-30)
  const latestUserMessageSequence = await StreamEventRepository.getLatestUserMessageSequence(pool, streamId)

  if (!latestUserMessageSequence || latestUserMessageSequence <= lastSeenSequence) {
    return
  }

  logger.info(
    {
      streamId,
      lastSeenSequence: lastSeenSequence.toString(),
      latestUserMessageSequence: latestUserMessageSequence.toString(),
      previousJobId,
    },
    "Found unseen user messages after session completion, dispatching follow-up job"
  )

  // Synthetic messageId: this catches up on multiple messages, not one.
  await jobQueue.send(JobQueues.PERSONA_AGENT, {
    workspaceId,
    streamId,
    messageId: `followup_${previousJobId}`,
    personaId,
    triggeredBy: "system",
    trigger,
  })
}
