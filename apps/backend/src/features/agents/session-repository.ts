import type { AgentSessionStatus, AgentStepType, TraceSource } from "@threa/types"
import { AgentSessionStatuses, AgentStepTypes } from "@threa/types"
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
  heartbeat_at: Date | null
  response_message_id: string | null
  error: string | null
  last_seen_sequence: string | null
  sent_message_ids: string[] | null
  context_message_ids: string[] | null
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
  heartbeatAt: Date | null
  responseMessageId: string | null
  error: string | null
  lastSeenSequence: bigint | null
  sentMessageIds: string[]
  contextMessageIds: string[]
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
  startedAt: Date
  completedAt: Date | null
}

export interface AgentSessionProgressSnapshot {
  sessionId: string
  currentStepType: StepType | null
  stepCount: number
  messageCount: number
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
    heartbeatAt: row.heartbeat_at,
    responseMessageId: row.response_message_id,
    error: row.error,
    lastSeenSequence: row.last_seen_sequence ? BigInt(row.last_seen_sequence) : null,
    sentMessageIds: row.sent_message_ids ?? [],
    contextMessageIds: row.context_message_ids ?? [],
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
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

const SESSION_SELECT_FIELDS = `
  id, stream_id, persona_id, trigger_message_id, trigger_message_revision, supersedes_session_id,
  status, current_step, current_step_type, server_id, heartbeat_at,
  response_message_id, error, last_seen_sequence,
  sent_message_ids, context_message_ids, created_at, completed_at
`

const STEP_SELECT_FIELDS = `
  id, session_id, step_number, step_type,
  content, content_ciphertext, content_envelope,
  sources, message_id, tokens_used, started_at, completed_at
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
    params: Omit<InsertSessionParams, "status"> & { initialSequence: bigint }
  ): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        INSERT INTO agent_sessions (
          id, stream_id, persona_id, trigger_message_id,
          trigger_message_revision, supersedes_session_id,
          status, server_id, heartbeat_at, last_seen_sequence
        ) VALUES (
          ${params.id},
          ${params.streamId},
          ${params.personaId},
          ${params.triggerMessageId},
          ${params.triggerMessageRevision ?? null},
          ${params.supersedesSessionId ?? null},
          ${SessionStatuses.RUNNING},
          ${params.serverId ?? null},
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

  async findByTriggerMessage(db: Querier, triggerMessageId: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE trigger_message_id = ${triggerMessageId}
        ORDER BY created_at DESC
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

  async updateHeartbeat(db: Querier, id: string): Promise<void> {
    await db.query(
      sql`
        UPDATE agent_sessions
        SET heartbeat_at = NOW()
        WHERE id = ${id}
      `
    )
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
   * Find sessions that are running but have stale heartbeats.
   * These are candidates for recovery/retry.
   */
  async findOrphaned(db: Querier, staleThresholdSeconds: number = 60): Promise<AgentSession[]> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE status = ${SessionStatuses.RUNNING}
          AND heartbeat_at < NOW() - INTERVAL '1 second' * ${staleThresholdSeconds}
      `
    )
    return result.rows.map(mapRowToSession)
  },

  /**
   * Find a running session for a stream.
   *
   * NOTE: This is a utility method for inspection/debugging. The main session
   * creation flow uses `insertRunningOrSkip()` which atomically prevents duplicates
   * via the partial unique index on (stream_id) WHERE status='running'.
   *
   * Uses FOR UPDATE SKIP LOCKED to avoid blocking concurrent transactions.
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
   * Find the most recent session for a stream (regardless of status).
   * Used to check lastSeenSequence when deciding whether to dispatch a new job.
   */
  async findLatestByStream(db: Querier, streamId: string): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        SELECT ${sql.raw(SESSION_SELECT_FIELDS)}
        FROM agent_sessions
        WHERE stream_id = ${streamId}
        ORDER BY created_at DESC
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
    }
  ): Promise<AgentSession | null> {
    const result = await db.query<SessionRow>(
      sql`
        UPDATE agent_sessions
        SET
          status = ${SessionStatuses.COMPLETED},
          last_seen_sequence = ${params.lastSeenSequence.toString()},
          response_message_id = ${params.responseMessageId ?? null},
          sent_message_ids = ${params.sentMessageIds ?? null},
          current_step_type = NULL,
          completed_at = NOW()
        WHERE id = ${id}
          AND status = ${SessionStatuses.RUNNING}
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
      const result = await db.query<StepRow>(
        sql`
          INSERT INTO agent_session_steps (
            id, session_id, step_number, step_type, content,
            content_ciphertext, content_envelope, sources,
            message_id, tokens_used, started_at, completed_at
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
            ${params.completedAt ?? null}
          FROM agent_session_steps
          WHERE session_id = ${params.sessionId}
          ON CONFLICT (session_id, step_number) DO NOTHING
          RETURNING ${sql.raw(STEP_SELECT_FIELDS)}
        `
      )
      if (result.rows[0]) return mapRowToStep(result.rows[0])
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
          completed_at = EXCLUDED.completed_at
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
      sources?: TraceSource[]
      messageId?: string
      completedAt?: Date
    }
  ): Promise<AgentSessionStep | null> {
    const result = await db.query<StepRow>(
      sql`
        UPDATE agent_session_steps
        SET
          content = COALESCE(${params.content != null ? JSON.stringify(params.content) : null}, content),
          sources = COALESCE(${params.sources ? JSON.stringify(params.sources) : null}, sources),
          message_id = COALESCE(${params.messageId ?? null}, message_id),
          completed_at = COALESCE(${params.completedAt ?? null}, completed_at)
        WHERE id = ${stepId}
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
