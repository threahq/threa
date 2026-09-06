import type { AgentOutcomeKind, AgentOutcomeScope, AgentOutcomeState, ListAgentOutcomesResponse } from "@threahq/types"
import { api } from "./client"

export interface AgentOutcomeFilters {
  /** Stream scope; empty = whole workspace. */
  streamIds?: string[]
  /** Default `tree`: each scoped id also matches its threads. `stream` matches exactly. */
  scope?: AgentOutcomeScope
  state?: AgentOutcomeState
  kind?: AgentOutcomeKind
  queryText?: string
  cursor?: string
  limit?: number
  /** Opt in to `outstandingCount`; it costs a second whole-scope scan. */
  withCount?: boolean
}

/**
 * The cross-stream read over agent-owned work — scheduled follow-ups and
 * delegated tasks, interleaved on when the work matters (`occursAt`). Rows are
 * authoritative: statuses live in the tables, never in the loaded timeline
 * window.
 */
export const agentOutcomesApi = {
  async list(workspaceId: string, filters: AgentOutcomeFilters = {}): Promise<ListAgentOutcomesResponse> {
    const params = new URLSearchParams()
    if (filters.streamIds?.length) params.set("streams", filters.streamIds.join(","))
    if (filters.scope) params.set("scope", filters.scope)
    if (filters.state) params.set("state", filters.state)
    if (filters.kind) params.set("kind", filters.kind)
    if (filters.queryText) params.set("q", filters.queryText)
    if (filters.cursor) params.set("cursor", filters.cursor)
    if (filters.limit) params.set("limit", String(filters.limit))
    if (filters.withCount) params.set("withCount", "true")
    const query = params.toString()
    return api.get<ListAgentOutcomesResponse>(
      `/api/workspaces/${workspaceId}/agent-outcomes${query ? `?${query}` : ""}`
    )
  },
}
