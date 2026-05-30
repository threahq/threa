import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AGENT_STEP_TYPES, AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { withTransaction } from "../../db"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses, type AgentSession } from "../agents"
import { StreamRepository } from "../streams"
import { serializeTraceStep } from "../public-api"
import type { EventService } from "../messaging"

/**
 * Session callbacks the enclave calls while it owns an assigned turn. The enclave
 * authenticates with the shared internal-api-key (same gate as register/heartbeat),
 * and everything it sends is ciphertext — the backend writes sealed replies but
 * never sees plaintext (INV-E7).
 *
 *   POST /internal/enclave-runtimes/sessions/:id/heartbeat  — liveness refresh
 *   POST /internal/enclave-runtimes/sessions/:id/messages   — one sealed reply, streamed
 *   POST /internal/enclave-runtimes/sessions/:id/steps      — one sealed trace step, streamed
 *   POST /internal/enclave-runtimes/sessions/:id/complete   — ack (ids + metadata)
 */

// Same opaque placeholder the user-send path stores for E2E rows (INV-E1: the
// canonical payload is the ciphertext; plaintext consumers see this).
const E2E_PLACEHOLDER_CONTENT_JSON: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: E2E_PLACEHOLDER_CONTENT_MARKDOWN }] }],
}

// These base64 fields are persisted verbatim and only decrypted later (in the
// browser / a future enclave read), so validate decodability at the boundary —
// malformed base64 that slips through becomes a permanently unreadable message.
const streamEnvelopeSchema = z.object({
  v: z.number(),
  keyGeneration: z.number().int().min(0),
  iv: z.base64().min(1),
  aad: z.base64().min(1),
})

const messageSchema = z.object({
  messageId: z.string().min(1),
  ciphertext: z.base64().min(1),
  envelope: streamEnvelopeSchema,
})

const completeSchema = z.object({
  messageIds: z.array(z.string().min(1)).max(64),
  model: z.string().min(1),
  usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional() }).optional(),
})

// One sealed trace step. `stepType` + `messageId` + timing are clear; the step's
// content is ciphertext the server can't read (INV-E7). Same base64 validation
// as the reply path — malformed bytes here become a permanently unreadable step.
const sealedStepSchema = z.object({
  stepId: z.string().min(1),
  stepType: z.enum(AGENT_STEP_TYPES),
  messageId: z.string().min(1).optional(),
  ciphertext: z.base64().min(1),
  envelope: streamEnvelopeSchema,
  durationMs: z.number().int().min(0).optional(),
})

interface Dependencies {
  pool: Pool
  eventService: EventService
  /** Sealed steps broadcast to the session room for live trace rendering. Always present in the API process. */
  io: Server
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

export function createEnclaveSessionHandlers({ pool, eventService, io }: Dependencies) {
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
     * POST /internal/enclave-runtimes/sessions/:id/steps
     * Append one sealed trace step the moment the loop emits it, so an open
     * trace dialog renders "Ariadne is thinking…" / her reply in real time. The
     * content is ciphertext only — the browser decrypts it with the stream key
     * (INV-E7). Persisted via the atomic appendStep (step_number computed in the
     * INSERT, INV-20), so concurrent step POSTs never clobber each other.
     */
    async steps(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = sealedStepSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      // The session room is workspace-scoped; the enclave's internal-auth context
      // carries no workspace, so resolve it from the session's stream (as /messages does).
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const step = parsed.data
      const now = Date.now()
      const startedAt = new Date(now - (step.durationMs ?? 0))
      const completedAt = new Date(now)

      // Append + current_step_type in one transaction (INV-6) so a reader never
      // sees a new step row without the matching current_step_type. The latter
      // is plaintext metadata (the step *kind*, no content) driving the
      // cross-stream "Ariadne is working…" display, same as the in-process
      // trace; it's cleared when the session completes.
      const persisted = await withTransaction(pool, async (tx) => {
        const created = await AgentSessionRepository.appendStep(tx, {
          id: step.stepId,
          sessionId: id,
          stepType: step.stepType,
          messageId: step.messageId,
          contentCiphertext: step.ciphertext,
          contentEnvelope: step.envelope,
          startedAt,
          completedAt,
        })
        await AgentSessionRepository.updateCurrentStepType(tx, id, step.stepType)
        return created
      })

      // Live trace: relay the completed step to the session room using the same
      // canonical serializer as the in-process and Pi step paths, so the
      // frontend handler is source-agnostic. The payload carries only ciphertext
      // + envelope (no plaintext, INV-E7); the browser decrypts. A bootstrap
      // refetch reads the same persisted row, so refresh stays consistent.
      io.to(`ws:${stream.workspaceId}:agent_session:${id}`).emit("agent_session:step:completed", {
        sessionId: id,
        step: serializeTraceStep(persisted),
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
