import type { Pool } from "pg"
import { AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { messageId } from "../../../lib/id"
import { logger } from "../../../lib/logger"
import type { EnclaveInvokeJobData, JobHandler } from "../../../lib/queue/job-queue"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../../e2e-streams"
import { MessageRepository, type EventService } from "../../messaging"
import { ARIADNE_AGENT_ID, getBuiltInAgentConfig, isE2eCapablePersona } from "../../agents"
import { EnclaveRuntimesRepository } from "../repository"
import { ENCLAVE_RUNTIME_STALENESS_MS } from "../service"
import type { EnclaveForwarder } from "../forwarder"
import { buildEnclaveInvokeRequest } from "./request-builder"

/** How many prior messages of context to forward. */
const MAX_HISTORY_MESSAGES = 30

// Same opaque placeholder the user-send path stores for E2E rows (INV-E1: the
// canonical payload is the ciphertext; plaintext consumers see this).
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

export interface EnclaveInvokeWorkerDeps {
  pool: Pool
  enclaveForwarder: EnclaveForwarder
  eventService: EventService
}

/**
 * Forwards a user turn in an E2E scratchpad to the enclave and writes Ariadne's
 * sealed reply back. The backend never decrypts: it ships ciphertext + the SSK
 * wraps addressed to a live EIK, and stores the reply the enclave seals. The
 * reply is authored by the persona, so the dispatch handler (user-only) never
 * re-triggers on it.
 */
export function createEnclaveInvokeWorker(deps: EnclaveInvokeWorkerDeps): JobHandler<EnclaveInvokeJobData> {
  const { pool, enclaveForwarder, eventService } = deps

  return async (job) => {
    const { workspaceId, streamId, messageId: triggerId } = job.data

    const e2e = await E2eStreamsRepository.getByStreamId(pool, workspaceId, streamId)
    if (!e2e) return

    const actors = await E2eStreamActorsRepository.listForStream(pool, workspaceId, streamId)
    if (!actors.some((a) => a.kind === "enclave")) return

    // Idempotency: if a reply for this trigger already exists (the job was
    // redelivered after a prior full success), skip — don't re-invoke the
    // enclave. This covers the common at-least-once case cheaply. The narrow
    // window where invoke() succeeded but createMessage never committed can
    // still re-invoke; durable invoke-tracking (a tracking table, INV-57) lands
    // with the agent-loop/session follow-up that reworks this path.
    const replyDedupeKey = `enclave-reply:${triggerId}`
    if (await MessageRepository.findByClientMessageId(pool, streamId, replyDedupeKey)) return

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

    const replyMessageId = messageId()
    const built = buildEnclaveInvokeRequest({
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
      replyMessageId,
      replySenderId: ARIADNE_AGENT_ID,
    })
    if (!built) {
      logger.info({ workspaceId, streamId }, "enclave dispatch: no live enclave can serve this stream; skipping")
      return
    }

    const response = await enclaveForwarder.invoke(built.instanceUrl, built.request)

    await eventService.createMessage({
      id: replyMessageId,
      workspaceId,
      streamId,
      authorId: ARIADNE_AGENT_ID,
      authorType: AuthorTypes.PERSONA,
      contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
      contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
      ciphertext: Buffer.from(response.ciphertext, "base64"),
      envelope: response.envelope,
      e2eVersion: 2,
      // Restrict agent reach to this scratchpad; and dedupe a redelivered job so
      // a transient retry can't post Ariadne's reply twice.
      accessibleStreamIds: [streamId],
      clientMessageId: replyDedupeKey,
    })
  }
}
