import type { QueryConfig } from "pg"
import { WORKSPACE_PERMISSION_SCOPES, WORKSPACE_ROLE_DEFINITIONS } from "@threahq/types"
import type { Querier } from "../../db"
import { composeSql, sql } from "../../db"
import { KNOWN_ROLE_SLUGS, USERS_FROM_FRAGMENT } from "./user-repository"

const BROWSE_ROLE_SLUGS: string[] = WORKSPACE_ROLE_DEFINITIONS.filter((role) =>
  role.permissions.includes(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE)
).map((role) => role.slug)

/**
 * Browse is read from the user row, never the JWT claim: sessions minted before the scope existed
 * lack it until refresh. Roles resolve like `expandRoleSlugs`: an active mirror row holding any
 * known slug decides, otherwise `users.role` does. Ids that are not user rows (bots, personas,
 * system) match no row, so they never lack browse.
 */
function viewersLackingBrowseSql(workspaceId: string, viewerFilter: QueryConfig): QueryConfig {
  return composeSql`FROM ${USERS_FROM_FRAGMENT}
    WHERE u.workspace_id = ${workspaceId}
      AND ${viewerFilter}
      AND NOT (
        CASE WHEN wup.role_slugs && ${[...KNOWN_ROLE_SLUGS]}::text[]
          THEN wup.role_slugs && ${BROWSE_ROLE_SLUGS}::text[]
          ELSE u.role = ANY(${BROWSE_ROLE_SLUGS}::text[])
        END
      )`
}

/**
 * True when `userId` is a user of the workspace without the browse permission. Uncorrelated, so
 * the planner evaluates it once per statement however many rows the outer query scans.
 */
export function viewerLacksBrowseSql(workspaceId: string, userId: string): QueryConfig {
  return composeSql`EXISTS (SELECT 1 ${viewersLackingBrowseSql(workspaceId, sql`u.id = ${userId}`)})`
}

/** True when any user `userIdsSql` selects (one column of ids) lacks browse; false for an empty selection. */
export function anyUserLacksBrowseSql(workspaceId: string, userIdsSql: QueryConfig): QueryConfig {
  return composeSql`EXISTS (SELECT 1 ${viewersLackingBrowseSql(workspaceId, composeSql`u.id IN (${userIdsSql})`)})`
}

export async function findUserIdsWithoutBrowse(
  db: Querier,
  workspaceId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(
    composeSql`SELECT u.id ${viewersLackingBrowseSql(workspaceId, sql`u.id = ANY(${userIds as string[]})`)}`
  )
  return new Set(result.rows.map((row) => row.id))
}
