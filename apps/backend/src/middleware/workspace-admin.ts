import type { Request } from "express"
import { WORKSPACE_PERMISSION_SCOPES, permissionsForRole } from "@threahq/types"

/**
 * Workspace admin, resolved the way the route middleware resolves permissions: the session JWT's claim
 * when present, else the user's role. A user API key acts as its user; a bot key is never an admin.
 */
export function callerIsWorkspaceAdmin(req: Request): boolean {
  const admin = WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN
  return (
    req.authUser?.permissions?.includes(admin) ??
    (req.user != null && (permissionsForRole(req.user.role) as readonly string[]).includes(admin)) ??
    false
  )
}
