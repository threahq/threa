import type {
  AgentSessionStatus,
  AgentStepType,
  AgentToolEffect,
  ToolVerificationStatus,
  TraceSource,
} from "@threahq/types"
import { AgentSessionStatuses, AgentStepTypes, BotInvocationStatuses } from "@threahq/types"
import { isUniqueViolation } from "@threahq/backend-common"
import type { Querier } from "../../db"
import { sql } from "../../db"

// Re-export for backwards compatibility
export const SessionStatuses = AgentSessionStatuses
export type SessionStatus = AgentSessionStatus
export const StepTypes = AgentStepTypes
export type StepType = AgentStepType

// Internal row types (snake_case)
interface SessionRow {
  id: string
  stream_id: string
  persona_id: string
  trigger_message_id: string
  trigger_message_revision: number | null
  supersedes_session_id: string | null
  status: string
  current_step: number
  current_step_type: string | null
  server_id: string | null
  callback_token_hash: string | null
  reply_key_generation: number | null
  heartbeat_at: Date | null
  abort_requested_at: Date | null
  response_message_id: string | null
  error: string | null
  last_seen_sequence: string | null
  sent_message_ids: string[] | null
  context_message_ids: string[] | null
  episode_summary: string | null
  response_validation_failed: boolean
  reflective_captured_at: Date | null
  created_at: Date
  completed_at: Date | null
}

interface StepRow {
  id: string
  session_id: string
  step_number: number
  step_type: string
  content: unknown
  content_ciphertext: string | null
  content_envelope: unknown | null
  sources: TraceSource[] | null
  message_id: string | null
  tokens_used: number | null
  verification_status: string | null
  verification_reason: string | null
  effects: AgentToolEffect[] | null
  started_at: Date
  completed_at: Date | null
}

interface SessionProgressSnapshotRow {
  id: string
  current_step_type: string | null
  step_count: string
  message_count: number
}

// Domain types (camelCase)
export interface AgentSession {
  id: string
  streamId: string
  personaId: string
  triggerMessageId: string
  triggerMessageRevision: number | null
  supersedesSessionId: string | null
  status: SessionStatus
  currentStep: number
  currentStepType: StepType | null
  serverId: string | null
  /**
   * Phase 2.4b (E2EE-21): sha256 of the dispatch-minted secret delivered only
   * inside the session assignment to the pinned runner; callbacks must echo
   * the cleartext, verified against this digest. Only the hash is at rest, so
   * a DB read can never impersonate the runner. NULL for non-enclave sessions
   * and sessions dispatched before the binding shipped.
   */
  callbackTokenHash: string | null
  /** SSK generation the assignment told the enclave to seal under; callbacks sealing another generation are rejected. */
  replyKeyGeneration: number | null
  heartbeatAt: Date | null
  /**
   * A user's Stop for an enclave-owned session (§2.7): the enclave has no
   * inbound routes, so the request is recorded here and delivered on the
   * session-heartbeat response, where the enclave trips its turn's
   * AbortController. NULL = no abort requested. In-process sessions never set
   * this — their abort goes through the in-memory SessionAbortRegistry.
   */
  abortRequestedAt: Date | null
  responseMessageId: string | null
  error: string | null
  lastSeenSequence: bigint | null
  sentMessageIds: string[]
  contextMessageIds: string[]
  /**
   * Post-completion condensation of what the persona did and concluded this
   * session (~2-3 sentences), written by the episode-summary job (roadmap 3.1).
   * NULL until that job runs, and for sessions that produced no output. Read
   * back into later turns as the "Previous sessions" prompt section.
   */
  episodeSummary: string | null
  /**
   * True when this session was a supersede rerun whose drafts repeatedly failed
   * the response validator, so it kept the previous reply instead of revising.
   * The next rerun superseding this session escalates to the persona's
   * `escalationModel` (roadmap 2.3).
   */
  responseValidationFailed: boolean
  /**
   * When the reflective session-capture job ran for this session (roadmap 6.3),
   * or NULL if it hasn't. CAS-set once so a re-delivered job is a no-op — see
   * `setReflectiveCaptured`. Set even when the session left behind no memo, so a
   * not-worthy session isn't re-classified on every redelivery.
   */
  reflectiveCapturedAt: Date | null
  createdAt: Date
  completedAt: Date | null
}

export interface AgentSessionStep {
  id: string
  sessionId: string
  stepNumber: number
  stepType: StepType
  content: unknown
  /** E2E (enclave) steps: SSK-sealed content + envelope; `content` is null for these (INV-E7). */
  contentCiphertext: string | null
  contentEnvelope: unknown | null
  sources: TraceSource[] | null
  messageId: string | null
  tokensUsed: number | null
  /** Guardian state for a guarded (tier 2+) tool call; absent on every other step. */
  verification?: { status: ToolVerificationStatus; reason?: string }
  /** What the call wrote (`MUTATING_TOOLS`); absent on read-only steps and on sealed streams. */
  effects?: AgentToolEffect[]
  startedAt: Date
  completedAt: Date | null
}

export interface AgentSessionCursor {
  createdAt: Date
  id: string
}

export interface AgentSessionProgressSnapshot {
  sessionId: string
  currentStepType: StepType | null
  stepCount: number
  messageCount: number
}

/** One `turn_digest` step joined with its session's timing (C-1 injection input). */
export interface RecentDigestStep {
  step: AgentSessionStep
  sessionCreatedAt: Date
  sessionCompletedAt: Date | null
}

/** One completed session's episode summary with its timing (roadmap 3.1 injection input). */
export interface RecentEpisodeSummary {
  summary: string
  sessionCreatedAt: Date
  sessionCompletedAt: Date | null
}

// Insert params
export interface InsertSessionParams {
  id: string
  streamId: string
  personaId: string
  triggerMessageId: string
  triggerMessageRevision?: number | null
  supersedesSessionId?: string | null
  status?: SessionStatus
  serverId?: string
}

// Upsert params
export interface UpsertStepParams {
  id: string
  sessionId: string
  stepNumber: number
  stepType: StepType
  content?: unknown
  sources?: TraceSource[]
  messageId?: string
  tokensUsed?: number
  startedAt: Date
  completedAt?: Date
}

// Append params (step_number is computed atomically — never passed by caller)
export interface AppendStepParams {
  id: string
  sessionId: string
  stepType: StepType
  content?: unknown
  /** E2E (enclave) steps: SSK-sealed content + envelope persisted in lieu of plaintext `content`. */
  contentCiphertext?: string
  contentEnvelope?: unknown
  sources?: TraceSource[]
  messageId?: string
  tokensUsed?: number
  startedAt: Date
  completedAt?: Date
  /**
   * Client-supplied idempotency key. When set, a re-send under the same key
   * dedups to the row the first append created instead of inserting a duplicate
   * step (partial-unique `agent_session_steps_client_step_id_key`). Callers that
   * omit it keep the prior behavior unchanged.
   */
  clientStepId?: string
}

// Mappers
function mapRowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    streamId: row.stream_id,
    personaId: row.persona_id,
    triggerMessageId: row.trigger_message_id,
    triggerMessageRevision: row.trigger_message_revision,
    supersedesSessionId: row.supersedes_session_id,
    status: row.status as SessionStatus,
    currentStep: row.current_step,
    currentStepType: row.current_step_type as StepType | null,
    serverId: row.server_id,
    callbackTokenHash: row.callback_token_hash,
    replyKeyGeneration: row.reply_key_generation,
    heartbeatAt: row.heartbeat_at,
    abortRequestedAt: row.abort_requested_at,
    responseMessageId: row.response_message_id,
    error: row.error,
    lastSeenSequence: row.last_seen_sequence ? BigInt(row.last_seen_sequence) : null,
    sentMessageIds: row.sent_message_ids ?? [],
    contextMessageIds: row.context_message_ids ?? [],
    episodeSummary: row.episode_summary,
    responseValidationFailed: row.response_validation_failed,
    reflectiveCapturedAt: row.reflective_captured_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  }
}

function mapRowToStep(row: StepRow): AgentSessionStep {
  return {
    id: row.id,
    sessionId: row.session_id,
    stepNumber: row.step_number,
    stepType: row.step_type as StepType,
    content: row.content,
    contentCiphertext: row.content_ciphertext,
    contentEnvelope: row.content_envelope,
    sources: row.sources,
    messageId: row.message_id,
    tokensUsed: row.tokens_used,
    verification: row.verification_status
      ? {
          status: row.verification_status as ToolVerificationStatus,
          ...(row.verification_reason ? { reason: row.verification_reason } : {}),
        }
      : undefined,
    effects: row.effects ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

const SESSION_SELECT_FIELDS = `
  id, stream_id, persona_id, trigger_message_id, trigger_message_revision, supersedes_session_id,
  status, current_step, current_step_type, server_id, callback_token_hash, reply_key_generation, heartbeat_at,
  abort_requested_at, response_message_id, error, last_seen_sequence,
  sent_message_ids, context_message_ids, episode_summary, response_validation_failed,
  reflective_captured_at, created_at, completed_at
`

const STEP_SELECT_FIELDS = `
  id, session_id, step_number, step_type,
  content, content_ciphertext, content_envelope,
  sources, message_id, tokens_used, verification_status, verification_reason, effects,
  started_at, completed_at
`

export const AgentSessionRepository = {
  // ----- Sessions -----

  async insert(db: Querier, params: InsertSessionParams): Promise<AgentSession> {
    const status = params.status ?? SessionStatuses.PENDING
    const result = await db.query<SessionRow>(
      sql`
        INSERT INTO agent_sessions (
          id, stream_id, persona_id, trigger_message_id,
          trigger_message_revision, supersedes_session_id,
          status, server_id, heartbeat_at
        ) VALUES (
          ${params.id},
          ${params.streamId},
          ${params.personaId},
          ${params.triggerMessageId},
          ${params.triggerMessageRevision ?? null},
          ${params.supersedesSessionId ?? null},
          ${status},
          ${params.serverId ?? null},
          ${params.serverId ? new Date() : null}
        )
        RETURNING ${sql.raw(SESSION_SELECT_FIELDS)}
      `
    )
    return mapRowToSession(result.rows[0])
  },

  /**
   * Atomically insert a RUNNING session, failing if one already exists for the stream
   * or if this invocation already created its session on an earlier claim attempt.
   * Uses ON CONFLICT DO NOTHING to cover both the partial running-session index
   * and the primary key without surfacing a duplicate-key error.
   *
   * @returns The created session, or null if a conflicting session already exists
   */
  async insertRunningOrSkip(
    db: Querier,
    // The callback-binding fields live only on this insert path: they exist
    // solely for enclave-dispatched sessions, which are always created here.
    // Keeping them off the shared InsertSessionParams means `insert()` callers
    // can't pass values that would be silently dropped.
    params: Omit<InsertSessionParams, "status"> & {
      initialSequence: bigint
      callbackTokenHash?: string
      replyKeyGeneration?: number
    }
  ): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        INSERT INTO agent_sessions (
          id, stream_id, persona_id, trigger_message_id,
          trigger_message_revision, supersedes_session_id,
          status, server_id, callback_token_hash, reply_key_generation, heartbeat_at, last_seen_sequence
        ) VALUES (
          ${params.id},
          ${params.streamId},
          ${params.personaId},
          ${params.triggerMessageId},
          ${params.triggerMessageRevision ?? null},
          ${params.supersedesSessionId ?? null},
          ${SessionStatuses.RUNNING},
          ${params.serverId ?? null},
          ${params.callbackTokenHash ?? null},
          ${params.replyKeyGeneration ?? null},
          ${params.serverId ? new Date() : null},
          ${params.initialSequence.toString()}
        )
        ON CONFLICT DO NOTHING
        RETURNING ${sql.raw(SESSION_SELECT_FIELDS)}
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  async findById(db: Querier, id: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE id = ${id}
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  /** Pin after the invocation lock so completion, supersede, and delete share one lock order (INV-20). */
  async findByIdForUpdate(db: Querier, id: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE id = ${id}
        FOR UPDATE
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  async findByTriggerMessage(
    db: Querier,
    triggerMessageId: string,
    cursor?: AgentSessionCursor
  ): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE trigger_message_id = ${triggerMessageId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}, ${cursor?.id ?? null}))
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  async listByTriggerMessage(db: Querier, triggerMessageId: string): Promise<AgentSession[]> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE trigger_message_id = ${triggerMessageId}
        ORDER BY created_at DESC
      `
    )
    return result.rows.map(mapRowToSession)
  },

  async findProgressSnapshotsByIds(
    db: Querier,
    sessionIds: string[]
  ): Promise<Map<string, AgentSessionProgressSnapshot>> {
    if (sessionIds.length === 0) return new Map()
    const result = await db.query<SessionProgressSnapshotRow>(
      sql`
        SELECT
          s.id,
          s.current_step_type,
          COUNT(st.id) AS step_count,
          COALESCE(array_length(s.sent_message_ids, 1), 0) AS message_count
        FROM agent_sessions s
        LEFT JOIN agent_session_steps st ON st.session_id = s.id
        WHERE s.id = ANY(${sessionIds})
          AND s.status = ${SessionStatuses.RUNNING}
        GROUP BY s.id, s.current_step_type, s.sent_message_ids
      `
    )
    return new Map(
      result.rows.map((row) => [
        row.id,
        {
          sessionId: row.id,
          currentStepType: row.current_step_type as StepType | null,
          stepCount: Number(row.step_count),
          messageCount: row.message_count,
        },
      ])
    )
  },

  async findLatestBySupersedesSession(db: Querier, supersedesSessionId: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE supersedes_session_id = ${supersedesSessionId}
        ORDER BY created_at DESC
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  async updateStatus(
    db: Querier,
    id: string,
    status: SessionStatus,
    extras?: {
      serverId?: string
      responseMessageId?: string
      sentMessageIds?: string[]
      error?: string
      onlyIfStatus?: SessionStatus
      onlyIfStatusIn?: SessionStatus[]
    }
  ): Promise<AgentSession | null> {
    const now = new Date()
    let completedAt: Date | null = null
    if (
      status === SessionStatuses.COMPLETED ||
      status === SessionStatuses.FAILED ||
      status === SessionStatuses.DELETED ||
      status === SessionStatuses.SUPERSEDED
    ) {
      completedAt = now
    }

    const shouldClearCurrentStepType = status === SessionStatuses.DELETED || status === SessionStatuses.SUPERSEDED
    const heartbeatAt = status === SessionStatuses.RUNNING ? now : null

    const values: unknown[] = [
      status,
      extras?.serverId ?? null,
      heartbeatAt,
      extras?.responseMessageId ?? null,
      extras?.sentMessageIds ?? null,
      extras?.error ?? null,
      shouldClearCurrentStepType,
      completedAt,
      id,
    ]

    let whereClause = "WHERE id = $9"
    if (extras?.onlyIfStatusIn && extras.onlyIfStatusIn.length > 0) {
      values.push(extras.onlyIfStatusIn)
      whereClause += ` AND status = ANY($${values.length})`
    } else if (extras?.onlyIfStatus) {
      values.push(extras.onlyIfStatus)
      whereClause += ` AND status = $${values.length}`
    }

    const query = `
      UPDATE agent_sessions
      SET
        status = $1,
        server_id = COALESCE($2, server_id),
        heartbeat_at = COALESCE($3, heartbeat_at),
        response_message_id = COALESCE($4, response_message_id),
        sent_message_ids = COALESCE($5, sent_message_ids),
        error = COALESCE($6, error),
        current_step_type = CASE WHEN $7 THEN NULL ELSE current_step_type END,
        completed_at = $8
      ${whereClause}
      RETURNING ${SESSION_SELECT_FIELDS}
    `

    const result = await db.query<SessionRow>({ text: query, values })
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  /**
   * Record a user's Stop for an enclave-owned session. The flag is consumed by
   * the session-heartbeat callback (the enclave's only inbound channel is its
   * own polling). Returns whether a RUNNING session took the flag — a terminal
   * session has nothing left to abort. Idempotent: a second request keeps the
   * original timestamp.
   */
  async requestAbort(db: Querier, id: string): Promise<boolean> {
    const result = await db.query(
      sql`
        UPDATE agent_sessions
        SET abort_requested_at = COALESCE(abort_requested_at, NOW())
        WHERE id = ${id} AND status = ${SessionStatuses.RUNNING}
      `
    )
    return (result.rowCount ?? 0) > 0
  },

  async updateHeartbeat(db: Querier, id: string): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET heartbeat_at = NOW()
        WHERE id = ${id}
      `
    )
  },

  async updateInvocationReplyKeyGeneration(
    db: Querier,
    params: { workspaceId: string; invocationId: string; replyKeyGeneration: number }
  ): Promise<boolean> {
    const result = await db.query(sql`
      UPDATE agent_sessions session
      SET reply_key_generation = ${params.replyKeyGeneration}
      FROM bot_invocations invocation
      WHERE session.id = ${params.invocationId}
        AND session.status = ${SessionStatuses.RUNNING}
        AND invocation.id = session.id
        AND invocation.workspace_id = ${params.workspaceId}
        AND invocation.status = 'claimed'
    `)
    return (result.rowCount ?? 0) > 0
  },

  async updateCurrentStep(db: Querier, id: string, stepNumber: number): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET current_step = ${stepNumber}, heartbeat_at = NOW()
        WHERE id = ${id}
      `
    )
  },

  /**
   * Update the current step type for a session.
   * Used for cross-stream activity display ("Ariadne is thinking...").
   */
  async updateCurrentStepType(db: Querier, id: string, stepType: StepType | null): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET current_step_type = ${stepType}, heartbeat_at = NOW()
        WHERE id = ${id}
      `
    )
  },

  /**
   * Running sessions with a stale heartbeat, minus those whose bot invocation
   * (same id) still holds a live claim lease: a runtime that keeps renewing is
   * alive even when its renew cadence is slower than the heartbeat threshold.
   */
  async findOrphaned(db: Querier, staleThresholdSeconds: number = 60): Promise<AgentSession[]> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE status = ${SessionStatuses.RUNNING}
          AND heartbeat_at < NOW() - INTERVAL '1 second' * ${staleThresholdSeconds}
          AND NOT EXISTS (
            SELECT 1 FROM bot_invocations
            WHERE bot_invocations.id = agent_sessions.id
              AND bot_invocations.status = ${BotInvocationStatuses.CLAIMED}
              AND bot_invocations.claim_expires_at > NOW()
          )
      `
    )
    return result.rows.map(mapRowToSession)
  },

  /**
   * Find a running session for a stream.
   *
   * NOTE: Session *creation* never uses this — that goes through
   * `insertRunningOrSkip()`, which atomically prevents duplicates via the partial
   * unique index on (stream_id) WHERE status='running'. This read is for
   * opportunistic trace stamping: the public-API bot `sendMessage` path calls it
   * to deep-link a bot message to its live session.
   *
   * FOR UPDATE SKIP LOCKED means a momentarily-locked session row is treated as
   * absent (returns null), so a caller racing an in-flight invocation simply skips
   * the stamp rather than blocking — best-effort by design.
   */
  async findRunningByStream(db: Querier, streamId: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE stream_id = ${streamId}
          AND status = ${SessionStatuses.RUNNING}
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  /**
   * All RUNNING sessions in a workspace, each resolved to its sidebar root
   * (`COALESCE(streams.root_stream_id, streams.id)`) — the row that lights up in
   * the sidebar — and to its thread anchor (`streams.parent_anchor_id`), the
   * timeline row a thread session hangs off. Set-based single query (INV-56),
   * workspace-scoped through the streams join (INV-8; `agent_sessions` has no
   * `workspace_id` column). Seeds the bootstrap `activeAgentSessions`; the caller
   * access-filters by the viewer's accessible root set (INV-62). `personaId` is a
   * persona or bot id — the caller resolves the display name.
   */
  async listRunningByWorkspace(
    db: Querier,
    workspaceId: string
  ): Promise<
    Array<{
      sessionId: string
      streamId: string
      rootStreamId: string
      parentAnchorId: string | null
      triggerMessageId: string
      personaId: string
      startedAt: Date
      currentStepType: StepType | null
    }>
  > {
    const result = await db.query<{
      session_id: string
      stream_id: string
      root_stream_id: string
      parent_anchor_id: string | null
      trigger_message_id: string
      persona_id: string
      started_at: Date
      current_step_type: string | null
    }>(
      sql`
        SELECT
          se.id AS session_id,
          se.stream_id,
          COALESCE(st.root_stream_id, se.stream_id) AS root_stream_id,
          st.parent_anchor_id,
          se.trigger_message_id,
          se.persona_id,
          se.created_at AS started_at,
          se.current_step_type
        FROM agent_sessions se
        JOIN streams st ON st.id = se.stream_id
        WHERE st.workspace_id = ${workspaceId}
          AND se.status = ${SessionStatuses.RUNNING}
      `
    )
    return result.rows.map((row) => ({
      sessionId: row.session_id,
      streamId: row.stream_id,
      rootStreamId: row.root_stream_id,
      parentAnchorId: row.parent_anchor_id,
      triggerMessageId: row.trigger_message_id,
      personaId: row.persona_id,
      startedAt: row.started_at,
      currentStepType: row.current_step_type as StepType | null,
    }))
  },

  /**
   * Find the most recent COMPLETED session for a stream. Unlike
   * `findLatestByStream` this skips the in-flight RUNNING session a turn
   * inserts before it builds its context, so the context window policy reads
   * the PRIOR episode's `lastSeenSequence` (DM episode recency) rather than the
   * current session's.
   */
  async findLatestCompletedByStream(db: Querier, streamId: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE stream_id = ${streamId}
          AND status = ${SessionStatuses.COMPLETED}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  /**
   * Find the most recent session for a stream (regardless of status).
   * Used to check lastSeenSequence when deciding whether to dispatch a new job.
   */
  async findLatestByStream(db: Querier, streamId: string, cursor?: AgentSessionCursor): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE stream_id = ${streamId}
          AND (${cursor?.createdAt ?? null}::timestamptz IS NULL OR (created_at, id) < (${cursor?.createdAt ?? null}, ${cursor?.id ?? null}))
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  async updateContextMessageIds(db: Querier, id: string, messageIds: string[]): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET context_message_ids = ${messageIds}
        WHERE id = ${id}
      `
    )
  },

  /**
   * Persist a session's episode summary (roadmap 3.1). CAS on `IS NULL` so a
   * re-delivered summary job (or two racing summarizers) can't clobber an
   * already-written summary — the first write wins, later ones no-op (INV-20).
   * Returns whether this call wrote the summary.
   */
  async setEpisodeSummary(db: Querier, id: string, summary: string): Promise<boolean> {
    const result = await db.query(
      sql`
        UPDATE agent_sessions
        SET episode_summary = ${summary}
        WHERE id = ${id} AND episode_summary IS NULL
      `
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Claim the reflective session-capture for this session (roadmap 6.3). CAS on
   * `IS NULL` so a re-delivered job (or two racing captures) runs the classifier
   * once — the first claim wins, later ones no-op (INV-20). Returns whether this
   * call won the claim; the caller only does capture work when it did.
   */
  async setReflectiveCaptured(db: Querier, id: string, at: Date): Promise<boolean> {
    const result = await db.query(
      sql`
        UPDATE agent_sessions
        SET reflective_captured_at = ${at}
        WHERE id = ${id} AND reflective_captured_at IS NULL
      `
    )
    return (result.rowCount ?? 0) > 0
  },

  /**
   * Release a reflective-capture claim (roadmap 6.3). The reflective job claims
   * the CAS *before* the classifier/memorizer/embed/save run so a concurrent or
   * re-delivered delivery can't double-capture; if that fallible AI+DB work then
   * throws, the claim holder calls this to reset the marker to NULL so a retry can
   * pick the session back up (the memo writes are transactional — a failure
   * committed nothing). Only the delivery that won the claim calls this, so the
   * reset can't stomp a peer's in-flight claim.
   */
  async clearReflectiveCaptured(db: Querier, id: string): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET reflective_captured_at = NULL
        WHERE id = ${id}
      `
    )
  },

  /**
   * Mark a running supersede-rerun session as having failed response
   * validation (kept the previous reply because revised drafts repeatedly
   * failed the validator). Read by the next rerun's model resolution
   * (roadmap 2.3). Single idempotent UPDATE from the worker that owns the
   * running session (INV-20).
   */
  async markResponseValidationFailed(db: Querier, id: string): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET response_validation_failed = TRUE
        WHERE id = ${id}
      `
    )
  },

  /**
   * Update the last seen sequence for a session.
   * Called during agent loop when new messages are processed.
   */
  async updateLastSeenSequence(db: Querier, id: string, sequence: bigint): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET last_seen_sequence = ${sequence.toString()}, heartbeat_at = NOW()
        WHERE id = ${id}
      `
    )
  },

  /**
   * Complete a session atomically - updates last seen sequence and status in one query.
   * This prevents partial updates if the process crashes between separate calls.
   */
  async completeSession(
    db: Querier,
    id: string,
    params: {
      lastSeenSequence: bigint
      responseMessageId?: string | null
      sentMessageIds?: string[]
      /**
       * Also complete a FAILED session, not just a RUNNING one. A bot
       * invocation whose claim is still valid can only have reached FAILED via
       * orphan-session-cleanup's stale-heartbeat scan — a genuine `/fail` flips
       * the claim, which blocks completion upstream. When such a turn finishes
       * successfully its trace must end COMPLETED, not stay stuck red, so the
       * completion recovers that orphan false-positive. The status-guarded
       * UPDATE keeps this race-safe against a concurrent cleanup (INV-20).
       */
      recoverFromFailed?: boolean
    }
  ): Promise<AgentSession | null> {
    const allowedStatuses = params.recoverFromFailed
      ? [SessionStatuses.RUNNING, SessionStatuses.FAILED]
      : [SessionStatuses.RUNNING]
    const result = await db.query<SessionRow>(
      sql`
        UPDATE agent_sessions
        SET
          status = ${SessionStatuses.COMPLETED},
          last_seen_sequence = ${params.lastSeenSequence.toString()},
          response_message_id = ${params.responseMessageId ?? null},
          sent_message_ids = ${params.sentMessageIds ?? null},
          current_step_type = NULL,
          error = NULL,
          completed_at = NOW()
        WHERE id = ${id}
          AND status = ANY(${allowedStatuses})
        RETURNING ${sql.raw(SESSION_SELECT_FIELDS)}
      `
    )
    return result.rows[0] ? mapRowToSession(result.rows[0]) : null
  },

  // ----- Steps -----

  /**
   * Append a new step at the next available step_number for the session.
   *
   * This method is safe for independent external-runtime HTTP requests: each
   * attempt computes the next number in the INSERT statement, and concurrent
   * unique-key collisions retry until one insert wins instead of clobbering an
   * existing step (INV-20).
   */
  async appendStep(db: Querier, params: AppendStepParams): Promise<AgentSessionStep> {
    const session = await db.query(sql`SELECT 1 FROM agent_sessions WHERE id = ${params.sessionId}`)
    if (session.rowCount === 0) {
      throw new Error(`agent_sessions row not found for session id ${params.sessionId}`)
    }

    while (true) {
      try {
        const result = await db.query<StepRow>(
          sql`
            INSERT INTO agent_session_steps (
              id, session_id, step_number, step_type, content,
              content_ciphertext, content_envelope, sources,
              message_id, tokens_used, started_at, completed_at, client_step_id
            )
            SELECT
              ${params.id},
              ${params.sessionId},
              COALESCE(MAX(step_number), 0) + 1,
              ${params.stepType},
              ${params.content != null ? JSON.stringify(params.content) : null},
              ${params.contentCiphertext ?? null},
              ${params.contentEnvelope ? JSON.stringify(params.contentEnvelope) : null},
              ${params.sources ? JSON.stringify(params.sources) : null},
              ${params.messageId ?? null},
              ${params.tokensUsed ?? null},
              ${params.startedAt},
              ${params.completedAt ?? null},
              ${params.clientStepId ?? null}
            FROM agent_session_steps
            WHERE session_id = ${params.sessionId}
            ON CONFLICT (session_id, step_number) DO NOTHING
            RETURNING ${sql.raw(STEP_SELECT_FIELDS)}
          `
        )
        if (result.rows[0]) return mapRowToStep(result.rows[0])
        // No row: a concurrent insert took this step_number. Recompute MAX+1 and retry.
      } catch (error) {
        // A re-send under the same idempotency key hits the partial-unique index
        // (step_number is free, so the step_number ON CONFLICT didn't fire — the
        // client_step_id collision surfaces as a raw 23505). Return the row the
        // first append created rather than appending a duplicate trace step.
        if (params.clientStepId && isUniqueViolation(error, "agent_session_steps_client_step_id_key")) {
          const existing = await db.query<StepRow>(
            sql`
              SELECT ${sql.raw(STEP_SELECT_FIELDS)} FROM agent_session_steps
              WHERE session_id = ${params.sessionId} AND client_step_id = ${params.clientStepId}
            `
          )
          if (existing.rows[0]) return mapRowToStep(existing.rows[0])
        }
        throw error
      }
    }
  },

  async upsertStep(db: Querier, params: UpsertStepParams): Promise<AgentSessionStep> {
    const result = await db.query<StepRow>(
      sql`
        INSERT INTO agent_session_steps (
          id, session_id, step_number, step_type, content, sources,
          message_id, tokens_used, started_at, completed_at
        ) VALUES (
          ${params.id},
          ${params.sessionId},
          ${params.stepNumber},
          ${params.stepType},
          ${params.content ? JSON.stringify(params.content) : null},
          ${params.sources ? JSON.stringify(params.sources) : null},
          ${params.messageId ?? null},
          ${params.tokensUsed ?? null},
          ${params.startedAt},
          ${params.completedAt ?? null}
        )
        ON CONFLICT (session_id, step_number) DO UPDATE
        SET
          step_type = EXCLUDED.step_type,
          content = COALESCE(EXCLUDED.content, agent_session_steps.content),
          sources = COALESCE(EXCLUDED.sources, agent_session_steps.sources),
          message_id = COALESCE(EXCLUDED.message_id, agent_session_steps.message_id),
          tokens_used = COALESCE(EXCLUDED.tokens_used, agent_session_steps.tokens_used),
          -- On retry, reset both timestamps: new attempt = new start, clear old completion
          started_at = EXCLUDED.started_at,
          completed_at = EXCLUDED.completed_at,
          -- ...and the guardian verdict, for the same reason. A resumed session
          -- restarts step numbering, so step N of attempt 2 is a DIFFERENT call
          -- from step N of attempt 1 — often a tier-1 one. COALESCE-ing here
          -- would show the earlier attempt's approval badge on it.
          verification_status = NULL,
          verification_reason = NULL,
          -- Same reason: attempt 2's step N is a different call, and inheriting
          -- attempt 1's effects would claim writes this attempt never made.
          effects = NULL
        RETURNING ${sql.raw(STEP_SELECT_FIELDS)}
      `
    )
    return mapRowToStep(result.rows[0])
  },

  async completeStep(db: Querier, stepId: string, tokensUsed?: number): Promise<AgentSessionStep | null> {
    const result = await db.query<StepRow>(
      sql`
        UPDATE agent_session_steps
        SET
          completed_at = NOW(),
          tokens_used = COALESCE(${tokensUsed ?? null}, tokens_used)
        WHERE id = ${stepId}
        RETURNING ${sql.raw(STEP_SELECT_FIELDS)}
      `
    )
    return result.rows[0] ? mapRowToStep(result.rows[0]) : null
  },

  async updateStep(
    db: Querier,
    stepId: string,
    params: {
      content?: unknown
      /** E2E (enclave) finalize: SSK-sealed content + envelope set in place on the in-flight row. */
      contentCiphertext?: string
      contentEnvelope?: unknown
      sources?: TraceSource[]
      messageId?: string
      /**
       * Guardian verdict for a guarded tool call. Written as its own patch
       * between the step opening and its result, so the trace can show the
       * review resolving before the action does.
       */
      verification?: { status: ToolVerificationStatus; reason?: string }
      /**
       * What the call wrote, patched in when the tool returns. Omitted for
       * sealed streams — see `AgentSessionStep.effects`.
       */
      effects?: AgentToolEffect[]
      completedAt?: Date
      /**
       * Scope the update to one session so a caller-controlled `stepId` can only
       * touch a step of the session it owns. The public bot sealed-step callback
       * passes the authorized session id (the step id is fully caller-supplied
       * there); omitted on the trusted internal enclave path, where it no-ops.
       */
      sessionId?: string
      /**
       * Guard against overwriting a finalized step. A mid-run substep snapshot can
       * race a finalize (`/steps`): network reordering or a retry can land the
       * snapshot after completion, clobbering the final content with a partial one.
       * When set, the row updates only while still running — a no-op (null) once
       * finalized, so the final content always wins.
       */
      requireRunning?: boolean
    }
  ): Promise<AgentSessionStep | null> {
    const result = await db.query<StepRow>(
      sql`
        UPDATE agent_session_steps
        SET
          content = COALESCE(${params.content != null ? JSON.stringify(params.content) : null}, content),
          content_ciphertext = COALESCE(${params.contentCiphertext ?? null}, content_ciphertext),
          content_envelope = COALESCE(${params.contentEnvelope ? JSON.stringify(params.contentEnvelope) : null}, content_envelope),
          sources = COALESCE(${params.sources ? JSON.stringify(params.sources) : null}, sources),
          message_id = COALESCE(${params.messageId ?? null}, message_id),
          verification_status = COALESCE(${params.verification?.status ?? null}, verification_status),
          verification_reason = COALESCE(${params.verification?.reason ?? null}, verification_reason),
          effects = COALESCE(${params.effects ? JSON.stringify(params.effects) : null}, effects),
          completed_at = COALESCE(${params.completedAt ?? null}, completed_at)
        WHERE id = ${stepId}
          AND (${params.sessionId ?? null}::text IS NULL OR session_id = ${params.sessionId ?? null})
          ${sql.raw(params.requireRunning ? "AND completed_at IS NULL" : "")}
        RETURNING ${sql.raw(STEP_SELECT_FIELDS)}
      `
    )
    return result.rows[0] ? mapRowToStep(result.rows[0]) : null
  },

  async findStepsBySession(db: Querier, sessionId: string, limit: number = 500): Promise<AgentSessionStep[]> {
    const result = await db.query<StepRow>(
      sql`
        SELECT ${sql.raw(STEP_SELECT_FIELDS)}
        FROM agent_session_steps
        WHERE session_id = ${sessionId}
        ORDER BY step_number ASC
        LIMIT ${limit}
      `
    )
    return result.rows.map(mapRowToStep)
  },

  /**
   * The `turn_digest` steps of a stream's most recent COMPLETED sessions for a
   * persona, newest session first (C-1 injection input — callers reverse to
   * oldest-first for the prompt). Completed-only is load-bearing: it excludes
   * the in-flight session building its own context, and a session superseded
   * after completing drops out the moment its status flips, taking its now
   * obsolete digest with it.
   */
  async findRecentDigestStepsByStream(
    db: Querier,
    params: { streamId: string; personaId: string; limit: number }
  ): Promise<RecentDigestStep[]> {
    const result = await db.query<StepRow & { session_created_at: Date; session_completed_at: Date | null }>(
      sql`
        SELECT
          st.id, st.session_id, st.step_number, st.step_type,
          st.content, st.content_ciphertext, st.content_envelope,
          st.sources, st.message_id, st.tokens_used, st.started_at, st.completed_at,
          s.created_at AS session_created_at,
          s.completed_at AS session_completed_at
        FROM agent_session_steps st
        JOIN agent_sessions s ON s.id = st.session_id
        WHERE s.stream_id = ${params.streamId}
          AND s.persona_id = ${params.personaId}
          AND s.status = ${SessionStatuses.COMPLETED}
          AND st.step_type = ${AgentStepTypes.TURN_DIGEST}
        ORDER BY s.created_at DESC, st.step_number DESC
        LIMIT ${params.limit}
      `
    )
    return result.rows.map((row) => ({
      step: mapRowToStep(row),
      sessionCreatedAt: row.session_created_at,
      sessionCompletedAt: row.session_completed_at,
    }))
  },

  /**
   * The episode summaries of a stream's most recent COMPLETED sessions for a
   * persona, newest session first (roadmap 3.1 "Previous sessions" injection —
   * callers reverse to oldest-first for the prompt). Only rows whose summary job
   * has landed are returned (`episode_summary IS NOT NULL`), so the in-flight
   * session building its own context (no summary yet) is excluded by
   * construction. Scoped to (stream, persona) like the turn-digest read — a
   * persona loads only its own episodes, never another persona's.
   */
  async findRecentEpisodeSummariesByStream(
    db: Querier,
    params: { streamId: string; personaId: string; limit: number }
  ): Promise<RecentEpisodeSummary[]> {
    const result = await db.query<{ summary: string; created_at: Date; completed_at: Date | null }>(
      sql`
        SELECT episode_summary AS summary, created_at, completed_at
        FROM agent_sessions
        WHERE stream_id = ${params.streamId}
          AND persona_id = ${params.personaId}
          AND status = ${SessionStatuses.COMPLETED}
          AND episode_summary IS NOT NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${params.limit}
      `
    )
    return result.rows.map((row) => ({
      summary: row.summary,
      sessionCreatedAt: row.created_at,
      sessionCompletedAt: row.completed_at,
    }))
  },

  async findLatestStep(db: Querier, sessionId: string): Promise<AgentSessionStep | null> {
    const result = await db.query<StepRow>(
      sql`
        SELECT ${sql.raw(STEP_SELECT_FIELDS)}
        FROM agent_session_steps
        WHERE session_id = ${sessionId}
        ORDER BY step_number DESC
        LIMIT 1
      `
    )
    return result.rows[0] ? mapRowToStep(result.rows[0]) : null
  },
}
