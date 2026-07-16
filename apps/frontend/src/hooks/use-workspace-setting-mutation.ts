import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { UpdateWorkspaceSettingsInput, WorkspaceBootstrap, WorkspaceSettings } from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"

/**
 * Save one workspace setting and reflect it optimistically in the bootstrap
 * cache — the single read path every settings surface observes, and what the
 * `workspace_settings:updated` broadcast writes to.
 *
 * The optimistic write is what makes the control feel committed without a
 * success toast (INV-63); a failure rolls the cache back and says so.
 */
export function useWorkspaceSettingMutation<K extends keyof UpdateWorkspaceSettingsInput>(
  workspaceId: string,
  key: K,
  errorMessage: string,
  /** Runs after the cache rollback — for surfaces holding the value in local state too. */
  options?: { onError?: () => void }
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (value: NonNullable<UpdateWorkspaceSettingsInput[K]>) =>
      workspaceSettingsApi.update(workspaceId, { [key]: value } as UpdateWorkspaceSettingsInput),
    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      let previousSettings: WorkspaceSettings | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        previousSettings = old?.workspaceSettings ?? null
        return old?.workspaceSettings ? { ...old, workspaceSettings: { ...old.workspaceSettings, [key]: value } } : old
      })
      return { previousSettings }
    },
    onError: (_err, _value, context) => {
      if (context?.previousSettings) {
        const restored = context.previousSettings
        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old ? { ...old, workspaceSettings: restored } : old
        )
      }
      options?.onError?.()
      toast.error(errorMessage)
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: saved } : old
      )
    },
  })
}
