import type { Pool } from "pg"
import { sessionId as newSessionId, eventId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import { withTransaction } from "../../../db"
import { OutboxRepository } from "../../../lib/outbox"
import { StreamEventRepository, StreamRepository } from "../../streams"
import { UserRepository } from "../../workspaces"
import { UserPreferencesService } from "../../user-preferences"
import type { EnclaveInvokeJobData, JobHandler } from "../../../lib/queue/job-queue"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../e2e-streams"
import { MessageRepository } from "../../messaging"
import {
  AgentSessionRepository,
  SessionStatuses,
  ARIADNE_AGENT_ID,
  buildEnclaveSystemPrompt,
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
  const userPreferencesService = new UserPreferencesService(pool)

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

    const [liveEiks, wraps, surrounding, stream, preferences, authors] = await Promise.all([
      EnclaveRuntimesRepository.listLive(pool, ENCLAVE_RUNTIME_STALENESS_MS),
      StreamE2eKeyWrapsRepository.listForStream(pool, workspaceId, streamId),
      MessageRepository.findSurrounding(pool, triggerId, streamId, MAX_HISTORY_MESSAGES, 0),
      StreamRepository.findById(pool, streamId),
      userPreferencesService.getPreferences(workspaceId, trigger.authorId),
      UserRepository.findByIds(pool, workspaceId, [trigger.authorId]),
    ])
    if (!stream) return
    // Display name for the enclave's "Triggered by" CONTEXT step (metadata only).
    const triggerAuthorName = authors[0]?.name ?? "Unknown"

    // Assemble Ariadne's system prompt with the SAME shared builder the main app
    // uses (temporal grounding, response style, send_message rules, tool sections,
    // trust boundary, and the owner's scratchpad custom instructions) — only the
    // toolset is reduced. The enclave runs the same loop on the same prompt; just
    // the I/O is encrypted. This is the raw text the backend ships; the message
    // content stays ciphertext.
    const systemPrompt = await buildEnclaveSystemPrompt({ pool, stream, preferences, persona })

    const sid = newSessionId()
    const built = buildEnclaveSessionAssignment({
      e2e,
      actors,
      liveEiks,
      wraps,
      trigger,
      triggerAuthorName,
      priorMessages: surrounding.filter((m) => m.id !== triggerId),
      persona: {
        systemPrompt,
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

    // Surface the turn in the stream view. The enclave path otherwise emits only
    // sealed `agent_session:step:completed` to the session room (the trace
    // dialog) — nothing the inline `useAgentActivity` surface subscribes to. Emit
    // the same `agent_session:started` lifecycle event the in-process companion
    // emits so the scratchpad shows "Ariadne is working…" and the trace becomes
    // reachable. Plaintext-free: the payload carries only ids + the persona name.
    await withTransaction(pool, async (tx) => {
      const startedEvent = await StreamEventRepository.insert(tx, {
        id: eventId(),
        streamId,
        eventType: "agent_session:started",
        payload: {
          sessionId: sid,
          personaId: ARIADNE_AGENT_ID,
          personaName: persona.name,
          triggerMessageId: triggerId,
          rerunContext: null,
          startedAt: session.createdAt.toISOString(),
        },
        actorId: ARIADNE_AGENT_ID,
        actorType: "persona",
      })
      await OutboxRepository.insert(tx, "agent_session:started", { workspaceId, streamId, event: startedEvent })
    })

    try {
      await enclaveForwarder.assignSession(built.instanceUrl, built.assignment)
    } catch (err) {
      // Handoff failed — mark the session FAILED so the retry (and the
      // one-running guard) can re-assign a fresh session. If that write *also*
      // fails, log it loudly (INV-11, not a silent swallow) and still rethrow the
      // original assign error: orphan-cleanup reclaims a RUNNING session with no
      // live enclave heartbeating it — the same backstop that covers an enclave
      // dying mid-turn. A durable pre-handoff state is part of the resume rework
      // (Slice C).
      await AgentSessionRepository.updateStatus(pool, session.id, SessionStatuses.FAILED, {
        error: "enclave assign failed",
        onlyIfStatus: SessionStatuses.RUNNING,
      }).catch((statusErr) =>
        logger.error({ statusErr, sessionId: session.id }, "Failed to mark session FAILED after assign failure")
      )
      throw err
    }

    logger.info({ workspaceId, streamId, sessionId: sid, keyId: built.keyId }, "Enclave session assigned")
  }
}
