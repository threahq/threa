import type { Pool } from "pg"
import { withClient } from "../../db"
import { SyncLogRepository, type SyncLogEntry } from "./repository"

export interface CatchUpResult {
  entries: SyncLogEntry[]
  head: bigint
  /**
   * The cursor is below the retained sync-log floor (its entries were pruned
   * by retention). `entries` is empty; the client must full-bootstrap. See
   * docs/plans/sync-v2-log-retention.md.
   */
  requiresBootstrap?: boolean
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
      // A cursor strictly below the retained floor needs entries that
      // retention has pruned: replaying the partial page that survives would
      // silently drop the pruned span, so signal a full bootstrap instead.
      // `head` is still read so head-probe callers (cursor seeding) work even
      // below the floor. (after == retainedFrom is fine: retainedFrom is the
      // highest pruned id, so everything strictly above it still exists.)
      const retainedFrom = await SyncLogRepository.getRetainedFrom(client, params.workspaceId)
      if (params.after < retainedFrom) {
        const head = await SyncLogRepository.getHead(client, params.workspaceId)
        return { entries: [], head, requiresBootstrap: true }
      }
      const entries = await SyncLogRepository.listEntriesForUser(client, params)
      const head = await SyncLogRepository.getHead(client, params.workspaceId)
      return { entries, head }
    })
  }
}
