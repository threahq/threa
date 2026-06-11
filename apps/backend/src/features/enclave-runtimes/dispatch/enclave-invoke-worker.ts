import type { Pool } from "pg"
import type { Server } from "socket.io"
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
import { AttachmentRepository } from "../../attachments"
import type { StorageProvider } from "../../../lib/storage/s3-client"
import {
  AgentSessionRepository,
  SessionStatuses,
  ARIADNE_AGENT_ID,
  buildEnclaveSystemPrompt,
  failSessionWithLifecycle,
  getBuiltInAgentConfig,
  isE2eCapablePersona,
} from "../../agents"
import { EnclaveRuntimesRepository } from "../repository"
import { ENCLAVE_RUNTIME_STALENESS_MS } from "../service"
import type { EnclaveForwarder } from "../forwarder"
import { buildEnclaveSessionAssignment } from "./request-builder"
import { StreamTypes, type EnclaveStreamEnvelope } from "@threa/types"
import { TURN_DIGEST_INJECT_COUNT } from "@threa/agent-runtime"

/** How many prior messages of context to forward. */
const MAX_HISTORY_MESSAGES = 30

/**
 * Caps on inline attachment shipping (the enclave can't fetch from S3, so
 * ciphertext rides the assignment as base64). Per-file: ~16MB ciphertext
 * (≈21MB base64) — past that no model reads it anyway. Total: ~32MB of
 * base64 across all files, inside the enclave's 48mb `/sessions` body limit
 * with room for history + system prompt. Files over the cap are dropped with
 * a warn (no silent cap) and surface to the model as an "unavailable" note.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_INLINE_TOTAL_BASE64_CHARS = 32 * 1024 * 1024
/** Count cap, mirrored by the enclave schema's `MAX_INLINE_ATTACHMENTS` — a
 *  flood of tiny files must not push the assignment past what it accepts. */
const MAX_INLINE_ATTACHMENT_COUNT = 64

export interface EnclaveInvokeWorkerDeps {
  pool: Pool
  io: Server
  enclaveForwarder: EnclaveForwarder
  /**
   * Reads attachment ciphertext from S3 to ship inline to the enclave. The
   * backend can't decrypt it (the per-file key is sealed in the prompt) — it only
   * relays the opaque bytes so the enclave's egress stays pinned to backend +
   * OpenRouter.
   */
  storage: StorageProvider
}

/**
 * Assigns a user turn in an E2E scratchpad to a live enclave. The backend never
 * decrypts: it creates the `agent_sessions` row, ships ciphertext + the SSK wraps
 * addressed to a chosen live EIK, and hands the session off (the enclave acks 202
 * and drives the loop asynchronously, reporting back over the session callbacks).
 * Ariadne's replies are written by the `/complete` callback, not here.
 */
export function createEnclaveInvokeWorker(deps: EnclaveInvokeWorkerDeps): JobHandler<EnclaveInvokeJobData> {
  const { pool, io, enclaveForwarder, storage } = deps
  const userPreferencesService = new UserPreferencesService(pool)

  return async (job) => {
    const { workspaceId, streamId, messageId: triggerId } = job.data

    // A thread shares its root scratchpad's E2E identity (SSK wraps, owner, tool
    // policy, custom instructions); it carries no wraps of its own. Resolve all
    // key material against the root: the SSK wraps are HPKE-bound to the root's
    // id, so the enclave must unwrap under it (assignment.streamId = e2e.streamId
    // = root). The reply still lands in the thread — the session row below is
    // keyed by the thread `streamId`, independent of the assignment's streamId.
    const triggerStream = await StreamRepository.findById(pool, streamId)
    if (!triggerStream) return
    const e2eStreamId = triggerStream.rootStreamId ?? streamId

    const e2e = await E2eStreamsRepository.getByStreamId(pool, workspaceId, e2eStreamId)
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

    const [liveEiks, wraps, surrounding, rootStream, preferences, authors] = await Promise.all([
      EnclaveRuntimesRepository.listLive(pool, ENCLAVE_RUNTIME_STALENESS_MS),
      // Root's wraps — the thread shares the root's SSK and has no wraps of its own.
      StreamE2eKeyWrapsRepository.listForStream(pool, workspaceId, e2eStreamId),
      MessageRepository.findSurrounding(pool, triggerId, streamId, MAX_HISTORY_MESSAGES, 0),
      triggerStream.rootStreamId
        ? StreamRepository.findById(pool, triggerStream.rootStreamId)
        : Promise.resolve(triggerStream),
      userPreferencesService.getPreferences(workspaceId, trigger.authorId),
      UserRepository.findByIds(pool, workspaceId, [trigger.authorId]),
    ])
    if (!rootStream) return
    // Display name for the enclave's "Triggered by" CONTEXT step (metadata only).
    // Left undefined when unresolved → the enclave suppresses the row rather than
    // rendering a misleading "Unknown" author.
    const triggerAuthorName = authors[0]?.name

    // Assemble Ariadne's system prompt with the SAME shared builder the main app
    // uses (temporal grounding, response style, send_message rules, tool sections,
    // trust boundary, and the owner's scratchpad custom instructions) — only the
    // toolset is reduced. The enclave runs the same loop on the same prompt; just
    // the I/O is encrypted. This is the raw text the backend ships; the message
    // content stays ciphertext.
    const systemPrompt = await buildEnclaveSystemPrompt({ pool, stream: rootStream, preferences, persona })

    // Ship attachment ciphertext inline so the enclave can read files (it can't
    // reach S3 — egress is backend + OpenRouter only): the trigger's files plus
    // recent history's, so a follow-up like "what does the file say?" still has
    // the bytes of a file shared a few turns earlier. We can't know which
    // attachmentIds the sealed payloads reference, so we ship every E2E row
    // bound to those messages; the enclave matches them by id to the refs it
    // decrypts. Budget-bounded newest-first (trigger wins), and best-effort per
    // file: a read failure drops that one attachment rather than failing the turn.
    const attachmentCiphertextIds = [
      triggerId,
      ...surrounding
        .filter((m) => m.id !== triggerId)
        .map((m) => m.id)
        .reverse(),
    ]
    const attachmentCiphertexts = await loadAttachmentCiphertexts(pool, storage, attachmentCiphertextIds)

    // Prior turns' sealed digests (C-1): ship the opaque turn_digest step
    // ciphertext from this stream's recent completed sessions so the enclave —
    // the only party holding the SSK wraps — can fold them into the turn's
    // context. The backend never opens them (INV-E7); the enclave skips any
    // generation it has no wrap for.
    const digestRows = await AgentSessionRepository.findRecentDigestStepsByStream(pool, {
      streamId,
      personaId: ARIADNE_AGENT_ID,
      limit: TURN_DIGEST_INJECT_COUNT,
    })
    const recentDigests = digestRows
      .filter((row) => row.step.contentCiphertext && row.step.contentEnvelope)
      .reverse() // newest-first from the repo → oldest-first for the prompt
      .map((row) => ({
        ciphertext: row.step.contentCiphertext!,
        envelope: row.step.contentEnvelope as EnclaveStreamEnvelope,
        completedAt: (row.step.completedAt ?? row.sessionCreatedAt).toISOString(),
      }))

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
      attachmentCiphertexts,
      recentDigests,
      // Ask the enclave to seal a title only for an untitled scratchpad: gate on
      // the *trigger's own* stream (a top-level scratchpad message titles it; a
      // thread reply never does), while `e2e.hasSealedName` is the root's — the
      // scratchpad that owns the title. (`e2e` resolves to the root for threads.)
      autoTitle: triggerStream.type === StreamTypes.SCRATCHPAD && !e2e.hasSealedName,
    })
    if (!built) {
      // Park, don't drop: no live EIK can both open the trigger and seal the
      // reply — either no enclave is running, or every live EIK is missing this
      // stream's wrap (an enclave restart mints a fresh EIK, orphaning streams
      // wrapped to the old one). Throwing hands the job to the queue's
      // retry/backoff; meanwhile the owner's unlocked client — which just sent
      // the message, so it's looking at the stream — auto-revives the wrap via
      // `POST …/e2e/actor-key-wraps`, and the next retry succeeds. Exhausted
      // retries land in the DLQ: visible, never a silent no-reply.
      throw new Error(
        `No live enclave key can serve stream ${streamId} (live EIKs: ${liveEiks.length}); parking turn for retry`
      )
    }

    // Create the session row owned by the chosen EIK — skip if another session is
    // already RUNNING for this stream (one-running-per-stream guard, INV-20) — and
    // surface the turn in the stream view in the same transaction (INV-7), so a
    // session row never exists without its started event (a crash between the two
    // would leave an invisible RUNNING session the one-running guard then blocks
    // on). The enclave path otherwise emits only sealed
    // `agent_session:step:completed` to the session room (the trace dialog) —
    // nothing the inline `useAgentActivity` surface subscribes to. Emitting the
    // same `agent_session:started` lifecycle event the in-process companion emits
    // makes the scratchpad show "Ariadne is working…" and the trace reachable.
    // Plaintext-free: the payload carries only ids + the persona name.
    // last_seen_sequence is an inert placeholder here; mid-turn reconsideration
    // (which uses it) is a later slice.
    const session = await withTransaction(pool, async (tx) => {
      const created = await AgentSessionRepository.insertRunningOrSkip(tx, {
        id: sid,
        streamId,
        personaId: ARIADNE_AGENT_ID,
        triggerMessageId: triggerId,
        serverId: built.keyId,
        initialSequence: 0n,
      })
      if (!created) return null
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
          startedAt: created.createdAt.toISOString(),
        },
        actorId: ARIADNE_AGENT_ID,
        actorType: "persona",
      })
      await OutboxRepository.insert(tx, "agent_session:started", { workspaceId, streamId, event: startedEvent })
      return created
    })
    if (!session) return

    try {
      await enclaveForwarder.assignSession(built.instanceUrl, built.assignment)
    } catch (err) {
      // Handoff failed — mark the session FAILED *and emit the failed lifecycle*
      // so the started card above terminates instead of spinning: orphan-cleanup
      // can't backstop a session we mark FAILED ourselves (it only scans RUNNING).
      // The retry (and the one-running guard) can then re-assign a fresh session.
      // If this write fails too, log it loudly (INV-11, not a silent swallow) and
      // still rethrow the original assign error: the session stays RUNNING with no
      // live enclave heartbeating it, which orphan-cleanup *does* reclaim. A
      // durable pre-handoff state is part of the resume rework (Slice C).
      await failSessionWithLifecycle(
        pool,
        io,
        { id: session.id, streamId, personaId: ARIADNE_AGENT_ID },
        "Enclave assignment failed"
      ).catch((statusErr) =>
        logger.error({ statusErr, sessionId: session.id }, "Failed to mark session FAILED after assign failure")
      )
      throw err
    }

    logger.info({ workspaceId, streamId, sessionId: sid, keyId: built.keyId }, "Enclave session assigned")
  }
}

/**
 * Read the opaque ciphertext for every E2E attachment bound to the given
 * messages (trigger first, then newest history) and base64-encode it for
 * inline shipping. The backend never decrypts: the per-file keys are sealed
 * inside the messages and recovered only in the enclave. Best-effort — a
 * single unreadable object is dropped (the enclave then notes the file as
 * unavailable) rather than failing the whole turn.
 */
async function loadAttachmentCiphertexts(
  pool: Pool,
  storage: StorageProvider,
  /** Message ids in shipping priority order (trigger first, then newest history). */
  messageIds: string[]
): Promise<{ attachmentId: string; ciphertext: string }[]> {
  const byMessage = await AttachmentRepository.findByMessageIds(pool, messageIds)
  const e2eRows = messageIds.flatMap((id) => (byMessage.get(id) ?? []).filter((a) => a.e2eOnly))
  if (e2eRows.length === 0) return []

  const results = await Promise.all(
    e2eRows.map(async (a) => {
      if (a.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES) {
        logger.warn(
          { attachmentId: a.id, sizeBytes: a.sizeBytes, cap: MAX_INLINE_ATTACHMENT_BYTES },
          "enclave dispatch: attachment exceeds inline cap; skipping"
        )
        return null
      }
      try {
        const bytes = await storage.getObject(a.storagePath)
        return { attachmentId: a.id, ciphertext: bytes.toString("base64") }
      } catch (err) {
        logger.warn({ err, attachmentId: a.id }, "enclave dispatch: failed to read attachment ciphertext; skipping")
        return null
      }
    })
  )
  const loaded = results.filter((r): r is { attachmentId: string; ciphertext: string } => r !== null)

  // Total cap: keep the assignment inside the enclave's body limit. `loaded`
  // preserves priority order (trigger first, then newest history), so when the
  // budget runs out it's the oldest files that drop — with a warn, never
  // silently. A dropped file surfaces to the model as an "unavailable" note.
  const shipped: { attachmentId: string; ciphertext: string }[] = []
  let totalChars = 0
  for (const item of loaded) {
    if (shipped.length >= MAX_INLINE_ATTACHMENT_COUNT) {
      logger.warn(
        { attachmentId: item.attachmentId, cap: MAX_INLINE_ATTACHMENT_COUNT },
        "enclave dispatch: inline attachment count cap reached; skipping remaining file"
      )
      continue
    }
    if (totalChars + item.ciphertext.length > MAX_INLINE_TOTAL_BASE64_CHARS) {
      logger.warn(
        { attachmentId: item.attachmentId, totalChars, cap: MAX_INLINE_TOTAL_BASE64_CHARS },
        "enclave dispatch: inline attachment budget exhausted; skipping remaining file"
      )
      continue
    }
    shipped.push(item)
    totalChars += item.ciphertext.length
  }
  return shipped
}
