import type { Pool } from "pg"
import { sessionId as newSessionId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import type { EnclaveInvokeJobData, JobHandler } from "../../../lib/queue/job-queue"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../e2e-streams"
import { MessageRepository } from "../../messaging"
import {
  AgentSessionRepository,
  SessionStatuses,
  ARIADNE_AGENT_ID,
  getBuiltInAgentConfig,
  isE2eCapablePersona,
} from "../../agents"
import { EnclaveRuntimesRepository } from "../repository"
import { ENCLAVE_RUNTIME_STALENESS_MS } from "../service"
import type { EnclaveForwarder } from "../forwarder"
import { buildEnclaveSessionAssignment } from "./request-builder"

/** How many prior messages of context to forward. */
const MAX_HISTORY_MESSAGES = 30

export interface EnclaveInvokeWorkerDeps {
  pool: Pool
  enclaveForwarder: EnclaveForwarder
}

/**
 * Assigns a user turn in an E2E scratchpad to a live enclave. The backend never
 * decrypts: it creates the `agent_sessions` row, ships ciphertext + the SSK wraps
 * addressed to a chosen live EIK, and hands the session off (the enclave acks 202
 * and drives the loop asynchronously, reporting back over the session callbacks).
 * Ariadne's replies are written by the `/complete` callback, not here.
 */
export function createEnclaveInvokeWorker(deps: EnclaveInvokeWorkerDeps): JobHandler<EnclaveInvokeJobData> {
  const { pool, enclaveForwarder } = deps

  return async (job) => {
    const { workspaceId, streamId, messageId: triggerId } = job.data

    const e2e = await E2eStreamsRepository.getByStreamId(pool, workspaceId, streamId)
    if (!e2e) return

    const actors = await E2eStreamActorsRepository.listForStream(pool, workspaceId, streamId)
    if (!actors.some((a) => a.kind === "enclave")) return

    // Idempotency: a turn already has a session in flight or done for this trigger
    // (job redelivered after a prior success). A FAILED session is allowed to
    // re-assign — a fresh session id is minted below, so the retry is clean.
    const existing = await AgentSessionRepository.findByTriggerMessage(pool, triggerId)
    if (existing && (existing.status === SessionStatuses.RUNNING || existing.status === SessionStatuses.COMPLETED)) {
      return
    }

    // The enclave serves Ariadne; refuse if that persona isn't e2e-capable.
    if (!isE2eCapablePersona(ARIADNE_AGENT_ID)) return
    const persona = getBuiltInAgentConfig(ARIADNE_AGENT_ID)
    if (!persona) return

    const trigger = await MessageRepository.findById(pool, triggerId)
    if (!trigger || !trigger.ciphertext) return // gone, or not an E2E message

    const [liveEiks, wraps, surrounding] = await Promise.all([
      EnclaveRuntimesRepository.listLive(pool, ENCLAVE_RUNTIME_STALENESS_MS),
      StreamE2eKeyWrapsRepository.listForStream(pool, workspaceId, streamId),
      MessageRepository.findSurrounding(pool, triggerId, streamId, MAX_HISTORY_MESSAGES, 0),
    ])

    const sid = newSessionId()
    const built = buildEnclaveSessionAssignment({
      e2e,
      actors,
      liveEiks,
      wraps,
      trigger,
      priorMessages: surrounding.filter((m) => m.id !== triggerId),
      persona: {
        systemPrompt: persona.systemPrompt,
        model: persona.model,
        temperature: persona.temperature,
        maxTokens: persona.maxTokens,
      },
      replySenderId: ARIADNE_AGENT_ID,
      sessionId: sid,
    })
    if (!built) {
      logger.info({ workspaceId, streamId }, "enclave dispatch: no live enclave can serve this stream; skipping")
      return
    }

    // Create the session row owned by the chosen EIK. Skip if another session is
    // already RUNNING for this stream (one-running-per-stream guard, INV-20).
    // last_seen_sequence is an inert placeholder here; mid-turn reconsideration
    // (which uses it) is a later slice.
    const session = await AgentSessionRepository.insertRunningOrSkip(pool, {
      id: sid,
      streamId,
      personaId: ARIADNE_AGENT_ID,
      triggerMessageId: triggerId,
      serverId: built.keyId,
      initialSequence: 0n,
    })
    if (!session) return

    try {
      await enclaveForwarder.assignSession(built.instanceUrl, built.assignment)
    } catch (err) {
      // Handoff failed — don't leave the session hanging RUNNING. Mark it FAILED
      // (so it doesn't trip the one-running guard) and rethrow for job retry.
      await AgentSessionRepository.updateStatus(pool, session.id, SessionStatuses.FAILED, {
        error: "enclave assign failed",
        onlyIfStatus: SessionStatuses.RUNNING,
      }).catch(() => {})
      throw err
    }

    logger.info({ workspaceId, streamId, sessionId: sid, keyId: built.keyId }, "Enclave session assigned")
  }
}
