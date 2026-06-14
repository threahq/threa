import { useMemo } from "react"
import { useAuth } from "@/auth"
import { useWorkspaceUsers } from "@/stores/workspace-store"

/**
 * Resolve the current viewer's workspace-scoped user id (`UserId`, INV-50), or
 * null while it can't be resolved yet. The auth `user.id` is the global WorkOS
 * id; the workspace-scoped id is the matching `users` row for this workspace.
 *
 * Several surfaces need this mapping (labels, drafts, …); it lives here so they
 * don't each re-derive the `workosUserId` lookup by hand and drift — the same
 * footgun the stream-name resolver warns about in `apps/frontend/CLAUDE.md`.
 */
export function useCurrentWorkspaceUserId(workspaceId: string): string | null {
  const { user } = useAuth()
  const workspaceUsers = useWorkspaceUsers(workspaceId)
  return useMemo(() => {
    if (!user) return null
    return workspaceUsers.find((u) => u.workosUserId === user.id)?.id ?? null
  }, [user, workspaceUsers])
}
