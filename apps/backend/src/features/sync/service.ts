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
      // Read entries FIRST, then head + retention floor in one query. Order
      // matters for race-safety: if a prune advanced the floor past `after`,
      // it did so atomically with deleting the entries (pruneExpiredEntries),
      // so a floor read that follows the entries read is guaranteed to observe
      // the advance whenever the entries read saw the deletion — we then
      // bootstrap instead of returning a page that silently omits the pruned
      // span. Reading the floor first would reopen that gap (INV-20).
      const entries = await SyncLogRepository.listEntriesForUser(client, params)
      const { head, retainedFrom } = await SyncLogRepository.getHeadAndRetainedFrom(client, params.workspaceId)
      // A cursor strictly below the floor needs pruned entries the log can no
      // longer replay; the surviving page would drop the gap, so signal a full
      // bootstrap (head is still returned so head-probe seed calls work below
      // the floor). after == retainedFrom is in-window: retainedFrom is the
      // highest PRUNED id, so everything strictly above it still exists.
      if (params.after < retainedFrom) {
        return { entries: [], head, requiresBootstrap: true }
      }
      return { entries, head }
    })
  }
}
