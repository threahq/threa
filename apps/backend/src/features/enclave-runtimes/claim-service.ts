import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { StreamTypes, TitleSources, type EnclaveSessionAssignment, type EnclaveStreamEnvelope } from "@threa/types"
import { TURN_DIGEST_INJECT_COUNT } from "@threa/agent-runtime"
import { sessionId as newSessionId, eventId, enclaveInvocationId } from "../../lib/id"
import { logger } from "../../lib/logger"
import { withTransaction } from "../../db"
import { OutboxRepository } from "../../lib/outbox"
import type { StorageProvider } from "../../lib/storage/s3-client"
import { notifyEnclaveInvocationAvailable } from "./claim-nudge"
import { StreamEventRepository, StreamPoliciesRepository, StreamRepository } from "../streams"
import { UserRepository } from "../workspaces"
import type { UserPreferencesService } from "../user-preferences"
import { E2eStreamActorsRepository, E2eStreamsRepository, StreamE2eKeyWrapsRepository } from "../e2e-streams"
import { MessageRepository } from "../messaging"
import {
  DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
  DynamicNamingStateRepository,
  getNamingEligibility,
} from "../dynamic-naming"
import { AttachmentRepository } from "../attachments"
import {
  AgentSessionRepository,
  ConversationSummaryRepository,
  CONTEXT_WINDOW_CANDIDATE_CEILING,
  DEFAULT_CONTEXT_WINDOW_CHARS,
  SessionStatuses,
  ARIADNE_AGENT_ID,
  buildEnclaveSystemPrompt,
  getBuiltInAgentConfig,
  hashCallbackToken,
  isE2eCapablePersona,
} from "../agents"
import { buildEnclaveSessionAssignment } from "./dispatch/request-builder"
import { ENCLAVE_RUNTIME_STALENESS_MS } from "./service"
import { EnclaveRewrapNotificationsRepository } from "./rewrap-notifications-repository"
import {
  EnclaveInvocationsRepository,
  ENCLAVE_CLAIM_TTL_SECONDS,
  ENCLAVE_CLAIM_MAX_ATTEMPTS,
  ENCLAVE_PENDING_PARK_AFTER_MS,
  type EnclaveInvocation,
  type UnservablePendingInvocation,
} from "./invocations-repository"

/**
 * Caps on inline attachment shipping (the enclave can't fetch from S3, so
 * ciphertext rides the assignment as base64). Per-file: ~16MB ciphertext
 * (≈21MB base64) — past that no model reads it anyway. Total: ~32MB of
 * base64 across all files, matching what the enclave's assignment schema
 * accepts, with room for history + system prompt. Files over the cap are
 * dropped with a warn (no silent cap) and surface to the model as an
 * "unavailable" note.
 */
const MAX_INLINE_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_INLINE_TOTAL_BASE64_CHARS = 32 * 1024 * 1024
/** Count cap, mirrored by the enclave schema's `MAX_INLINE_ATTACHMENTS` — a
 *  flood of tiny files must not push the assignment past what it accepts. */
const MAX_INLINE_ATTACHMENT_COUNT = 64

/**
 * How many no-op claims (trigger gone, actor uninvited, turn already done, …)
 * one poll may consume before answering "no work". Each no-op flips its row
 * terminal, so the next poll resumes where this one stopped — the cap only
 * bounds a single request's latency, never loses work.
 */
const MAX_NO_OP_CLAIMS_PER_POLL = 20

/**
 * A RUNNING session whose heartbeat is older than this is presumed runnerless
 * (a claim response that never reached its enclave) rather than concurrently
 * driven. Mirrors orphan cleanup's `staleThresholdSeconds` — past it, cleanup
 * is about to flip the session FAILED, so the claim defers instead of
 * completing the invocation (which would silently drop the turn).
 */
const STALE_RUNNING_HEARTBEAT_MS = 60_000

/**
 * Re-emit windows for the proactive owner re-wrap nudge. The socket signal
 * heals an online unlocked owner in place, so it re-arms briskly (a newly
 * online owner gets pinged within the window). The web-push nudge re-arms
 * slower — it pulls an offline owner back to the app, and waking a device is
 * costly to repeat — but must stay **under** `ENCLAVE_PENDING_PARK_AFTER_MS`
 * (15 min): the ledger isn't reset when a stream heals, so a heal-then-restick
 * within the window is deduped against the prior episode's stamp. If web-push
 * re-armed slower than a turn can park, an offline owner whose scratchpad
 * re-sticks (fresh EIK on the next enclave start) could have the new turn park
 * before a fresh nudge is allowed. Re-arming inside the park window guarantees
 * the re-stuck turn gets its own web-push before it dead-letters.
 */
const REWRAP_SOCKET_REEMIT_MS = 5 * 60 * 1000
const REWRAP_WEBPUSH_REEMIT_MS = 10 * 60 * 1000

/**
 * Grace before the first web-push: a turn that just went unservable may still
 * resolve without bugging an offline owner — the owner's own tab heals it over
 * the socket signal, or a still-capable instance heartbeats back into the live
 * set. Only after this window has the stuck state proven durable enough to wake
 * a device. Well inside `ENCLAVE_PENDING_PARK_AFTER_MS`, so the nudge lands with
 * room for the owner to act before the turn parks.
 */
const REWRAP_WEBPUSH_GRACE_MS = 2 * 60 * 1000

/**
 * One claimed invocation's resolution: an assignment to hand the poller, a
 * no-op (row completed in place; claim the next one), or a defer (leave the
 * row claimed and end the poll — time, not another claim, resolves it).
 */
type BuildOutcome = { kind: "assignment"; assignment: EnclaveSessionAssignment } | { kind: "no_op" } | { kind: "defer" }

export interface EnclaveClaimServiceDeps {
  pool: Pool
  /**
   * Reads attachment ciphertext from S3 to ship inline with the assignment.
   * The backend can't decrypt it (the per-file key is sealed in the prompt) —
   * it only relays the opaque bytes so the enclave's egress stays pinned to
   * backend + OpenRouter.
   */
  storage: StorageProvider
  /** Trigger author's preferences feed the shared system-prompt builder (temporal grounding). */
  userPreferencesService: UserPreferencesService
}

/**
 * Serves `POST /internal/enclave-runtimes/claims` (§2.7 pull transport): an
 * enclave instance presents its EIK key id and this service hands it the
 * oldest turn that key can serve. The backend never decrypts — the claim
 * response ships ciphertext + the SSK wraps addressed to the claiming EIK,
 * and the enclave drives the turn over the session callbacks exactly as
 * before. The claim replaces the push dispatcher's instance pick: there is
 * no `instanceUrl`, no pinning decision, no inbound enclave listener — any
 * wrap-capable replica that polls first wins the row (INV-20 via
 * FOR UPDATE SKIP LOCKED in the repository).
 */
export class EnclaveClaimService {
  private readonly pool: Pool
  private readonly storage: StorageProvider
  private readonly userPreferencesService: UserPreferencesService

  constructor(deps: EnclaveClaimServiceDeps) {
    this.pool = deps.pool
    this.storage = deps.storage
    this.userPreferencesService = deps.userPreferencesService
  }

  /**
   * Claim the next servable turn for this EIK and build its assignment.
   * Returns null when there is no work (the common poll outcome).
   *
   * Claims that turn out to need no turn (the push worker's silent early
   * returns) are completed in place and the loop claims again, so a stale
   * backlog can't wedge the queue behind no-ops. A build failure after a
   * claim deliberately leaves the row claimed: the TTL lapses, the attempt
   * budget hands it to a later poll, and `parkExhausted` dead-letters it if
   * that never succeeds.
   */
  async claimTurn(keyId: string): Promise<EnclaveSessionAssignment | null> {
    const parked = await EnclaveInvocationsRepository.parkExhausted(this.pool, {
      maxAttempts: ENCLAVE_CLAIM_MAX_ATTEMPTS,
      pendingMaxAgeMs: ENCLAVE_PENDING_PARK_AFTER_MS,
    })
    for (const row of parked) {
      logger.error(
        { invocationId: row.id, workspaceId: row.workspaceId, streamId: row.streamId, attempts: row.attempts },
        "Enclave invocation parked (dead-lettered)"
      )
    }

    // Same cadence as parkExhausted: nudge owners of turns this fleet can't
    // serve so they re-wrap before the turn ages into the parked set above.
    await this.nudgeUnservableOwners()

    for (let i = 0; i < MAX_NO_OP_CLAIMS_PER_POLL; i++) {
      const claimToken = randomUUID()
      const invocation = await EnclaveInvocationsRepository.claimNext(this.pool, {
        keyId,
        claimToken,
        claimTtlSeconds: ENCLAVE_CLAIM_TTL_SECONDS,
        maxAttempts: ENCLAVE_CLAIM_MAX_ATTEMPTS,
      })
      if (!invocation) return null

      const outcome = await this.buildTurn(invocation, keyId, claimToken)
      if (outcome.kind === "assignment") return outcome.assignment
      if (outcome.kind === "defer") return null
      // No-op claim — the row was completed in place; take the next one.
    }
    return null
  }

  /**
   * Nudge the owners of pending turns no live EIK can serve. A live enclave
   * exists but minted a fresh key (every start mints one) and holds no wrap for
   * the stream, so only the owner's unlocked device can re-wrap (the enclave
   * can't seal to itself, INV-E7). Best-effort — a nudge failure must never
   * break the claim poll, so it logs and moves on (the row still parks visibly
   * on its own timer if no one heals it). Coalesced per (workspace, root
   * stream): the wraps and the heal are the root's, so one nudge serves all its
   * pending turns.
   */
  private async nudgeUnservableOwners(): Promise<void> {
    try {
      const rows = await EnclaveInvocationsRepository.findUnservablePending(this.pool, {
        stalenessMs: ENCLAVE_RUNTIME_STALENESS_MS,
      })
      if (rows.length === 0) return

      const byStream = new Map<string, UnservablePendingInvocation>()
      for (const row of rows) {
        const key = `${row.workspaceId}:${row.rootStreamId}`
        const existing = byStream.get(key)
        // Keep the oldest pending row per stream — its age drives the web-push grace.
        if (!existing || row.createdAt < existing.createdAt) byStream.set(key, row)
      }

      const now = Date.now()
      for (const row of byStream.values()) {
        await this.emitRewrapNudge(row, now)
      }
    } catch (err) {
      logger.error({ err }, "Enclave re-wrap nudge sweep failed")
    }
  }

  /**
   * Emit the two-tier nudge for one unservable stream, each tier deduped on its
   * own clock so a churny fleet can't spam the owner. The dedup claim and the
   * outbox insert share a transaction (INV-7) so the clock never advances
   * without the event that justifies it (and vice versa).
   */
  private async emitRewrapNudge(row: UnservablePendingInvocation, now: number): Promise<void> {
    const { workspaceId, rootStreamId, ownerUserId } = row

    // Socket tier: heal an online unlocked owner in place, immediately.
    await withTransaction(this.pool, async (tx) => {
      const claimed = await EnclaveRewrapNotificationsRepository.claimSocketNudge(tx, {
        workspaceId,
        rootStreamId,
        reemitMs: REWRAP_SOCKET_REEMIT_MS,
      })
      if (!claimed) return
      await OutboxRepository.insert(tx, "enclave:rewrap_needed", {
        workspaceId,
        targetUserId: ownerUserId,
        rootStreamId,
      })
    })

    // Web-push tier: pull an offline owner back, but only once the stuck state
    // has outlived the grace window (an online owner's socket heal, or a
    // capable instance reappearing, resolves it first without waking a device).
    if (now - row.createdAt.getTime() < REWRAP_WEBPUSH_GRACE_MS) return
    await withTransaction(this.pool, async (tx) => {
      const claimed = await EnclaveRewrapNotificationsRepository.claimWebpushNudge(tx, {
        workspaceId,
        rootStreamId,
        reemitMs: REWRAP_WEBPUSH_REEMIT_MS,
      })
      if (!claimed) return
      await OutboxRepository.insert(tx, "enclave:rewrap_nudge", {
        workspaceId,
        targetUserId: ownerUserId,
        rootStreamId,
      })
    })
  }

  /**
   * Validate a claimed invocation and build its assignment, creating the
   * session row in the same step.
   */
  private async buildTurn(invocation: EnclaveInvocation, keyId: string, claimToken: string): Promise<BuildOutcome> {
    const { pool } = this
    const { workspaceId, streamId, messageId: triggerId, rootStreamId: e2eStreamId } = invocation
    const completeAsNoOp = async (reason: string): Promise<BuildOutcome> => {
      logger.info({ invocationId: invocation.id, workspaceId, streamId, reason }, "Enclave claim completed as no-op")
      await EnclaveInvocationsRepository.completeClaimed(pool, invocation.id)
      return { kind: "no_op" }
    }

    // A thread shares its root scratchpad's E2E identity (SSK wraps, owner,
    // tool policy, custom instructions); it carries no wraps of its own. All
    // key material resolves against the root (`rootStreamId`, fixed at
    // enqueue): the SSK wraps are HPKE-bound to the root's id, so the enclave
    // must unwrap under it (assignment.streamId = root). The reply still
    // lands in the trigger's stream — the session row is keyed by `streamId`.
    const triggerStream = await StreamRepository.findById(pool, streamId)
    if (!triggerStream) return completeAsNoOp("trigger stream gone")

    const e2e = await E2eStreamsRepository.getByStreamId(pool, workspaceId, e2eStreamId)
    if (!e2e) return completeAsNoOp("not an E2E stream")

    // Claim-time re-validation of the enqueue-time delivery verdict (the
    // dispatch handler holds the Phase 2.4a gate); the rows also feed the
    // assignment payload, so the fetch is not just a presence check.
    const actors = await E2eStreamActorsRepository.listForStream(pool, workspaceId, streamId)
    if (!actors.some((a) => a.kind === "enclave")) return completeAsNoOp("enclave actor not invited")

    // Idempotency: the turn already has a session in flight or done for this
    // trigger. A FAILED session is allowed to re-assign — a fresh session id
    // is minted below, so the retry is clean.
    const existing = await AgentSessionRepository.findByTriggerMessage(pool, triggerId)
    if (existing?.status === SessionStatuses.COMPLETED) {
      return completeAsNoOp("session already completed")
    }
    if (existing?.status === SessionStatuses.RUNNING) {
      const heartbeatAgeMs = existing.heartbeatAt ? Date.now() - existing.heartbeatAt.getTime() : Infinity
      if (heartbeatAgeMs < STALE_RUNNING_HEARTBEAT_MS) {
        return completeAsNoOp("session already running")
      }
      // A RUNNING session with a stale heartbeat means the previous claim's
      // response never reached a runner (lost handoff). Completing the
      // invocation here would silently drop the turn — instead leave it
      // claimed and end the poll: orphan cleanup fails the session within its
      // next sweep, and the claim TTL + attempt budget re-assign a fresh one.
      logger.warn(
        { invocationId: invocation.id, sessionId: existing.id, heartbeatAgeMs },
        "Enclave claim deferred: trigger's RUNNING session looks runnerless; awaiting orphan cleanup"
      )
      return { kind: "defer" }
    }

    // The enclave serves Ariadne; refuse if that persona isn't e2e-capable.
    if (!isE2eCapablePersona(ARIADNE_AGENT_ID)) return completeAsNoOp("persona not e2e-capable")
    const persona = getBuiltInAgentConfig(ARIADNE_AGENT_ID)
    if (!persona) return completeAsNoOp("persona config missing")

    const trigger = await MessageRepository.findById(pool, triggerId)
    if (!trigger || !trigger.ciphertext) return completeAsNoOp("trigger message gone or not E2E")

    const [wraps, surrounding, rootStream, preferences, authors, allowedToolCategories] = await Promise.all([
      // Root's wraps — the thread shares the root's SSK and has no wraps of its own.
      StreamE2eKeyWrapsRepository.listForStream(pool, workspaceId, e2eStreamId),
      // The deepened verbatim window (C-2): ship up to the shared policy ceiling of
      // prior messages. The enclave fills newest-first under `DEFAULT_CONTEXT_WINDOW_CHARS`
      // and folds the overflow into the rolling summary, so this is the candidate
      // ceiling, not the window depth — the char budget is the real limiter. Sourced
      // from `CONTEXT_WINDOW_CANDIDATE_CEILING` rather than a parallel literal;
      // referenced here (request time) not at module load to avoid the agents-barrel
      // import cycle's TDZ. The enclave schema's own history cap must stay ≥ this.
      MessageRepository.findSurrounding(pool, triggerId, streamId, CONTEXT_WINDOW_CANDIDATE_CEILING, 0),
      triggerStream.rootStreamId
        ? StreamRepository.findById(pool, triggerStream.rootStreamId)
        : Promise.resolve(triggerStream),
      this.userPreferencesService.getPreferences(workspaceId, trigger.authorId),
      UserRepository.findByIds(pool, workspaceId, [trigger.authorId]),
      // Tool-privacy policy, keyed by the root like the rest of the E2E identity.
      StreamPoliciesRepository.getToolPolicy(pool, workspaceId, e2eStreamId),
    ])
    if (!rootStream) return completeAsNoOp("root stream gone")
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
    const systemPrompt = await buildEnclaveSystemPrompt({
      pool,
      stream: rootStream,
      preferences,
      deviceTimezone: authors[0]?.timezone ?? undefined,
      persona,
    })

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
    const attachmentCiphertexts = await this.loadAttachmentCiphertexts(attachmentCiphertextIds)

    // Prior turns' sealed digests (C-1) + the prior sealed rolling summary (C-2):
    // both are opaque to the backend (only the enclave's SSK wraps open them,
    // INV-E7) and neither depends on the other, so fetch them together. Digests:
    // the recent turn_digest step ciphertext from this stream's completed
    // sessions. Summary: the single (stream, persona) row the enclave extends.
    const [digestRows, summaryRow] = await Promise.all([
      AgentSessionRepository.findRecentDigestStepsByStream(pool, {
        streamId,
        personaId: ARIADNE_AGENT_ID,
        limit: TURN_DIGEST_INJECT_COUNT,
      }),
      ConversationSummaryRepository.findByStreamAndPersona(pool, streamId, ARIADNE_AGENT_ID),
    ])
    const recentDigests = digestRows
      .filter((row) => row.step.contentCiphertext && row.step.contentEnvelope)
      .reverse() // newest-first from the repo → oldest-first for the prompt
      .map((row) => ({
        ciphertext: row.step.contentCiphertext!,
        envelope: row.step.contentEnvelope as EnclaveStreamEnvelope,
        completedAt: (row.step.completedAt ?? row.sessionCreatedAt).toISOString(),
      }))

    // Ship the prior summary's sealed bytes (the enclave folds the overflow into
    // them and re-seals): only its generation's SSK wrap, already in `wraps`,
    // opens it; a row without sealed bytes (the plaintext-companion shape, never
    // produced for an E2E stream) ships nothing. `summaryCursor` is the highest
    // sequence already folded, so the enclave never re-summarizes below it.
    const priorSummary = summaryRow?.sealed
      ? { ciphertext: summaryRow.sealed.ciphertext, envelope: summaryRow.sealed.envelope as EnclaveStreamEnvelope }
      : undefined
    // The cursor only means something paired with a summary to extend; without a
    // sealed prior summary the enclave folds from the start of the shipped window.
    const summaryCursor = priorSummary ? summaryRow!.lastSummarizedSequence.toString() : undefined

    const sid = newSessionId()
    const assignment = buildEnclaveSessionAssignment({
      // Callback binding (Phase 2.4b, E2EE-21): the claim token doubles as the
      // callback token — it travels only inside this claim response to the
      // claiming instance, so echoing it proves the caller is the runner that
      // won this turn. Only its sha256 digest is persisted, so a DB read can
      // never impersonate the runner.
      callbackToken: claimToken,
      e2e,
      actors,
      eikKeyId: keyId,
      wraps,
      trigger,
      triggerAuthorName,
      priorMessages: surrounding.filter((m) => m.id !== triggerId),
      persona: {
        systemPrompt: systemPrompt.stable,
        systemVolatilePrompt: systemPrompt.volatile,
        model: persona.model,
        temperature: persona.temperature,
        maxTokens: persona.maxTokens,
      },
      replySenderId: ARIADNE_AGENT_ID,
      sessionId: sid,
      allowedToolCategories,
      attachmentCiphertexts,
      recentDigests,
      // Deepened verbatim window (C-2): the enclave fills history newest-first up
      // to this char budget and folds the overflow into the rolling summary.
      maxChars: DEFAULT_CONTEXT_WINDOW_CHARS,
      priorSummary,
      summaryCursor,
    })
    if (!assignment) {
      // The claim predicate proved wrap coverage moments ago, so this is the
      // rare revoke/rotation race. Leave the row claimed and fail the poll
      // loudly (INV-11): the TTL hands the row back, and an EIK that still
      // qualifies wins it on a later poll.
      throw new Error(
        `Claimed enclave invocation ${invocation.id} but key ${keyId} no longer covers stream ${e2eStreamId}'s generations`
      )
    }

    // Create the session row owned by the claiming EIK — skip if another
    // session is already RUNNING for this stream (one-running-per-stream
    // guard, INV-20; the post-completion catch-up re-triggers the suppressed
    // message) — and surface the turn in the stream view in the same
    // transaction (INV-7), so a session row never exists without its started
    // event. The invocation's `session_id` stamp rides the same transaction
    // so the session callbacks can always address the claim. Plaintext-free:
    // the payload carries only ids + the persona name. last_seen_sequence is
    // an inert placeholder here; mid-turn reconsideration is a later slice.
    const session = await withTransaction(pool, async (tx) => {
      const created = await AgentSessionRepository.insertRunningOrSkip(tx, {
        id: sid,
        streamId,
        personaId: ARIADNE_AGENT_ID,
        triggerMessageId: triggerId,
        serverId: keyId,
        callbackTokenHash: hashCallbackToken(claimToken),
        replyKeyGeneration: assignment.reply.keyGeneration,
        initialSequence: 0n,
      })
      if (!created) return null

      // Reserve E2E scratchpad naming under this exact session in the same
      // transaction as RUNNING. A lost/rolled-back session can therefore never
      // strand an ownerless naming claim. Threads deliberately receive no slot.
      if (triggerStream.type === StreamTypes.SCRATCHPAD && triggerStream.id === e2eStreamId) {
        const locked = await StreamRepository.findByIdForUpdateBlocking(tx, triggerStream.id)
        const source = locked?.displayNameSource ?? (locked?.displayName ? TitleSources.LEGACY : null)
        if (locked && !locked.archivedAt && (source === null || source === TitleSources.GENERATED)) {
          const stats = await MessageRepository.getNamingStats(tx, locked.id)
          // The session has not written its reply yet, but naming runs only after
          // at least one reply is durably streamed. Reserve against that first
          // reply so checkpoint 6 is not missed at a pre-turn count of 5; extra
          // replies/interjections are added to the enclave's observed count.
          const namingMessageCount = stats.count + 1
          const state = await DynamicNamingStateRepository.ensure(tx, {
            workspaceId,
            targetKind: "stream",
            targetId: locked.id,
            initialLastEvaluatedMessageCount: source === TitleSources.GENERATED ? 1 : 0,
          })
          const eligibility = getNamingEligibility(
            {
              lastEvaluatedMessageCount: state.lastEvaluatedMessageCount,
              consecutiveKeeps: state.consecutiveKeeps,
              completed: state.completedAt !== null,
              structureVersion: state.structureVersion,
              lastEvaluatedStructureVersion: state.lastEvaluatedStructureVersion,
            },
            namingMessageCount
          )
          if (
            eligibility.eligible &&
            (!state.claimToken || !state.claimExpiresAt || state.claimExpiresAt <= new Date())
          ) {
            const claim = await DynamicNamingStateRepository.claim(tx, {
              workspaceId,
              targetKind: "stream",
              targetId: locked.id,
              ownerId: sid,
              checkpoint: eligibility.checkpoint,
              messageCount: namingMessageCount,
              structureVersion: state.structureVersion,
              titleRevision: locked.displayNameRevision ?? 0,
              expectedVersion: state.version,
              leaseSeconds: DYNAMIC_NAMING_CLAIM_LEASE_SECONDS,
            })
            if (claim) {
              const currentSealedTitle = await E2eStreamsRepository.getSealedName(tx, workspaceId, locked.id)
              assignment.naming = {
                stateRevision: claim.version,
                titleRevision: locked.displayNameRevision ?? 0,
                checkpoint: eligibility.checkpoint,
                messageCount: namingMessageCount,
                forced: eligibility.forced,
                reason: claim.claimReason!,
                ...(currentSealedTitle
                  ? {
                      currentSealedTitle: {
                        ciphertext: currentSealedTitle.ciphertext,
                        envelope: currentSealedTitle.envelope as EnclaveStreamEnvelope,
                      },
                    }
                  : {}),
              }
            }
          }
        }
      }

      await EnclaveInvocationsRepository.attachSession(tx, { id: invocation.id, sessionId: sid })
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
      await OutboxRepository.insert(tx, "agent_session:started", {
        workspaceId,
        streamId,
        rootStreamId: triggerStream.rootStreamId ?? triggerStream.id,
        event: startedEvent,
      })
      return created
    })
    if (!session) return completeAsNoOp("another session is running for this stream")

    logger.info({ workspaceId, streamId, sessionId: sid, keyId }, "Enclave turn claimed")
    return { kind: "assignment", assignment }
  }

  /**
   * Read the opaque ciphertext for every E2E attachment bound to the given
   * messages (trigger first, then newest history) and base64-encode it for
   * inline shipping. The backend never decrypts: the per-file keys are sealed
   * inside the messages and recovered only in the enclave. Best-effort — a
   * single unreadable object is dropped (the enclave then notes the file as
   * unavailable) rather than failing the whole turn.
   */
  private async loadAttachmentCiphertexts(
    /** Message ids in shipping priority order (trigger first, then newest history). */
    messageIds: string[]
  ): Promise<{ attachmentId: string; ciphertext: string }[]> {
    const byMessage = await AttachmentRepository.findByMessageIds(this.pool, messageIds)
    const e2eRows = messageIds.flatMap((id) => (byMessage.get(id) ?? []).filter((a) => a.e2eOnly))
    if (e2eRows.length === 0) return []

    const results = await Promise.all(
      e2eRows.map(async (a) => {
        if (a.sizeBytes > MAX_INLINE_ATTACHMENT_BYTES) {
          logger.warn(
            { attachmentId: a.id, sizeBytes: a.sizeBytes, cap: MAX_INLINE_ATTACHMENT_BYTES },
            "enclave claim: attachment exceeds inline cap; skipping"
          )
          return null
        }
        try {
          const bytes = await this.storage.getObject(a.storagePath)
          return { attachmentId: a.id, ciphertext: bytes.toString("base64") }
        } catch (err) {
          logger.warn({ err, attachmentId: a.id }, "enclave claim: failed to read attachment ciphertext; skipping")
          return null
        }
      })
    )
    const loaded = results.filter((r): r is { attachmentId: string; ciphertext: string } => r !== null)

    // Total cap: keep the assignment inside what the enclave schema accepts.
    // `loaded` preserves priority order (trigger first, then newest history),
    // so when the budget runs out it's the oldest files that drop — with a
    // warn, never silently. A dropped file surfaces to the model as an
    // "unavailable" note.
    const shipped: { attachmentId: string; ciphertext: string }[] = []
    let totalChars = 0
    for (const item of loaded) {
      if (shipped.length >= MAX_INLINE_ATTACHMENT_COUNT) {
        logger.warn(
          { attachmentId: item.attachmentId, cap: MAX_INLINE_ATTACHMENT_COUNT },
          "enclave claim: inline attachment count cap reached; skipping remaining file"
        )
        continue
      }
      if (totalChars + item.ciphertext.length > MAX_INLINE_TOTAL_BASE64_CHARS) {
        logger.warn(
          { attachmentId: item.attachmentId, totalChars, cap: MAX_INLINE_TOTAL_BASE64_CHARS },
          "enclave claim: inline attachment budget exhausted; skipping remaining file"
        )
        continue
      }
      shipped.push(item)
      totalChars += item.ciphertext.length
    }
    return shipped
  }
}

/**
 * Enqueue helper shared by the dispatch outbox handler and the
 * post-completion catch-up: resolve the root (E2E identity) for a trigger and
 * insert its work item. `reopen` selects the catch-up semantics (resurrect a
 * terminal row for a re-triggered message) vs the dispatch default
 * (idempotent insert, existing row wins).
 */
export async function enqueueEnclaveInvocation(
  db: Pool,
  params: {
    workspaceId: string
    streamId: string
    rootStreamId: string
    messageId: string
    triggeredBy: string
    reopen?: boolean
  }
): Promise<void> {
  const row = {
    id: enclaveInvocationId(),
    workspaceId: params.workspaceId,
    streamId: params.streamId,
    rootStreamId: params.rootStreamId,
    messageId: params.messageId,
    triggeredBy: params.triggeredBy,
  }
  // Both insert paths report whether they produced fresh claimable work: an
  // idempotent redelivery (existing pending row) or a reopen that found a live
  // row already on its way both no-op, and need no nudge — one already fired.
  const enqueued = params.reopen
    ? await EnclaveInvocationsRepository.insertOrReopen(db, row)
    : await EnclaveInvocationsRepository.insertPending(db, row)
  // Ring the doorbell so a parked claim long-poll reacts now instead of waiting
  // out its interval (§2.7 wake-up nudge). Best-effort: the row is the durable
  // work item, and a missed nudge degrades only to the long-poll's timeout.
  if (enqueued) await notifyEnclaveInvocationAvailable(db)
}
