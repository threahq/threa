import type {
  AgentOutcomeKind,
  AgentOutcomeScope,
  DelegationStatus,
  FollowUpStatus,
  SubagentStatus,
} from "@threa/types"
import { composeSql, type Querier } from "../../db"
import { KEYSET_EPOCH, type KeysetCursor } from "../../lib/keyset-cursor"
import { streamAccessPredicateSql } from "../streams"

export interface AgentOutcomeFilters {
  workspaceId: string
  userId: string
  /** Scope filter; empty/absent means the whole accessible workspace. */
  streamIds?: readonly string[]
  /** `tree` also matches each scoped stream's threads; `stream` matches exactly. */
  scope?: AgentOutcomeScope
  kind?: AgentOutcomeKind
  /** Concrete status sets the `state` filter resolved to; absent means unfiltered. */
  followUpStatuses?: readonly FollowUpStatus[]
  delegationStatuses?: readonly DelegationStatus[]
  subagentStatuses?: readonly SubagentStatus[]
  queryText?: string
}

export interface ListAgentOutcomesParams extends AgentOutcomeFilters {
  cursor?: KeysetCursor
  limit: number
  /** Soonest-first. See {@link AgentOutcomeReadRepository.list}. */
  ascending: boolean
}

// Direction is chosen from a closed set, never from caller input, so these
// fragments are literal text rather than bound parameters — Postgres will not
// accept a parameter in an ORDER BY direction or a row-comparison operator.
const SQL_ASC = { text: "ASC", values: [] }
const SQL_DESC = { text: "DESC", values: [] }
const SQL_GT = { text: ">", values: [] }
const SQL_LT = { text: "<", values: [] }

export interface AgentOutcomeRow {
  id: string
  kind: AgentOutcomeKind
  streamId: string
  title: string
  status: FollowUpStatus | DelegationStatus | SubagentStatus
  scheduledFor: Date | null
  claimedByLabel: string | null
  statusNote: string | null
  resultMessageId: string | null
  actorType: string
  actorId: string
  createdAt: Date
  statusChangedAt: Date
  occursAt: Date
  /** Keyset position — full-precision `occurs_at` text, the only thing a cursor is built from. */
  occursAtKey: string
  anchorEventId: string | null
}

interface DbRow {
  id: string
  kind: AgentOutcomeKind
  stream_id: string
  title: string
  status: string
  scheduled_for: Date | null
  claimed_by_label: string | null
  status_note: string | null
  result_message_id: string | null
  actor_type: string
  actor_id: string
  created_at: Date
  status_changed_at: Date
  occurs_at: Date
  occurs_at_key: string
  anchor_event_id: string | null
}

function mapRow(row: DbRow): AgentOutcomeRow {
  return {
    id: row.id,
    kind: row.kind,
    streamId: row.stream_id,
    title: row.title,
    status: row.status as FollowUpStatus | DelegationStatus | SubagentStatus,
    scheduledFor: row.scheduled_for,
    claimedByLabel: row.claimed_by_label,
    statusNote: row.status_note,
    resultMessageId: row.result_message_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
    occursAt: row.occurs_at,
    occursAtKey: row.occurs_at_key,
    anchorEventId: row.anchor_event_id,
  }
}

/**
 * Scope + the two tables, unioned. `occurs_at` is the design-bearing column: a
 * follow-up sorts on `scheduled_for` (its firing time, usually in the future), a
 * delegation on `status_changed_at` (when it last moved), so an outstanding
 * delegation and a follow-up firing tonight interleave the way the reader
 * expects. It is also the keyset column — never swap it for `created_at`.
 */
function scopedSql(filters: AgentOutcomeFilters) {
  const { workspaceId, userId } = filters
  const streamIds = filters.streamIds ?? []
  const hasStreamScope = streamIds.length > 0
  const queryText = filters.queryText?.trim()
  const hasQuery = Boolean(queryText)
  const likePattern = `%${(queryText ?? "").replace(/[\\%_]/g, "\\$&")}%`
  const followUpStatuses = filters.followUpStatuses ?? []
  const delegationStatuses = filters.delegationStatuses ?? []
  const subagentStatuses = filters.subagentStatuses ?? []
  const includeFollowUps = filters.kind === undefined || filters.kind === "follow_up"
  const includeDelegations = filters.kind === undefined || filters.kind === "delegation"
  const includeSubagents = filters.kind === undefined || filters.kind === "subagent"
  const isTree = (filters.scope ?? "tree") === "tree"

  return composeSql`
    WITH accessible_streams AS (
      SELECT s.id
      FROM streams s
      WHERE s.workspace_id = ${workspaceId}
        AND ${streamAccessPredicateSql(workspaceId, userId, "s.id")}
    ),
    scoped_streams AS (
      SELECT acc.id
      FROM accessible_streams acc
      LEFT JOIN streams s ON s.id = acc.id
      WHERE
        ${!hasStreamScope}
        OR acc.id = ANY(${streamIds as string[]})
        OR (${isTree} AND s.root_stream_id = ANY(${streamIds as string[]}))
    ),
    outcomes AS (
      SELECT
        'delegation'::text AS kind,
        dt.id,
        dt.stream_id,
        dt.title,
        dt.status,
        NULL::timestamptz AS scheduled_for,
        dt.claimed_by_label,
        dt.status_note,
        dt.result_message_id,
        dt.created_by_kind AS actor_type,
        dt.created_by_id AS actor_id,
        dt.created_at,
        dt.status_changed_at,
        dt.status_changed_at AS occurs_at,
        NULL::text AS own_anchor_event_id
      FROM delegated_tasks dt
      JOIN scoped_streams ss ON ss.id = dt.stream_id
      WHERE ${includeDelegations}
        AND dt.workspace_id = ${workspaceId}
        AND (${delegationStatuses.length === 0} OR dt.status = ANY(${delegationStatuses as string[]}))
        AND (${!hasQuery} OR dt.title ILIKE ${likePattern})
      UNION ALL
      SELECT
        'follow_up'::text AS kind,
        afu.id,
        afu.stream_id,
        afu.note AS title,
        afu.status,
        afu.scheduled_for,
        NULL::text AS claimed_by_label,
        afu.last_error AS status_note,
        NULL::text AS result_message_id,
        'persona'::text AS actor_type,
        afu.persona_id AS actor_id,
        afu.created_at,
        afu.status_changed_at,
        afu.scheduled_for AS occurs_at,
        NULL::text AS own_anchor_event_id
      FROM agent_follow_ups afu
      JOIN scoped_streams ss ON ss.id = afu.stream_id
      WHERE ${includeFollowUps}
        AND afu.workspace_id = ${workspaceId}
        AND (${followUpStatuses.length === 0} OR afu.status = ANY(${followUpStatuses as string[]}))
        AND (${!hasQuery} OR afu.note ILIKE ${likePattern})
      UNION ALL
      SELECT
        'subagent'::text AS kind,
        sr.id,
        sr.parent_stream_id AS stream_id,
        sr.title,
        sr.status,
        NULL::timestamptz AS scheduled_for,
        NULL::text AS claimed_by_label,
        sr.status_note,
        sr.result_message_id,
        'user'::text AS actor_type,
        sr.created_by AS actor_id,
        sr.created_at,
        sr.status_changed_at,
        sr.status_changed_at AS occurs_at,
        -- The run stores its card's event id, so this arm needs no anchor join.
        sr.card_event_id AS own_anchor_event_id
      FROM subagent_runs sr
      JOIN scoped_streams ss ON ss.id = sr.parent_stream_id
      WHERE ${includeSubagents}
        AND sr.workspace_id = ${workspaceId}
        AND (${subagentStatuses.length === 0} OR sr.status = ANY(${subagentStatuses as string[]}))
        AND (${!hasQuery} OR sr.title ILIKE ${likePattern})
    )
  `
}

export const AgentOutcomeReadRepository = {
  /**
   * One interleaved page. Access runs through `streamAccessPredicateSql`
   * (INV-62), so a thread inside a readable root is included without a
   * `stream_members` row of its own. The anchor joins key on constants and sit
   * above the page cut, so they resolve for the rows on the page rather than
   * for every accessible outcome — and the outer ORDER BY is load-bearing, a
   * join does not preserve the inner order.
   *
   * Direction is the caller's, and it is not cosmetic. A delegation's
   * `occurs_at` is always in the past and a follow-up's is usually in the
   * future, so paging outstanding work newest-first fills page 1 with scheduled
   * follow-ups and leaves every running delegation on the last page — invisible
   * on the view whose whole purpose is to show it. Outstanding therefore reads
   * as an agenda: soonest first, so overdue and running work heads page 1.
   */
  async list(db: Querier, params: ListAgentOutcomesParams): Promise<AgentOutcomeRow[]> {
    const cursor = params.cursor
    const order = params.ascending ? SQL_ASC : SQL_DESC
    const comparison = params.ascending ? SQL_GT : SQL_LT
    const result = await db.query<DbRow>(composeSql`
      ${scopedSql(params)},
      page AS (
        SELECT
          o.*,
          to_char(o.occurs_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurs_at_key
        FROM outcomes o
        WHERE (
          ${cursor === undefined}
          OR (o.occurs_at, o.id) ${comparison} (${cursor?.at ?? KEYSET_EPOCH}::timestamptz, ${cursor?.id ?? ""}::text)
        )
        ORDER BY o.occurs_at ${order}, o.id ${order}
        LIMIT ${params.limit}
      )
      SELECT
        p.*,
        COALESCE(p.own_anchor_event_id, de.id, fe.id) AS anchor_event_id
      FROM page p
      LEFT JOIN stream_events de
        ON p.kind = 'delegation'
       AND de.stream_id = p.stream_id
       AND de.event_type = 'delegation:created'
       AND de.payload->>'delegationId' = p.id
      LEFT JOIN stream_events fe
        ON p.kind = 'follow_up'
       AND fe.stream_id = p.stream_id
       AND fe.event_type = 'agent:follow_up_scheduled'
       AND fe.payload->>'followUpId' = p.id
      ORDER BY p.occurs_at ${order}, p.id ${order}
    `)
    return result.rows.map(mapRow)
  },

  /** Whole-scope total for the same filters — the first page's `outstandingCount`. */
  async count(db: Querier, filters: AgentOutcomeFilters): Promise<number> {
    const result = await db.query<{ count: number }>(composeSql`
      ${scopedSql(filters)}
      SELECT COUNT(*)::int AS count FROM outcomes o
    `)
    return result.rows[0]?.count ?? 0
  },
}
