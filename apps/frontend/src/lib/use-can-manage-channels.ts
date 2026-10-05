import { rolesGrant, WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { useCurrentWorkspaceUser, useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "./permissions"

/**
 * Guests (no `workspace:browse`) neither create channels nor change their settings. Until the
 * bootstrap lands, the cached viewer row's role answers, so a warm load doesn't pop the controls in
 * (INV-21).
 */
export function useCanManageChannels(workspaceId: string): boolean {
  const viewerPermissions = useViewerPermissions(workspaceId)
  const viewer = useCurrentWorkspaceUser(workspaceId)
  if (viewerPermissions) return hasPermission(viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE)
  return viewer !== null && rolesGrant([viewer.role], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE)
}
