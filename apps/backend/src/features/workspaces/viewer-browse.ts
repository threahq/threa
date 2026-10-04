import type { QueryConfig } from "pg"
import { WORKSPACE_PERMISSION_SCOPES, WORKSPACE_ROLE_DEFINITIONS, type WorkspacePermissionSlug } from "@threahq/types"
import type { Querier } from "../../db"
import { composeSql, sql } from "../../db"
import { KNOWN_ROLE_SLUGS, USERS_FROM_FRAGMENT } from "./user-repository"

function roleSlugsHolding(scope: WorkspacePermissionSlug): string[] {
  return WORKSPACE_ROLE_DEFINITIONS.filter((role) => role.permissions.includes(scope)).map((role) => role.slug)
}

const BROWSE_ROLE_SLUGS = roleSlugsHolding(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE)
const ADMIN_ROLE_SLUGS = roleSlugsHolding(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)

/**
 * A permission is read from the user row, never the JWT claim: sessions minted before the scope
 * existed lack it until refresh. Roles resolve like `expandRoleSlugs`: an active mirror row holding
 * any known slug decides, otherwise `users.role` does. Ids that are not user rows (bots, personas,
 * system) match no row, so they never lack the permission.
 */
function viewersLackingRoleSlugsSql(
  workspaceId: string,
  holdingRoleSlugs: readonly string[],
  viewerFilter: QueryConfig
): QueryConfig {
  return composeSql`FROM ${USERS_FROM_FRAGMENT}
    WHERE u.workspace_id = ${workspaceId}
      AND ${viewerFilter}
      AND NOT (
        CASE WHEN wup.role_slugs && ${[...KNOWN_ROLE_SLUGS]}::text[]
          THEN wup.role_slugs && ${holdingRoleSlugs as string[]}::text[]
          ELSE u.role = ANY(${holdingRoleSlugs as string[]}::text[])
        END
      )`
}

function viewersLackingBrowseSql(workspaceId: string, viewerFilter: QueryConfig): QueryConfig {
  return viewersLackingRoleSlugsSql(workspaceId, BROWSE_ROLE_SLUGS, viewerFilter)
}

/**
 * True when `userId` is a user of the workspace without the browse permission. A string id is
 * uncorrelated, so the planner evaluates it once per statement however many rows the outer query
 * scans; a `QueryConfig` column reference correlates to the outer row and must not name `u` or `wup`.
 */
export function viewerLacksBrowseSql(workspaceId: string, userId: string | QueryConfig): QueryConfig {
  return composeSql`EXISTS (SELECT 1 ${viewersLackingBrowseSql(workspaceId, composeSql`u.id = ${userId}`)})`
}

/** One column of ids: every user of the workspace without browse. */
export function userIdsLackingBrowseSql(workspaceId: string): QueryConfig {
  return composeSql`SELECT u.id ${viewersLackingBrowseSql(workspaceId, sql`TRUE`)}`
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

/** The ids among `userIds` that are users of the workspace without the admin permission. */
export async function findUserIdsWithoutAdmin(
  db: Querier,
  workspaceId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const result = await db.query<{ id: string }>(
    composeSql`SELECT u.id ${viewersLackingRoleSlugsSql(workspaceId, ADMIN_ROLE_SLUGS, sql`u.id = ANY(${userIds as string[]})`)}`
  )
  return new Set(result.rows.map((row) => row.id))
}
