import type { Querier } from "../../db"
import type { AccessKind, AccessLogOperation, AccessOutcome, ActorType } from "./operations"
import type { AuditSubjectRef } from "./subjects"

/** A row ready to persist. `occurredAt` defaults to the DB `now()` when omitted. */
export interface AccessLogInsert {
  id: string
  workspaceId: string | null
  occurredAt?: Date
  actorType: ActorType
  actorId: string
  onBehalfOfUserId?: string | null
  authRef?: string | null
  operation: AccessLogOperation
  accessKind: AccessKind
  outcome: AccessOutcome
  subjects?: AuditSubjectRef[] | null
  detail?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
  requestId?: string | null
}

export interface AccessLogRow {
  id: string
  workspaceId: string | null
  occurredAt: Date
  actorType: string
  actorId: string
  onBehalfOfUserId: string | null
  authRef: string | null
  operation: string
  accessKind: string
  outcome: string
  subjects: AuditSubjectRef[] | null
  detail: Record<string, unknown> | null
  ip: string | null
  userAgent: string | null
  requestId: string | null
}

export interface ListByActorParams {
  workspaceId: string | null
  actorId: string
  from?: Date
  to?: Date
  limit?: number
}

export interface ListBySubjectParams {
  workspaceId: string | null
  subjectType: string
  subjectId: string
  from?: Date
  to?: Date
  limit?: number
}

export interface ReconstructDeliveredParams {
  workspaceId: string
  streamId: string
  from: Date
  to: Date
  /**
   * Interval edges are widened by this uncertainty window because subscribe/
   * unsubscribe rows are app-clock stamped while `stream_events.created_at` is
   * DB-clocked — unpadded edges could trim deliveries near join/leave (the
   * under-count the design forbids). Padding over-approximates, the safe
   * direction. Default 5s; pass 0 only to assert exact interval semantics.
   */
  clockSkewToleranceMs?: number
}

const DEFAULT_CLOCK_SKEW_TOLERANCE_MS = 5_000

/**
 * One `stream_events` row (metadata only — never payload) that a subscriber
 * received while an interval was open. `actorId`/`actorType` identify the
 * subscriber (from the `subscribe` row); `eventActorId`/`eventActorType` are the
 * event's own actor (who caused it).
 */
export interface DeliveredEvent {
  actorId: string
  actorType: string
  authRef: string | null
  eventId: string
  sequence: number
  eventType: string
  eventActorId: string | null
  eventActorType: string | null
  createdAt: Date
}

interface DeliveredEventDbRow {
  actor_id: string
  actor_type: string
  auth_ref: string | null
  event_id: string
  sequence: string
  event_type: string
  event_actor_id: string | null
  event_actor_type: string | null
  created_at: Date
}

const DEFAULT_LIMIT = 500

interface DbRow {
  id: string
  workspace_id: string | null
  occurred_at: Date
  actor_type: string
  actor_id: string
  on_behalf_of_user_id: string | null
  auth_ref: string | null
  operation: string
  access_kind: string
  outcome: string
  subjects: AuditSubjectRef[] | null
  detail: Record<string, unknown> | null
  ip: string | null
  user_agent: string | null
  request_id: string | null
}

function mapRow(row: DbRow): AccessLogRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    onBehalfOfUserId: row.on_behalf_of_user_id,
    authRef: row.auth_ref,
    operation: row.operation,
    accessKind: row.access_kind,
    outcome: row.outcome,
    subjects: row.subjects,
    detail: row.detail,
    ip: row.ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
  }
}

const COLUMNS =
  "id, workspace_id, occurred_at, actor_type, actor_id, on_behalf_of_user_id, auth_ref, " +
  "operation, access_kind, outcome, subjects, detail, ip, user_agent, request_id"

function rowValues(row: AccessLogInsert): unknown[] {
  return [
    row.id,
    row.workspaceId,
    row.occurredAt ?? null,
    row.actorType,
    row.actorId,
    row.onBehalfOfUserId ?? null,
    row.authRef ?? null,
    row.operation,
    row.accessKind,
    row.outcome,
    row.subjects != null ? JSON.stringify(row.subjects) : null,
    row.detail != null ? JSON.stringify(row.detail) : null,
    row.ip ?? null,
    row.userAgent ?? null,
    row.requestId ?? null,
  ]
}

// occurred_at is column position 3; NULL there falls back to the table default.
const COLUMN_CASTS = [
  "$#",
  "$#",
  "COALESCE($#::timestamptz, now())",
  "$#",
  "$#",
  "$#",
  "$#",
  "$#",
  "$#",
  "$#",
  "$#::jsonb",
  "$#::jsonb",
  "$#::inet",
  "$#",
  "$#",
]

function valuesClause(rowIndex: number): string {
  const base = rowIndex * COLUMN_CASTS.length
  let n = 0
  const placeholders = COLUMN_CASTS.map((cast) => cast.replaceAll("$#", () => `$${base + ++n}`))
  return `(${placeholders.join(", ")})`
}

export const AccessLogRepository = {
  async insert(querier: Querier, row: AccessLogInsert): Promise<void> {
    await querier.query(`INSERT INTO access_log (${COLUMNS}) VALUES ${valuesClause(0)}`, rowValues(row))
  },

  async insertMany(querier: Querier, rows: AccessLogInsert[]): Promise<void> {
    if (rows.length === 0) return
    const values = rows.map((_, i) => valuesClause(i)).join(", ")
    const params = rows.flatMap(rowValues)
    await querier.query(`INSERT INTO access_log (${COLUMNS}) VALUES ${values}`, params)
  },

  async listByActor(querier: Querier, params: ListByActorParams): Promise<AccessLogRow[]> {
    const values: unknown[] = [params.actorId]
    const clauses = ["actor_id = $1"]
    if (params.workspaceId === null) {
      clauses.push("workspace_id IS NULL")
    } else {
      values.push(params.workspaceId)
      clauses.push(`workspace_id = $${values.length}`)
    }
    if (params.from) {
      values.push(params.from)
      clauses.push(`occurred_at >= $${values.length}`)
    }
    if (params.to) {
      values.push(params.to)
      clauses.push(`occurred_at < $${values.length}`)
    }
    values.push(params.limit ?? DEFAULT_LIMIT)
    const result = await querier.query<DbRow>(
      `SELECT ${COLUMNS} FROM access_log WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC LIMIT $${values.length}`,
      values
    )
    return result.rows.map(mapRow)
  },

  async listBySubject(querier: Querier, params: ListBySubjectParams): Promise<AccessLogRow[]> {
    const containment = JSON.stringify([{ type: params.subjectType, id: params.subjectId }])
    const values: unknown[] = [containment]
    const clauses = ["subjects @> $1::jsonb"]
    if (params.workspaceId === null) {
      clauses.push("workspace_id IS NULL")
    } else {
      values.push(params.workspaceId)
      clauses.push(`workspace_id = $${values.length}`)
    }
    if (params.from) {
      values.push(params.from)
      clauses.push(`occurred_at >= $${values.length}`)
    }
    if (params.to) {
      values.push(params.to)
      clauses.push(`occurred_at < $${values.length}`)
    }
    values.push(params.limit ?? DEFAULT_LIMIT)
    const result = await querier.query<DbRow>(
      `SELECT ${COLUMNS} FROM access_log WHERE ${clauses.join(" AND ")}
       ORDER BY occurred_at DESC LIMIT $${values.length}`,
      values
    )
    return result.rows.map(mapRow)
  },

  /**
   * Reconstructs the delivered event set for a stream over `[from, to]` from the
   * socket subscription intervals (design §3): one stream-room `subscribe` row
   * opens an interval, the next matching stream-room `unsubscribe` (same
   * `auth_ref` sconn) closes it, and an interval with no `unsubscribe` is treated
   * open-ended (the safe over-approximation for breach scoping). Each interval
   * is intersected with the live `stream_events` for the stream, reading only
   * metadata columns — never `payload`. Set-based (correlated `MIN` for the
   * closing row + one join), not a per-row app loop (INV-56).
   *
   * The pairing is scoped to the stream ROOM, not merely rows containing the
   * stream subject: an agent-session-room subscription carries both an
   * `agent_session` and the `stream` subject (`socket.ts` join site), so its
   * unsubscribe would satisfy plain `@> [{stream}]` containment and close the
   * stream-room interval early — dropping events the user actually received
   * (the under-approximation §3 forbids). `jsonb_array_length(subjects) = 1`
   * isolates the single-subject stream-room rows from the two-subject
   * agent-session rows while keeping the GIN-indexed `@>` prefilter. The final
   * `DISTINCT ON (auth_ref, event)` dedupes re-subscribes of the SAME
   * connection but keeps one row per connection — "from where" matters: a
   * user's phone and a hijacked browser session both receiving an event are
   * two deliveries, not one.
   */
  async reconstructDeliveredEvents(querier: Querier, params: ReconstructDeliveredParams): Promise<DeliveredEvent[]> {
    const subject = JSON.stringify([{ type: "stream", id: params.streamId }])
    const skewMs = params.clockSkewToleranceMs ?? DEFAULT_CLOCK_SKEW_TOLERANCE_MS
    const result = await querier.query<DeliveredEventDbRow>(
      `WITH intervals AS (
         SELECT
           s.actor_id,
           s.actor_type,
           s.auth_ref,
           s.occurred_at AS started_at,
           (
             SELECT MIN(u.occurred_at)
             FROM access_log u
             WHERE u.workspace_id = $1
               AND u.access_kind = 'unsubscribe'
               AND u.auth_ref = s.auth_ref
               AND u.subjects @> $2::jsonb
               AND jsonb_array_length(u.subjects) = 1
               AND u.occurred_at > s.occurred_at
           ) AS ended_at
         FROM access_log s
         WHERE s.workspace_id = $1
           AND s.access_kind = 'subscribe'
           AND s.outcome = 'success'
           AND s.subjects @> $2::jsonb
           AND jsonb_array_length(s.subjects) = 1
           -- An interval starting after the window end (plus skew pad) cannot
           -- contribute; the bound also lets the planner prune future partitions.
           AND s.occurred_at <= $5::timestamptz + make_interval(secs => $6::numeric / 1000.0)
       ),
       delivered AS (
         SELECT DISTINCT ON (i.auth_ref, e.id)
           i.actor_id,
           i.actor_type,
           i.auth_ref,
           e.id AS event_id,
           e.sequence,
           e.event_type,
           e.actor_id AS event_actor_id,
           e.actor_type AS event_actor_type,
           e.created_at
         FROM intervals i
         JOIN stream_events e
           ON e.stream_id = $3
           -- Edges widened by the skew pad: subscribe rows are app-clock
           -- stamped, stream_events are DB-clocked (ReconstructDeliveredParams).
           AND e.created_at >= i.started_at - make_interval(secs => $6::numeric / 1000.0)
           AND (i.ended_at IS NULL OR e.created_at < i.ended_at + make_interval(secs => $6::numeric / 1000.0))
           AND e.created_at >= $4
           AND e.created_at <= $5
         ORDER BY i.auth_ref, e.id, i.started_at
       )
       SELECT
         actor_id,
         actor_type,
         auth_ref,
         event_id,
         sequence,
         event_type,
         event_actor_id,
         event_actor_type,
         created_at
       FROM delivered
       ORDER BY actor_id, sequence`,
      [params.workspaceId, subject, params.streamId, params.from, params.to, skewMs]
    )
    return result.rows.map((row) => ({
      actorId: row.actor_id,
      actorType: row.actor_type,
      authRef: row.auth_ref,
      eventId: row.event_id,
      sequence: Number(row.sequence),
      eventType: row.event_type,
      eventActorId: row.event_actor_id,
      eventActorType: row.event_actor_type,
      createdAt: row.created_at,
    }))
  },
}
