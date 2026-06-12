import { z } from "zod"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { timingSafeEqual } from "node:crypto"
import {
  AGENT_STEP_TYPES,
  AuthorTypes,
  E2E_PLACEHOLDER_CONTENT_MARKDOWN,
  ENCLAVE_CALLBACK_TOKEN_HEADER,
  type JSONContent,
} from "@threa/types"
import { withTransaction } from "../../db"
import { eventId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { OutboxRepository } from "../../lib/outbox"
import { JobQueues, type QueueManager } from "../../lib/queue"
import { HttpError } from "../../lib/errors"
import {
  AgentSessionRepository,
  SessionStatuses,
  getBuiltInAgentConfig,
  failSessionWithLifecycle,
  type AgentSession,
} from "../agents"
import { StreamRepository, StreamEventRepository } from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { serializeTraceStep } from "../public-api"
import { MessageRepository, type EventService } from "../messaging"
import type { AICostServiceLike } from "../ai-usage"
import { hashCallbackToken } from "./callback-token"
import { parseModelId } from "@threa/agent-runtime"

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
 *   POST /internal/enclave-runtimes/sessions/:id/fail       — terminate on loop error
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

// A sealed auto-generated stream name. Like a reply but without a messageId — a
// name is a single per-stream slot, not a message. Same base64 validation.
const sealedNameSchema = z.object({
  ciphertext: z.base64().min(1),
  envelope: streamEnvelopeSchema,
})

const completeSchema = z.object({
  messageIds: z.array(z.string().min(1)).max(64),
  model: z.string().min(1),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      // OpenRouter's billed cost (USD) for the turn — aggregate accounting, not
      // content. Recorded against the workspace/user like a companion turn (#9).
      cost: z.number().optional(),
    })
    .optional(),
})

// The enclave's scrubbed failure classification — `errorName` is the thrown
// error's class name (e.g. "AbortError"), never plaintext content (INV-E7): the
// loop runs after the prompt/history are decrypted, so the raw error is withheld.
// Bounded so a misbehaving caller can't persist an unbounded string on the row.
const failSchema = z.object({
  errorName: z.string().min(1).max(200),
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
  /** Enqueues the catch-up follow-up turn on completion (enclave interjection parity). */
  jobQueue: QueueManager
  /** Records the turn's token/cost usage at completion, same path companion turns use (#9). */
  costService: AICostServiceLike
}

/**
 * The session must be the live target of a callback. A missing row is 404; any
 * terminal status (COMPLETED/DELETED/SUPERSEDED/FAILED) is 409 — the turn was
 * finished, cancelled, or reclaimed, so the enclave should stop and discard.
 * Callers that special-case COMPLETED (idempotent acks) check it before this.
 */
/**
 * Phase 2.4b (E2EE-21): bind callbacks to the session's assigned runner. The
 * cleartext token was minted at dispatch and delivered only inside the sealed
 * assignment to the pinned EIK's instance — possession proves the caller is
 * the runner this session was assigned to (a stronger binding than a
 * self-reported keyId, which any internal-key holder could copy). The row
 * holds only the sha256 digest, so the presented value is hashed before the
 * timing-safe compare (both sides are fixed-length hex). Rollout phase 1: a
 * presented token must match; an absent token is tolerated so sessions in
 * flight across the deploy boundary drain cleanly. The reject-if-absent flip
 * (for rows that carry a hash) is the later one-liner.
 */
function assertCallbackBound(session: AgentSession, req: Request): void {
  const presented = req.header(ENCLAVE_CALLBACK_TOKEN_HEADER)
  if (!presented) return
  const expected = session.callbackTokenHash
  const presentedHash = Buffer.from(hashCallbackToken(presented))
  if (!expected || !timingSafeEqual(presentedHash, Buffer.from(expected))) {
    throw new HttpError("Callback token mismatch", { status: 403, code: "CALLBACK_TOKEN_MISMATCH" })
  }
}

/**
 * Phase 2.4b (E2EE-21): a seal under any generation other than the one the
 * assignment prescribed would persist as a permanently undecryptable row —
 * reject it loudly so the turn fails visibly instead. Sessions dispatched
 * before the column shipped (NULL) are exempt.
 */
function assertReplyGeneration(session: AgentSession, envelope: { keyGeneration: number } | undefined): void {
  if (!envelope || session.replyKeyGeneration == null) return
  if (envelope.keyGeneration !== session.replyKeyGeneration) {
    throw new HttpError(
      `Sealed payload uses key generation ${envelope.keyGeneration}; this session seals under ${session.replyKeyGeneration}`,
      { status: 400, code: "E2E_WRONG_KEY_GENERATION" }
    )
  }
}

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

export function createEnclaveSessionHandlers({ pool, eventService, io, jobQueue, costService }: Dependencies) {
  return {
    /**
     * POST /internal/enclave-runtimes/sessions/:id/heartbeat
     * Keeps the session's `heartbeat_at` fresh so orphan-cleanup doesn't reclaim
     * it while the enclave is still working.
     */
    async heartbeat(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })
      // No assertRunning here on purpose — a late heartbeat against a finished
      // session has always been a harmless no-op, only the binding is enforced.
      const session = await AgentSessionRepository.findById(pool, id)
      if (session) assertCallbackBound(session, req)
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
      assertCallbackBound(session, req)
      assertReplyGeneration(session, parsed.data.envelope)
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
     * POST /internal/enclave-runtimes/sessions/:id/sealed-name
     * Persist the enclave's sealed auto-title for an untitled E2E scratchpad
     * (the server can't title it — it only holds ciphertext). First-write-wins
     * (`setSealedNameIfAbsent`), and on a real change we re-read the e2e-joined
     * stream and broadcast `stream:updated` so the sidebar/header pick up the
     * name and decrypt it live. We never set a plaintext display name — the
     * title exists only as ciphertext.
     */
    async sealedName(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = sealedNameSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      assertCallbackBound(session, req)
      assertReplyGeneration(session, parsed.data.envelope)
      const stream = await StreamRepository.findById(pool, session.streamId)
      if (!stream) throw new HttpError("Stream not found", { status: 404, code: "STREAM_NOT_FOUND" })

      await withTransaction(pool, async (client) => {
        const set = await E2eStreamsRepository.setSealedNameIfAbsent(client, stream.workspaceId, session.streamId, {
          ciphertext: parsed.data.ciphertext,
          envelope: parsed.data.envelope,
        })
        if (!set) return
        const updated = (await StreamRepository.findById(client, session.streamId)) ?? stream
        await OutboxRepository.insert(client, "stream:updated", {
          workspaceId: updated.workspaceId,
          streamId: updated.id,
          stream: updated,
        })
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
      assertCallbackBound(session, req)
      assertReplyGeneration(session, parsed.data.envelope)
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
      assertCallbackBound(session, req)
      assertReplyGeneration(session, parsed.data.envelope)
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
      assertCallbackBound(session, req)
      assertReplyGeneration(session, parsed.data.envelope)
      assertReplyGeneration(session, parsed.data.snapshotEnvelope)
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
      assertCallbackBound(session, req)

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

      // Record the turn's usage against the workspace + invoking user, the same
      // recording path a companion turn uses (#9). The enclave runs no OTEL
      // (egress discipline), so it reports summed token counts + OpenRouter's
      // billed cost and we record them here — aggregate accounting, never content
      // (INV-E7). Only after we actually won the RUNNING→COMPLETED transition, so
      // a redelivery (handled by the already-completed no-op above) can't
      // double-charge. Best-effort: a recording failure must not fail the ack.
      if (committed && stream && parsed.data.usage) {
        const usage = parsed.data.usage
        try {
          // The invoking user is the trigger message's author (the session row
          // stores only the trigger message id). Origin is always "user": the
          // enclave runs solely for user-sent E2E scratchpad messages.
          const triggerMessage = await MessageRepository.findById(pool, session.triggerMessageId)
          // The enclave routes exclusively through OpenRouter and reports the bare
          // model id (the `openrouter:` prefix is stripped at dispatch), so re-derive
          // the provider with the same parser the companion records through.
          const parsedModel = parseModelId(`openrouter:${parsed.data.model}`)
          await costService.recordUsage({
            workspaceId: stream.workspaceId,
            userId: triggerMessage?.authorId,
            sessionId: id,
            functionId: "enclave-agent-loop",
            model: parsedModel.modelId,
            provider: parsedModel.provider,
            origin: "user",
            usage: {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
              cost: usage.cost,
            },
          })
        } catch (err) {
          logger.error({ err, sessionId: id, streamId: session.streamId }, "Enclave usage recording failed")
        }
      }

      // Interjection catch-up (parity with the main app's `checkForUnseenMessages`,
      // persona-agent-worker.ts): a user message that landed while this turn ran was
      // suppressed by the one-running guard in the enclave-invoke worker, so dispatch
      // a follow-up turn for the latest such message. The enclave saw history up to
      // its trigger and nothing after, so the trigger's sequence is the "seen"
      // boundary. Only after we actually won the completion, so a raced redelivery
      // doesn't double-dispatch. Best-effort: a failed enqueue is logged, not fatal —
      // the next user message would re-trigger anyway.
      if (committed && stream && session.triggerMessageId) {
        try {
          const triggerSeq = await StreamEventRepository.getMessageSequence(
            pool,
            session.streamId,
            session.triggerMessageId
          )
          if (triggerSeq !== null) {
            const unseen = await StreamEventRepository.getLatestUnseenUserMessage(pool, session.streamId, triggerSeq)
            if (unseen) {
              await jobQueue.send(JobQueues.ENCLAVE_INVOKE, {
                workspaceId: stream.workspaceId,
                streamId: session.streamId,
                messageId: unseen.messageId,
                triggeredBy: unseen.authorId,
              })
            }
          }
        } catch (err) {
          logger.error(
            { err, sessionId: id, streamId: session.streamId },
            "Enclave interjection follow-up dispatch failed"
          )
        }
      }

      res.status(204).end()
    },

    /**
     * POST /internal/enclave-runtimes/sessions/:id/fail
     * The enclave's turn loop threw, so terminate the session promptly instead of
     * waiting for orphan-cleanup's stale-heartbeat backstop. Drives the same
     * `failSessionWithLifecycle` path the dispatch worker and orphan cleanup use
     * (FAILED + an `agent_session:failed` stream event/outbox + session-room
     * socket), so the inline indicator and an open trace dialog stop spinning at
     * once. The body is a scrubbed error *classification* only — the enclave never
     * sends plaintext (the raw error could carry decrypted payload bytes, INV-E7).
     * `failSessionWithLifecycle` gates on winning the RUNNING→FAILED transition, so
     * a redelivery that raced a concurrent terminal transition no-ops (still 204).
     */
    async fail(req: Request, res: Response) {
      const id = req.params.id
      if (!id) throw new HttpError("Missing session id", { status: 400, code: "VALIDATION_ERROR" })

      const parsed = failSchema.safeParse(req.body)
      if (!parsed.success) throw new HttpError("Invalid request body", { status: 400, code: "VALIDATION_ERROR" })

      const session = await AgentSessionRepository.findById(pool, id)
      assertRunning(session)
      assertCallbackBound(session, req)

      await failSessionWithLifecycle(pool, io, session, `Enclave session failed: ${parsed.data.errorName}`)

      res.status(204).end()
    },
  }
}
