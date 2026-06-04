import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { AGENT_STEP_TYPES, AuthorTypes, E2E_PLACEHOLDER_CONTENT_MARKDOWN, type JSONContent } from "@threa/types"
import { withTransaction } from "../../db"
import { eventId } from "../../lib/id"
import { OutboxRepository } from "../../lib/outbox"
import { HttpError } from "../../lib/errors"
import { AgentSessionRepository, SessionStatuses, getBuiltInAgentConfig, type AgentSession } from "../agents"
import { StreamRepository, StreamEventRepository } from "../streams"
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

// One in-flight step *start*. `stepType` + `stepId` are clear; content is sealed
// when already known (reasoning/reply) and absent for tools (no result yet), so
// ciphertext + envelope are optional here (unlike the finalize, which always has them).
const sealedStepStartSchema = z.object({
  stepId: z.string().min(1),
  stepType: z.enum(AGENT_STEP_TYPES),
  messageId: z.string().min(1).optional(),
  ciphertext: z.base64().min(1).optional(),
  envelope: streamEnvelopeSchema.optional(),
})

// One sealed substep — ephemeral mid-run phase text (e.g. research progress).
// `stepType` is clear metadata; the text is ciphertext (derived from encrypted
// content, INV-E7). Broadcast only, never persisted.
const sealedSubstepSchema = z.object({
  stepType: z.enum(AGENT_STEP_TYPES),
  ciphertext: z.base64().min(1),
  envelope: streamEnvelopeSchema,
  // The in-flight step + running snapshot: when present, the snapshot is
  // persisted onto the step row so a refresh / open mid-run replays the phases.
  stepId: z.string().min(1).optional(),
  snapshotCiphertext: z.base64().min(1).optional(),
  snapshotEnvelope: streamEnvelopeSchema.optional(),
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

/**
 * Drive the inline stream-view indicator (`useAgentActivity`, which subscribes to
 * the *stream* room, not the session room) with the same `agent_session:progress`
 * payload the in-process `startStep` emits. Plaintext-free: step *type* only,
 * never content. Emitted at step *start* so "Ariadne is …" reflects the current
 * step the moment it begins.
 */
function emitInlineProgress(
  io: Server,
  session: AgentSession,
  workspaceId: string,
  stepCount: number,
  currentStepType: string | null
): void {
  const personaName = getBuiltInAgentConfig(session.personaId)?.name ?? "Ariadne"
  io.to(`ws:${workspaceId}:stream:${session.streamId}`).emit("agent_session:progress", {
    workspaceId,
    streamId: session.streamId,
    sessionId: session.id,
    triggerMessageId: session.triggerMessageId,
    personaName,
    stepCount,
    messageCount: 0,
    currentStepType,
  })
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
     * POST /internal/enclave-runtimes/sessions/:id/steps/started
     * Open one in-flight sealed trace step the moment the loop starts it, so an
     * open trace dialog renders the in-progress step (and hangs its live substeps
     * under it) before completion — the exact lifecycle the non-E2E runtime emits,
     * only sealed. Content is ciphertext when already known (reasoning/reply) and
     * absent for tools (no result yet); only `stepType` is clear. A later
     * `/steps` POST finalizes this same `stepId` in place.
     */
    async stepStarted(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = sealedStepStartSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      // The session room is workspace-scoped; the enclave's internal-auth context
      // carries no workspace, so resolve it from the session's stream (as /messages does).
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const step = parsed.data

      // Insert the in-flight row (no completed_at) + current_step_type in one
      // transaction (INV-6) so a reader never sees a new step row without the
      // matching current_step_type. step_number is computed atomically in the
      // INSERT (INV-20) so concurrent starts never clobber each other.
      const persisted = await withTransaction(pool, async (tx) => {
        const created = await AgentSessionRepository.appendStep(tx, {
          id: step.stepId,
          sessionId: id,
          stepType: step.stepType,
          messageId: step.messageId,
          contentCiphertext: step.ciphertext,
          contentEnvelope: step.envelope,
          startedAt: new Date(),
        })
        await AgentSessionRepository.updateCurrentStepType(tx, id, step.stepType)
        return created
      })

      // Live trace: relay the in-progress step to the session room (same
      // serializer as the in-process and Pi paths, so the frontend handler is
      // source-agnostic). completedAt is absent — the dialog shows it in-flight.
      io.to(`ws:${stream.workspaceId}:agent_session:${id}`).emit("agent_session:step:started", {
        sessionId: id,
        step: serializeTraceStep(persisted),
      })

      // Drive the inline stream-view indicator (`useAgentActivity`, stream room)
      // at step *start* — the same point startStep emits progress in-process —
      // so "Ariadne is …" reflects the new step the moment it begins.
      emitInlineProgress(io, session, stream.workspaceId, persisted.stepNumber, persisted.stepType)

      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/sessions/:id/steps
     * Finalize one sealed trace step in place when it completes — set the sealed
     * content + completed_at on the row opened at /steps/started, keeping its
     * original started_at so the duration is real. The content is ciphertext only;
     * the browser decrypts it with the stream key (INV-E7). If the start POST was
     * dropped, fall back to a race-safe completed insert so the trace still lands.
     */
    async steps(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = sealedStepSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const step = parsed.data
      const completedAt = new Date()

      // Finalize the in-flight row opened at step:started — sealed content +
      // completed_at, in place (started_at is preserved, so duration is real).
      let persisted = await AgentSessionRepository.updateStep(pool, step.stepId, {
        contentCiphertext: step.ciphertext,
        contentEnvelope: step.envelope,
        messageId: step.messageId,
        completedAt,
      })

      // Fallback: the start POST never landed (dropped/raced), so there's no row
      // to finalize. Insert a completed row + advance current_step_type (INV-6,
      // INV-20) so the trace and inline indicator still reflect this step.
      if (!persisted) {
        const startedAt = new Date(completedAt.getTime() - (step.durationMs ?? 0))
        persisted = await withTransaction(pool, async (tx) => {
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
        emitInlineProgress(io, session, stream.workspaceId, persisted.stepNumber, persisted.stepType)
      }

      // Live trace: relay the finalized step to the session room (browser
      // decrypts; a bootstrap refetch reads the same row, so refresh is stable).
      // No progress emit on the happy path — the inline indicator already
      // advanced at step:started, mirroring ActiveStep.complete (socket-only).
      io.to(`ws:${stream.workspaceId}:agent_session:${id}`).emit("agent_session:step:completed", {
        sessionId: id,
        step: serializeTraceStep(persisted),
      })

      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/sessions/:id/substeps
     * Relay one sealed substep — mid-run phase text (e.g. the research sub-agent's
     * "Searching the web: …"). The single new phase is broadcast ephemerally to
     * both the stream room (inline "Ariadne is …" indicator) and the session room
     * (trace dialog), mirroring the in-process `emitSubstep` fan-out. When a
     * `stepId` + running `snapshotCiphertext` travel, the snapshot is *also*
     * persisted onto the in-flight step row (no completion) so a refresh / opening
     * the trace mid-run replays the phases so far — mirroring `updateSubsteps`.
     * Everything is ciphertext the browser decrypts (INV-E7); only `stepType` is clear.
     */
    async substep(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = sealedSubstepSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      const sub = parsed.data

      // Persist the running snapshot onto the in-flight step row (sealed, no
      // completion) so a bootstrap refetch recovers the phase timeline. The
      // browser decrypts step.content → { substeps } exactly as for a finalized
      // step. Skipped when the step row isn't known yet (broadcast-only).
      if (sub.stepId && sub.snapshotCiphertext && sub.snapshotEnvelope) {
        // `requireRunning` guards the finalize race: a snapshot that lands after
        // the step's `/steps` finalize (reordering / retry) must not overwrite the
        // final content with a mid-run partial. Once finalized this no-ops.
        await AgentSessionRepository.updateStep(pool, sub.stepId, {
          contentCiphertext: sub.snapshotCiphertext,
          contentEnvelope: sub.snapshotEnvelope,
          requireRunning: true,
        })
      }

      const payload = {
        workspaceId: stream.workspaceId,
        streamId: session.streamId,
        sessionId: id,
        triggerMessageId: session.triggerMessageId,
        stepType: sub.stepType,
        ciphertext: sub.ciphertext,
        envelope: sub.envelope,
        updatedAt: new Date().toISOString(),
      }
      io.to(`ws:${stream.workspaceId}:stream:${session.streamId}`).emit("agent_session:substep", payload)
      io.to(`ws:${stream.workspaceId}:agent_session:${id}`).emit("agent_session:substep", payload)

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
      // Resolve the workspace from the stream (the internal-auth context carries
      // none) so we can address the workspace-scoped rooms, as the other callbacks do.
      const stream = await StreamRepository.findById(pool, session.streamId)
      const completedAt = new Date()

      // Complete the session AND emit the `agent_session:completed` lifecycle event
      // in ONE transaction (INV-7): the status flip and the event the UI needs to
      // drop the "Ariadne is working…" indicator must never diverge. Without the
      // single transaction a crash between them strands a COMPLETED session with no
      // event — and orphan-cleanup only recovers RUNNING sessions, so it would hang
      // forever. Gated on winning the RUNNING→COMPLETED transition so a redelivery
      // that raced doesn't double-emit. Plaintext-free: counts + timing only.
      const committed = await withTransaction(pool, async (tx) => {
        const completed = await AgentSessionRepository.completeSession(tx, id, {
          lastSeenSequence: session.lastSeenSequence ?? 0n,
          responseMessageId: messageIds[0] ?? null,
          sentMessageIds: messageIds,
        })
        if (!completed) return false // raced to a terminal state under us
        // Broadcast needs the workspace (room addressing). A missing stream is an
        // edge (deleted mid-turn): the session is still marked COMPLETED durably,
        // but the lifecycle event/outbox are skipped — same tradeoff the orphan
        // cleanup makes for a streamless reclaim. An open dialog on a now-deleted
        // stream then reconciles on its next bootstrap rather than live.
        if (stream) {
          const steps = await AgentSessionRepository.findStepsBySession(tx, id)
          const completedEvent = await StreamEventRepository.insert(tx, {
            id: eventId(),
            streamId: session.streamId,
            eventType: "agent_session:completed",
            payload: {
              sessionId: id,
              stepCount: steps.length,
              messageCount: messageIds.length,
              duration: completedAt.getTime() - session.createdAt.getTime(),
              completedAt: completedAt.toISOString(),
            },
            actorId: session.personaId,
            actorType: "persona",
          })
          await OutboxRepository.insert(tx, "agent_session:completed", {
            workspaceId: stream.workspaceId,
            streamId: session.streamId,
            event: completedEvent,
          })
        }
        return true
      })

      // Live-update an open trace dialog (session room) the way the in-process
      // `trace.notifyCompleted()` does — the outbox broadcast only reaches the
      // stream room, so the dialog wouldn't otherwise transition until a refetch.
      if (committed && stream) {
        io.to(`ws:${stream.workspaceId}:agent_session:${id}`).emit("agent_session:completed", { sessionId: id })
      }

      res.status(204).end()
    },
  }
}
