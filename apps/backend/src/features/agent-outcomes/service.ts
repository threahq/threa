import type { Pool } from "pg"
import {
  DELEGATION_STATUSES,
  DELEGATION_TERMINAL_STATUSES,
  FOLLOW_UP_STATUSES,
  FOLLOW_UP_TERMINAL_STATUSES,
  SUBAGENT_STATUSES,
  SUBAGENT_TERMINAL_STATUSES,
  type AgentOutcomeKind,
  type AgentOutcomeScope,
  type AgentOutcomeState,
  type AgentOutcomeSummary,
  type DelegationStatus,
  type FollowUpStatus,
  type ListAgentOutcomesResponse,
  type SubagentStatus,
} from "@threahq/types"
import { decodeKeysetCursor, encodeKeysetCursor } from "../../lib/keyset-cursor"
import { AgentOutcomeReadRepository, type AgentOutcomeRow } from "./read-repository"

interface Dependencies {
  pool: Pool
}

export interface ListAgentOutcomesParams {
  workspaceId: string
  userId: string
  streamIds?: string[]
  scope?: AgentOutcomeScope
  state: AgentOutcomeState
  kind?: AgentOutcomeKind
  queryText?: string
  cursor?: string
  limit: number
  /** Opt in to the whole-scope outstanding count; it costs a second full scan. */
  withCount?: boolean
}

const FOLLOW_UP_TERMINAL: ReadonlySet<string> = new Set(FOLLOW_UP_TERMINAL_STATUSES)
const DELEGATION_TERMINAL: ReadonlySet<string> = new Set(DELEGATION_TERMINAL_STATUSES)
const SUBAGENT_TERMINAL: ReadonlySet<string> = new Set(SUBAGENT_TERMINAL_STATUSES)

/**
 * `state` → the concrete status sets the query filters on. `all` returns
 * `undefined` so the predicate drops out entirely rather than listing every
 * status (a status added to the constant but forgotten here would otherwise
 * vanish from `all`).
 */
export function statusesForState(state: AgentOutcomeState): {
  followUpStatuses?: FollowUpStatus[]
  delegationStatuses?: DelegationStatus[]
  subagentStatuses?: SubagentStatus[]
} {
  if (state === "all") return {}
  const settled = state === "settled"
  return {
    followUpStatuses: FOLLOW_UP_STATUSES.filter((s) => FOLLOW_UP_TERMINAL.has(s) === settled),
    delegationStatuses: DELEGATION_STATUSES.filter((s) => DELEGATION_TERMINAL.has(s) === settled),
    subagentStatuses: SUBAGENT_STATUSES.filter((s) => SUBAGENT_TERMINAL.has(s) === settled),
  }
}

/**
 * Outstanding reads as an agenda — soonest first — and everything else reads as
 * history, newest first. A delegation's `occurs_at` is its last transition
 * (always past) and a follow-up's is when it fires (usually future), so paging
 * outstanding work newest-first puts every scheduled follow-up ahead of every
 * running delegation: with a page of 50, a workspace with 50 future follow-ups
 * shows no delegation at all until the last page.
 */
export function isAgendaOrder(state: AgentOutcomeState): boolean {
  return state === "outstanding"
}

function toSummary(row: AgentOutcomeRow): AgentOutcomeSummary {
  const base = {
    id: row.id,
    streamId: row.streamId,
    title: row.title,
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    claimedByLabel: row.claimedByLabel,
    statusNote: row.statusNote,
    resultMessageId: row.resultMessageId,
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
    statusChangedAt: row.statusChangedAt.toISOString(),
    occursAt: row.occursAt.toISOString(),
    anchorEventId: row.anchorEventId,
  }
  switch (row.kind) {
    case "follow_up":
      return { ...base, kind: "follow_up", status: row.status as FollowUpStatus }
    case "delegation":
      return { ...base, kind: "delegation", status: row.status as DelegationStatus }
    case "subagent":
      return {
        ...base,
        kind: "subagent",
        status: row.status as SubagentStatus,
        lastAgentMessageAt: row.lastAgentMessageAt,
      }
  }
}

/**
 * The cross-stream read over agent-owned work. Access is resolved inside the
 * statement through `streamAccessPredicateSql` (INV-62), so there is nothing to
 * gate here: a stream the viewer cannot read contributes no rows. One query per
 * page ⇒ `pool`, not `withClient` (INV-30).
 */
export function createAgentOutcomeService({ pool }: Dependencies) {
  return {
    async list(params: ListAgentOutcomesParams): Promise<ListAgentOutcomesResponse> {
      const cursor = decodeKeysetCursor(params.cursor)
      const filters = {
        workspaceId: params.workspaceId,
        userId: params.userId,
        streamIds: params.streamIds,
        scope: params.scope,
        kind: params.kind,
        queryText: params.queryText,
        ...statusesForState(params.state),
      }

      const rows = await AgentOutcomeReadRepository.list(pool, {
        ...filters,
        cursor,
        limit: params.limit + 1,
        ascending: isAgendaOrder(params.state),
      })
      const hasMore = rows.length > params.limit
      const visible = hasMore ? rows.slice(0, params.limit) : rows
      const last = visible[visible.length - 1]

      // The count is the whole-scope outstanding total the sidebar reads, so it
      // ignores the requested `state` — and it is a second full scan, so only a
      // caller that asked for it on a first page pays for it.
      const outstandingCount =
        params.withCount && !cursor
          ? await AgentOutcomeReadRepository.count(pool, { ...filters, ...statusesForState("outstanding") })
          : null

      return {
        items: visible.map(toSummary),
        nextCursor: hasMore && last ? encodeKeysetCursor({ at: last.occursAtKey, id: last.id }) : null,
        outstandingCount,
      }
    },
  }
}

export type AgentOutcomeService = ReturnType<typeof createAgentOutcomeService>
