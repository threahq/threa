import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { UpdateWorkspaceSettingsInput, WorkspaceBootstrap, WorkspaceSettings } from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"

/** Any stored settings value — the hook is key-generic, so it never sees a narrower type. */
type SettingValue = WorkspaceSettings[keyof UpdateWorkspaceSettingsInput & keyof WorkspaceSettings]

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
      let previous: { value: SettingValue } | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old?.workspaceSettings) return old
        previous = { value: (old.workspaceSettings as unknown as Record<string, SettingValue>)[key] }
        return { ...old, workspaceSettings: { ...old.workspaceSettings, [key]: value } }
      })
      return { previous: previous as { value: SettingValue } | null }
    },
    onError: (_err, _value, context) => {
      // Roll back only this key. Restoring the whole snapshot would revert any
      // other setting that changed while this save was in flight — a concurrent
      // admin's edit, or the `workspace_settings:updated` broadcast.
      if (context?.previous) {
        const restored = context.previous.value
        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old?.workspaceSettings ? { ...old, workspaceSettings: { ...old.workspaceSettings, [key]: restored } } : old
        )
      }
      options?.onError?.()
      toast.error(errorMessage)
    },
    onSuccess: (saved) => {
      // Same reason, inverted: the response is authoritative for committed state,
      // but a sibling mutation still in flight is not in it yet, so take only the
      // key this mutation owns. The broadcast reconciles the rest.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old?.workspaceSettings
          ? { ...old, workspaceSettings: { ...old.workspaceSettings, [key]: saved[key as keyof WorkspaceSettings] } }
          : old
      )
    },
  })
}
