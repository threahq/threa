import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { User, WorkspaceBootstrap, WorkspaceRoleSlug } from "@threahq/types"
import { workspaceMembersApi } from "@/api/workspace-members"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"

// The bootstrap query cache mirrors the IDB tables the publication gate diffs;
// an optimistic write that touches only IDB would leave the cache stale behind
// an anyChanged=false apply if the reconciling broadcast is lost.
function patchBootstrapUsers(queryClient: QueryClient, workspaceId: string, update: (users: User[]) => User[]): void {
  queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (prev) =>
    prev ? { ...prev, users: update(prev.users) } : prev
  )
}

// Server is the source of truth; the regional event poller reconciles Dexie
// within a few seconds, so optimistic writes only need to survive that
// window.
export function useChangeWorkspaceMemberRole(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { userId: string; roleSlug: WorkspaceRoleSlug }) => {
      await workspaceMembersApi.changeRole(workspaceId, params.userId, params.roleSlug)
      return params
    },
    onMutate: async ({ userId, roleSlug }) => {
      const current = await db.workspaceUsers.get(userId)
      if (!current || current.role === roleSlug) {
        return { previousRole: current?.role ?? null }
      }
      await db.workspaceUsers.put({ ...current, role: roleSlug, _cachedAt: Date.now() })
      patchBootstrapUsers(queryClient, workspaceId, (users) =>
        users.map((user) => (user.id === userId ? { ...user, role: roleSlug } : user))
      )
      return { previousRole: current.role }
    },
    onError: async (_err, { userId }, context) => {
      if (!context?.previousRole) return
      const previousRole = context.previousRole
      const current = await db.workspaceUsers.get(userId)
      if (current) {
        void db.workspaceUsers.put({ ...current, role: previousRole, _cachedAt: Date.now() })
      }
      patchBootstrapUsers(queryClient, workspaceId, (users) =>
        users.map((user) => (user.id === userId ? { ...user, role: previousRole } : user))
      )
    },
  })
}

export function useRemoveWorkspaceMember(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { userId: string }) => {
      await workspaceMembersApi.remove(workspaceId, params.userId)
      return params
    },
    onMutate: async ({ userId }) => {
      const snapshot = await db.workspaceUsers.get(userId)
      if (snapshot) {
        await db.workspaceUsers.delete(userId)
      }
      const previousUser = queryClient
        .getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId))
        ?.users.find((user) => user.id === userId)
      patchBootstrapUsers(queryClient, workspaceId, (users) => users.filter((user) => user.id !== userId))
      return { snapshot, previousUser }
    },
    onError: (_err, _vars, context) => {
      if (context?.snapshot) {
        void db.workspaceUsers.put(context.snapshot)
      }
      const previousUser = context?.previousUser
      if (previousUser) {
        patchBootstrapUsers(queryClient, workspaceId, (users) =>
          users.some((user) => user.id === previousUser.id) ? users : [...users, previousUser]
        )
      }
    },
  })
}
