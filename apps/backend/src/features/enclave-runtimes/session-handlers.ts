import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses } from "../agents"
import { StreamRepository } from "../streams"
import type { EventService } from "../messaging"

/**
 * Session callbacks the enclave calls while it owns an assigned turn. The enclave
 * authenticates with the shared internal-api-key (same gate as register/heartbeat),
 * and everything it sends is ciphertext — the backend writes sealed replies but
 * never sees plaintext (INV-E7).
 *
 *   POST /internal/enclave-runtimes/sessions/:id/heartbeat  — liveness refresh
 *   POST /internal/enclave-runtimes/sessions/:id/complete   — sealed replies + ack
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

const completeSchema = z.object({
  messages: z
    .array(
      z.object({
        messageId: z.string().min(1),
        ciphertext: z.string().min(1),
        envelope: streamEnvelopeSchema,
      })
    )
    .max(64),
  model: z.string().min(1),
  usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() }).optional(),
})

interface Dependencies {
  pool: Pool
  eventService: EventService
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
     * POST /internal/enclave-runtimes/sessions/:id/complete
     * The ack: write each sealed reply the loop produced, then mark the session
     * COMPLETED. Idempotent on redelivery — an already-completed session no-ops,
     * and per-message clientMessageId dedupe stops duplicate rows.
     */
    async complete(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = completeSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      if (!session) throw new HttpError("Session not found", { status: 404, code: "SESSION_NOT_FOUND" })
      if (session.status === SessionStatuses.COMPLETED) {
        res.status(200).json({ status: "already_completed" })
        return
      }
      if (session.status !== SessionStatuses.RUNNING) {
        // DELETED/SUPERSEDED/FAILED — the turn was cancelled or reclaimed; discard.
        throw new HttpError("Session is not running", { status: 409, code: "SESSION_NOT_RUNNING" })
      }

      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const sentMessageIds: string[] = []
      for (const [index, reply] of parsed.data.messages.entries()) {
        await eventService.createMessage({
          id: reply.messageId,
          workspaceId: stream.workspaceId,
          streamId: session.streamId,
          authorId: session.personaId,
          authorType: AuthorTypes.PERSONA,
          contentJson: E2E_PLACEHOLDER_CONTENT_JSON,
          contentMarkdown: E2E_PLACEHOLDER_CONTENT_MARKDOWN,
          ciphertext: Buffer.from(reply.ciphertext, "base64"),
          envelope: reply.envelope,
          e2eVersion: 2,
          // Restrict the agent's reach to this scratchpad; dedupe a redelivered
          // completion so replies can't post twice.
          accessibleStreamIds: [session.streamId],
          clientMessageId: `enclave-reply:${id}:${index}`,
        })
        sentMessageIds.push(reply.messageId)
      }

      await AgentSessionRepository.completeSession(pool, id, {
        lastSeenSequence: session.lastSeenSequence ?? 0n,
        responseMessageId: sentMessageIds[0] ?? null,
        sentMessageIds,
      })

      res.status(204).end()
    },
  }
}
