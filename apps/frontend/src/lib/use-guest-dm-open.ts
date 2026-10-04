import { useCallback, useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  DEFAULT_WORKSPACE_SETTINGS,
  WORKSPACE_PERMISSION_SCOPES,
  isGuestDmOpen,
  rolesGrant,
  type DmParty,
  type WorkspaceBootstrap,
} from "@threahq/types"
import { useCurrentWorkspaceUser, workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceUsers } from "@/stores/workspace-store"

const NOT_A_GUEST: DmParty = { guest: false, admin: false }

/**
 * Whether the guest DM policy leaves a DM between the viewer and `peerUserIds` open, the same rule
 * the backend enforces on creating and posting to a DM. Ids that are no workspace user (bots,
 * personas) and a viewer who has not resolved yet are neither guest nor admin, so a guest peer
 * still closes the pair under `admins`. Until the bootstrap lands the policy is the closed default.
 */
export function useGuestDmOpen(workspaceId: string): (peerUserIds: readonly string[]) => boolean {
  const queryClient = useQueryClient()
  const { data: policy } = useQuery({
    queryKey: workspaceKeys.bootstrap(workspaceId),
    queryFn: () => queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId)) ?? null,
    enabled: false,
    staleTime: Infinity,
    select: (bootstrap) => bootstrap?.workspaceSettings?.guestDmPolicy ?? DEFAULT_WORKSPACE_SETTINGS.guestDmPolicy,
  })
  const viewerId = useCurrentWorkspaceUser(workspaceId)?.id ?? null
  const users = useWorkspaceUsers(workspaceId)
  const partyById = useMemo(
    () =>
      new Map<string, DmParty>(
        users.map((user) => [
          user.id,
          {
            guest: !rolesGrant([user.role], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_BROWSE),
            admin: rolesGrant([user.role], WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN),
          },
        ])
      ),
    [users]
  )

  return useCallback(
    (peerUserIds) => {
      const parties = [viewerId, ...peerUserIds].map((id) => (id && partyById.get(id)) || NOT_A_GUEST)
      return isGuestDmOpen(policy ?? DEFAULT_WORKSPACE_SETTINGS.guestDmPolicy, parties)
    },
    [policy, viewerId, partyById]
  )
}
