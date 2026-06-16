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
