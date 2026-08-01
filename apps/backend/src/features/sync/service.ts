import type { Pool } from "pg"
import { withClient } from "../../db"
import { SyncLogRepository, type SyncLogEntry } from "./repository"
import { sanitizeSyncEntries } from "./sanitize"

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
  async catchUp(params: {
    workspaceId: string
    userId: string
    permissionGroups: string[]
    after: bigint
    limit: number
  }): Promise<CatchUpResult> {
    return withClient(this.pool, async (client) => {
      // Read entries FIRST, then the floor (INV-20): a prune advances the floor
      // atomically with deleting the entries (pruneExpiredEntries), so a floor
      // read that follows the entries read observes the advance whenever the
      // entries read saw the deletion — we then bootstrap instead of returning a
      // page that silently omits the pruned span. Floor-first reopens that gap.
      const entries = await SyncLogRepository.listEntriesForUser(client, params)
      const { head, retainedFrom } = await SyncLogRepository.getHeadAndRetainedFrom(client, params.workspaceId)
      // A cursor strictly below the floor needs pruned entries the log can no
      // longer replay, so bootstrap (head is still returned so head-probe seed
      // calls work below the floor). after == retainedFrom is in-window:
      // retainedFrom is the highest PRUNED id, so everything above it survives.
      if (params.after < retainedFrom) {
        return { entries: [], head, requiresBootstrap: true }
      }
      // Stored payloads snapshot access-gated content (hydrated share slots,
      // memo summaries) at write time; replaying them verbatim within the
      // retention window would freshly deliver content the viewer or room may
      // no longer see. Re-resolved here, at serve time.
      return {
        entries: await sanitizeSyncEntries(client, {
          workspaceId: params.workspaceId,
          userId: params.userId,
          entries,
        }),
        head,
      }
    })
  }
}
