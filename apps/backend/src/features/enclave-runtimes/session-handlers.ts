import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "../agents"
import { StreamRepository } from "../streams"
import type { EventService } from "../messaging"

/**
 * Session callbacks the enclave calls while it owns an assigned turn. The enclave
 * authenticates with the shared internal-api-key (same gate as register/heartbeat),
 * and everything it sends is ciphertext — the backend writes sealed replies but
 * never sees plaintext (INV-E7).
 *
 *   POST /internal/enclave-runtimes/sessions/:id/heartbeat  — liveness refresh
 *   POST /internal/enclave-runtimes/sessions/:id/messages   — one sealed reply, streamed
 *   POST /internal/enclave-runtimes/sessions/:id/complete   — ack (ids + metadata)
 */

// Same opaque placeholder the user-send path stores for E2E rows (INV-E1: the
// canonical payload is the ciphertext; plaintext consumers see this).
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

const streamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.string().min(1),
  aad: z.string().min(1),
})

const messageSchema = z.object({
  messageId: z.string().min(1),
  ciphertext: z.string().min(1),
  envelope: streamEnvelopeSchema,
})

const completeSchema = z.object({
  messageIds: z.array(z.string().min(1)).max(64),
  model: z.string().min(1),
  usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() }).optional(),
})

interface Dependencies {
  pool: Pool
  eventService: EventService
}

/**
 * The session must be the live target of a callback. A missing row is 404; any
 * terminal status (COMPLETED/DELETED/SUPERSEDED/FAILED) is 409 — the turn was
 * finished, cancelled, or reclaimed, so the enclave should stop and discard.
 * Callers that special-case COMPLETED (idempotent acks) check it before this.
 */
function assertRunning(session: AgentSession | null): asserts session is AgentSession {
  if (!session) throw new HttpError("Session not found", { status: 404, code: "SESSION_NOT_FOUND" })
  if (session.status !== SessionStatuses.RUNNING) {
    throw new HttpError("Session is not running", { status: 409, code: "SESSION_NOT_RUNNING" })
  }
}

export function createEnclaveSessionHandlers({ pool, eventService }: Dependencies) {
  return {
    /**
     * POST /internal/enclave-runtimes/sessions/:id/heartbeat
     * Keeps the session's `heartbeat_at` fresh so orphan-cleanup doesn't reclaim
     * it while the enclave is still working.
     */
    async heartbeat(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })
      await AgentSessionRepository.updateHeartbeat(pool, id)
      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/sessions/:id/messages
     * Write one sealed reply the moment the loop streamed it (so interim messages
     * appear in real time). The created message broadcasts via the normal outbox
     * path. Idempotent: the enclave-minted id keys a clientMessageId dedupe.
     */
    async message(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = messageSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const reply = parsed.data
      await eventService.createMessage({
        id: reply.messageId,
        workspaceId: stream.workspaceId,
        streamId: session.streamId,
        // Stamp the session so the message is reachable via session→messages
        // reverse lookup — required for orphan/supersede cleanup of a reply that
        // was streamed before the turn failed mid-flight.
        sessionId: id,
        authorId: session.personaId,
        authorType: AuthorTypes.PERSONA,
        contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
        contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
        ciphertext: Buffer.from(reply.ciphertext, "base64"),
        envelope: reply.envelope,
        e2eVersion: 2,
        // Restrict the agent's reach to this scratchpad; dedupe a redelivered
        // stream so a reply can't post twice (keyed by the enclave-minted id).
        accessibleStreamIds: [session.streamId],
        clientMessageId: `enclave-reply:${id}:${reply.messageId}`,
      })

      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/sessions/:id/complete
     * The ack: the replies were already streamed via `.../messages`, so this just
     * records the sent ids and marks the session COMPLETED. Idempotent on
     * redelivery — an already-completed session no-ops.
     */
    async complete(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = completeSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      if (session?.status === SessionStatuses.COMPLETED) {
        res.status(200).json({ status: "already_completed" }) // idempotent redelivery
        return
      }
      assertRunning(session)

      const messageIds = parsed.data.messageIds
      await AgentSessionRepository.completeSession(pool, id, {
        lastSeenSequence: session.lastSeenSequence ?? 0n,
        responseMessageId: messageIds[0] ?? null,
        sentMessageIds: messageIds,
      })

      res.status(204).end()
    },
  }
}
