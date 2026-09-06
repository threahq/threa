import type { Pool } from "pg"
import { HttpError } from "@threa/backend-common"
import type { SearchClickKind } from "@threa/types"
import { searchQueryLogId } from "../../lib/id"
import { SearchQueryLogRepository, type InsertSearchQueryLogInput } from "./query-log-repository"

export type RecordSearchQueryInput = Omit<InsertSearchQueryLogInput, "id">

/**
 * The opt-in search query log. The caller decides whether the user consented
 * (the `searchQueryLog` flag); this only writes and attributes clicks.
 */
export class SearchQueryLogService {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordSearchQueryInput): Promise<{ id: string }> {
    const id = searchQueryLogId()
    await SearchQueryLogRepository.insert(this.pool, { id, ...input })
    return { id }
  }

  async recordClick(params: {
    workspaceId: string
    userId: string
    id: string
    kind: SearchClickKind
    targetId: string
  }): Promise<void> {
    const updated = await SearchQueryLogRepository.recordClick(this.pool, params)
    if (!updated) {
      throw new HttpError("Search query log entry not found, or the target was not among its results", {
        status: 404,
        code: "SEARCH_QUERY_LOG_NOT_FOUND",
      })
    }
  }
}
