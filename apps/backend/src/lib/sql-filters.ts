export type ArchiveStatus = "active" | "archived"

/**
 * Parse archive status filter array into query-friendly flags.
 *
 * Semantics:
 * - undefined/empty → active only (default)
 * - ["active"] → active only
 * - ["archived"] → archived only
 * - ["active", "archived"] → all (no filter needed)
 */
export function parseArchiveStatusFilter(archiveStatus?: ArchiveStatus[]): {
  includeActive: boolean
  includeArchived: boolean
  filterAll: boolean
} {
  const includeActive = !archiveStatus || archiveStatus.length === 0 || archiveStatus.includes("active")
  const includeArchived = archiveStatus?.includes("archived") ?? false
  const filterAll = includeActive && includeArchived

  return { includeActive, includeArchived, filterAll }
}

/**
 * Nesting bound for the ancestor walk. Threads nest under threads without a
 * schema limit, so the cap is only there to stop a corrupt `parent_stream_id`
 * cycle from spinning (INV-1: no FK keeps the chain acyclic).
 */
const MAX_STREAM_CHAIN_DEPTH = 32

/**
 * TRUE when the `streams` row aliased `alias` is archived itself or sits under
 * an archived ancestor anywhere up `parent_stream_id`: a thread in an archived
 * thread, a thread in an archived channel, an aside on an archived host.
 * Archiving writes only the target row; the inheritance is computed here on
 * every read and never cascaded, so unarchiving the ancestor releases the
 * subtree with no second write. Correlated: usable as a WHERE predicate.
 */
export function effectivelyArchivedSql(alias: string): string {
  return `EXISTS (
    WITH RECURSIVE archival_chain AS (
      SELECT c0.parent_stream_id, c0.archived_at, 0 AS depth
      FROM streams c0
      WHERE c0.id = ${alias}.id
      UNION ALL
      SELECT p.parent_stream_id, p.archived_at, c.depth + 1
      FROM archival_chain c
      JOIN streams p ON p.id = c.parent_stream_id
      WHERE c.depth < ${MAX_STREAM_CHAIN_DEPTH}
    )
    SELECT 1 FROM archival_chain WHERE archival_chain.archived_at IS NOT NULL
  )`
}

/**
 * WHERE fragment for an `archiveStatus` filter over `streams` rows aliased
 * `alias`. "active" means not sealed anywhere up the chain. "archived" means
 * the row's own flag: the archived list shows what was archived, not every
 * descendant sealed by it. `archivedIncludesSealed` widens "archived" to the
 * whole sealed subtree, which is what a search over archived content wants.
 */
export function archiveStatusSql(
  alias: string,
  archiveStatus?: ArchiveStatus[],
  options?: { archivedIncludesSealed?: boolean }
): string {
  const { includeArchived, filterAll } = parseArchiveStatusFilter(archiveStatus)
  if (filterAll) return "TRUE"
  const sealed = effectivelyArchivedSql(alias)
  if (!includeArchived) return `NOT ${sealed}`
  return options?.archivedIncludesSealed ? sealed : `${alias}.archived_at IS NOT NULL`
}
