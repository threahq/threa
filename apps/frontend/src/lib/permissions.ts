import type { WorkspacePermissionSlug } from "@threahq/types"

/**
 * Checks whether the current viewer holds a specific workspace permission.
 *
 * @param viewerPermissions - Permission slugs from `WorkspaceBootstrap.viewerPermissions`.
 * @param slug - Permission slug to check.
 * @returns `true` when `slug` is present, otherwise `false`.
 *
 * @example
 * if (hasPermission(viewerPermissions, "members:write")) {
 *   // render the role picker
 * }
 */
export function hasPermission(
  viewerPermissions: readonly WorkspacePermissionSlug[] | undefined,
  slug: WorkspacePermissionSlug
): boolean {
  return viewerPermissions?.includes(slug) ?? false
}
