import type { Querier } from "../../db"
import { sql } from "../../db"

/**
 * Claimable enclave turn work items (§2.7 pull transport). One row per
 * trigger (a user message in an E2E scratchpad with companion mode on),
 * following the same claim lifecycle the bot path runs in production:
 * pending → claimed (TTL + bounded attempts) → completed/failed/parked.
 *
 * The claim predicate is what makes pull work without pinning: an instance
 * presents its EIK key id and can only win rows whose stream has SSK wraps
 * addressed to that key for BOTH the reply's generation (the stream's
 * current) and the prompt's (the trigger message's envelope) — the same
 * both-sides rule the push dispatcher used to pick a target. A row no live
 * EIK can serve just stays pending; when the owner's unlocked client revives
 * the wrap (`POST …/e2e/actor-key-wraps`), the very next poll claims it.
 *
 * The claim poll is deliberately cross-workspace: the enclave is global
 * infrastructure (like the `enclave_runtimes` registry it authenticates as)
 * serving every workspace from one loop. Rows stay workspace-scoped (INV-8)
 * and every per-row mutation filters on the claim's own keys.
 */

export const EnclaveInvocationStatuses = {
  PENDING: "pending",
  CLAIMED: "claimed",
  COMPLETED: "completed",
  FAILED: "failed",
  PARKED: "parked",
} as const

export type EnclaveInvocationStatus = (typeof EnclaveInvocationStatuses)[keyof typeof EnclaveInvocationStatuses]

const KNOWN_STATUSES = new Set<string>(Object.values(EnclaveInvocationStatuses))

/**
 * How long a claim holds before the row comes back up for grabs. The session
 * heartbeat (every ~15s while a turn runs) renews it, so only a runner that
 * took the work and went silent lets it lapse.
 */
export const ENCLAVE_CLAIM_TTL_SECONDS = 60

/**
 * How many times a single invocation may be claimed before it is parked
 * (dead-lettered) — the same bounded-attempts discipline the bot claim loop
 * has (`BOT_CLAIM_MAX_ATTEMPTS`). Wrap-incapability never burns an attempt
 * (the claim predicate filters those rows out instead).
 */
export const ENCLAVE_CLAIM_MAX_ATTEMPTS = 5

/**
 * How long a row may sit pending before it is parked. Pending means "no live
 * EIK can currently serve this stream" (no enclave running, or every live
 * EIK lacks this stream's wrap after a restart minted a fresh key). Both
 * healers — an enclave (re)deploy and the owner's client auto-reviving the
 * wrap — land well inside this window; replying to an hours-old message
 * would be worse than failing visibly in the parked set.
 */
export const ENCLAVE_PENDING_PARK_AFTER_MS = 15 * 60 * 1000

export interface EnclaveInvocation {
  id: string
  workspaceId: string
  streamId: string
  rootStreamId: string
  messageId: string
  triggeredBy: string
  status: EnclaveInvocationStatus
  claimedByKeyId: string | null
  claimToken: string | null
  claimExpiresAt: Date | null
  sessionId: string | null
  attempts: number
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

interface EnclaveInvocationRow {
  id: string
  workspace_id: string
  stream_id: string
  root_stream_id: string
  message_id: string
  triggered_by: string
  status: string
  claimed_by_key_id: string | null
  claim_token: string | null
  claim_expires_at: Date | null
  session_id: string | null
  attempts: number
  error_message: string | null
  created_at: Date
  updated_at: Date
  completed_at: Date | null
}

function mapRow(row: EnclaveInvocationRow): EnclaveInvocation {
  if (!KNOWN_STATUSES.has(row.status)) throw new Error(`Unknown enclave invocation status: ${row.status}`)
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    rootStreamId: row.root_stream_id,
    messageId: row.message_id,
    triggeredBy: row.triggered_by,
    status: row.status as EnclaveInvocationStatus,
    claimedByKeyId: row.claimed_by_key_id,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    sessionId: row.session_id,
    attempts: row.attempts,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export interface InsertEnclaveInvocationParams {
  id: string
  workspaceId: string
  streamId: string
  rootStreamId: string
  messageId: string
  triggeredBy: string
}

export const EnclaveInvocationsRepository = {
  /**
   * Enqueue a turn for its trigger message. Idempotent on outbox redelivery:
   * one invocation per (workspace, message), and an existing row — whatever
   * its status — wins (INV-20; the dispatch handler may re-walk events after
   * a crash, and a redelivered trigger must not re-run a finished turn).
   */
  async insertPending(db: Querier, params: InsertEnclaveInvocationParams): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO enclave_invocations (id, workspace_id, stream_id, root_stream_id, message_id, triggered_by)
      VALUES (${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.rootStreamId}, ${params.messageId}, ${params.triggeredBy})
      ON CONFLICT (workspace_id, message_id) DO NOTHING
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Enqueue a turn for a message that may already carry a terminal
   * invocation — the post-completion interjection catch-up: a message
   * suppressed by the one-running-per-stream guard had its invocation
   * completed without a session, and finishing the running turn re-triggers
   * it. Reopens a terminal row back to pending (fresh attempt budget) or
   * inserts; a live pending/claimed row is left untouched (its turn is
   * already on the way). Session-level idempotency (`findByTriggerMessage`
   * at claim time) backstops any reopen this lets through. Returns whether a
   * row was inserted or reopened — false means an untouched live row, i.e. no
   * fresh claimable work (so callers can skip a needless wake-up nudge).
   */
  async insertOrReopen(db: Querier, params: InsertEnclaveInvocationParams): Promise<boolean> {
    const result = await db.query(sql`
      INSERT INTO enclave_invocations (id, workspace_id, stream_id, root_stream_id, message_id, triggered_by)
      VALUES (${params.id}, ${params.workspaceId}, ${params.streamId}, ${params.rootStreamId}, ${params.messageId}, ${params.triggeredBy})
      ON CONFLICT (workspace_id, message_id) DO UPDATE
        SET status = 'pending',
            claimed_by_key_id = NULL,
            claim_token = NULL,
            claim_expires_at = NULL,
            session_id = NULL,
            attempts = 0,
            error_message = NULL,
            completed_at = NULL,
            updated_at = NOW()
        WHERE enclave_invocations.status IN ('completed', 'failed', 'parked')
    `)
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Claim the oldest invocation this EIK can serve: pending (or claimed with
   * an expired TTL), attempt budget left, and the stream's wraps cover both
   * the reply's generation (the stream's live `current_key_generation` — a
   * rotation between enqueue and claim must re-evaluate, so this is never
   * snapshotted onto the row) and the prompt's (the trigger envelope's).
   * Race-safe across concurrent pollers via FOR UPDATE SKIP LOCKED (INV-20).
   */
  async claimNext(
    db: Querier,
    params: { keyId: string; claimToken: string; claimTtlSeconds: number; maxAttempts: number }
  ): Promise<EnclaveInvocation | null> {
    const result = await db.query<EnclaveInvocationRow>(sql`
      WITH candidate AS (
        SELECT i.id FROM enclave_invocations i
        WHERE (i.status = 'pending' OR (i.status = 'claimed' AND i.claim_expires_at < NOW()))
          AND i.attempts < ${params.maxAttempts}
          AND EXISTS (
            SELECT 1
            FROM stream_e2e_key_wraps w
            JOIN e2e_streams e
              ON e.workspace_id = i.workspace_id AND e.stream_id = i.root_stream_id
            WHERE w.workspace_id = i.workspace_id
              AND w.stream_id = i.root_stream_id
              AND w.recipient_kind = 'enclave'
              AND w.recipient_key_id = ${params.keyId}
              AND w.key_generation = e.current_key_generation
          )
          AND EXISTS (
            SELECT 1
            FROM stream_e2e_key_wraps w
            JOIN messages m ON m.id = i.message_id
            WHERE w.workspace_id = i.workspace_id
              AND w.stream_id = i.root_stream_id
              AND w.recipient_kind = 'enclave'
              AND w.recipient_key_id = ${params.keyId}
              AND w.key_generation = (m.envelope ->> 'keyGeneration')::int
          )
        ORDER BY i.created_at ASC, i.id ASC
        FOR UPDATE OF i SKIP LOCKED
        LIMIT 1
      )
      UPDATE enclave_invocations i
      SET status = 'claimed',
          claimed_by_key_id = ${params.keyId},
          claim_token = ${params.claimToken},
          claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval,
          attempts = attempts + 1,
          updated_at = NOW()
      FROM candidate
      WHERE i.id = candidate.id
      RETURNING i.*
    `)
    return result.rows[0] ? mapRow(result.rows[0]) : null
  },

  /**
   * Stamp the agent session a claim spawned, so the session callbacks can
   * address the claim by session id (the enclave never sees invocation ids).
   * Written in the same transaction as the session row (INV-7).
   */
  async attachSession(db: Querier, params: { id: string; sessionId: string }): Promise<void> {
    await db.query(sql`
      UPDATE enclave_invocations
      SET session_id = ${params.sessionId}, updated_at = NOW()
      WHERE id = ${params.id} AND status = 'claimed'
    `)
  },

  /**
   * Terminal no-op for a claim the service decided needs no turn (trigger
   * gone, actor uninvited, a session already RUNNING/COMPLETED for the
   * trigger, …) — the claim-time equivalent of the push worker's silent
   * early returns. Guarded on `claimed` so a raced terminal flip no-ops.
   */
  async completeClaimed(db: Querier, id: string): Promise<void> {
    await db.query(sql`
      UPDATE enclave_invocations
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND status = 'claimed'
    `)
  },

  /** Flip the claim with the session when its turn completes. */
  async completeBySession(db: Querier, sessionId: string): Promise<void> {
    await db.query(sql`
      UPDATE enclave_invocations
      SET status = 'completed', completed_at = NOW(), updated_at = NOW()
      WHERE session_id = ${sessionId} AND status = 'claimed'
    `)
  },

  /**
   * Flip the claim terminal-failed with the session. The enclave's loop threw
   * and `/fail` terminated the session — same no-retry semantics the push
   * transport had for a loop error. (An orphan-reclaimed session, by
   * contrast, never calls this: its claim lapses by TTL and the attempt
   * budget gives the turn another shot.)
   */
  async failBySession(db: Querier, params: { sessionId: string; errorMessage: string }): Promise<void> {
    await db.query(sql`
      UPDATE enclave_invocations
      SET status = 'failed', error_message = ${params.errorMessage}, updated_at = NOW()
      WHERE session_id = ${params.sessionId} AND status = 'claimed'
    `)
  },

  /**
   * Push the claim's TTL forward while its session is alive — called from the
   * session heartbeat, so a healthy long turn can never lapse back into the
   * claimable set. Only a live claim renews (an expired one may already be
   * re-claimed elsewhere).
   */
  async renewBySession(db: Querier, params: { sessionId: string; claimTtlSeconds: number }): Promise<void> {
    await db.query(sql`
      UPDATE enclave_invocations
      SET claim_expires_at = NOW() + (${params.claimTtlSeconds} || ' seconds')::interval, updated_at = NOW()
      WHERE session_id = ${params.sessionId} AND status = 'claimed' AND claim_expires_at > NOW()
    `)
  },

  /**
   * Dead-letter the rows the claim loop must stop serving, run at poll
   * cadence like the bot path's `parkExhausted`:
   *  - claimed rows whose TTL lapsed with the attempt budget spent (a runner
   *    kept taking the work and going silent), and
   *  - pending rows past the age window (nothing could ever claim them — no
   *    live wrap-capable EIK showed up in time).
   * Terminal `parked` is operator-visible, never a silent no-reply; existing
   * error context is preserved. Idempotent under concurrent pollers: the
   * status predicates make the second UPDATE a no-op (INV-20).
   */
  async parkExhausted(
    db: Querier,
    params: { maxAttempts: number; pendingMaxAgeMs: number }
  ): Promise<EnclaveInvocation[]> {
    const result = await db.query<EnclaveInvocationRow>(sql`
      UPDATE enclave_invocations
      SET status = 'parked',
          error_message = COALESCE(error_message, CASE
            WHEN status = 'claimed' THEN 'Claim attempts exhausted without completion'
            ELSE 'No live enclave key could serve this stream in time'
          END),
          updated_at = NOW()
      WHERE (status = 'claimed' AND claim_expires_at < NOW() AND attempts >= ${params.maxAttempts})
         OR (status = 'pending' AND created_at < NOW() - (${params.pendingMaxAgeMs} || ' milliseconds')::interval)
      RETURNING *
    `)
    return result.rows.map(mapRow)
  },
}
