import type { Pool } from "pg"
import { withClient } from "../../db"
import { SyncLogRepository, type SyncLogEntry } from "./repository"

export interface CatchUpResult {
  entries: SyncLogEntry[]
  head: bigint
}

export class SyncService {
  private readonly pool: Pool

  constructor(deps: { pool: Pool }) {
    this.pool = deps.pool
  }

  /**
   * Returns log entries after the client's cursor plus the workspace head.
   *
   * `head` is read AFTER the entries query, so it is always ≥ the last
   * returned entry. Clients advance their cursor only by applied entries
   * (never by jumping to `head`) and page until a fetch comes back empty —
   * `head` is a freshness hint, not a cursor target.
   */
  async catchUp(params: { workspaceId: string; userId: string; after: bigint; limit: number }): Promise<CatchUpResult> {
    return withClient(this.pool, async (client) => {
      const entries = await SyncLogRepository.listEntriesForUser(client, params)
      const head = await SyncLogRepository.getHead(client, params.workspaceId)
      return { entries, head }
    })
  }
}
