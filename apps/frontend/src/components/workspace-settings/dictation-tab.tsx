import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WORKSPACE_PERMISSION_SCOPES,
  VOICE_STEERING_BASE_TERMS,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
} from "@threahq/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { SteeringWordsEditor } from "@/components/settings/steering-words-editor"

const BAKED_IN_LABEL = VOICE_STEERING_BASE_TERMS.join(", ")

interface DictationTabProps {
  workspaceId: string
}

/**
 * Workspace-shared dictation steering words. Every member's dictation is biased
 * toward this list (plus the baked-in product terms and their own personal
 * list). Editing is gated to admins; others see it read-only.
 */
export function DictationTab({ workspaceId }: DictationTabProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null

  const mutation = useMutation({
    mutationFn: (voiceSteeringWords: string[]) => workspaceSettingsApi.update(workspaceId, { voiceSteeringWords }),
    onMutate: async (voiceSteeringWords) => {
      // Optimistic: reflect the chip immediately, like the per-user editor.
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      // Capture the rollback snapshot from the LIVE cache inside the updater —
      // the reactive `settings` closure can lag a rapid second edit, which would
      // roll back to a stale list. (setQueryData's `old` is the current cache;
      // the lint rule only bans reading via getQueryData.)
      let previousSettings: WorkspaceSettings | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        previousSettings = old?.workspaceSettings ?? null
        return old?.workspaceSettings
          ? { ...old, workspaceSettings: { ...old.workspaceSettings, voiceSteeringWords } }
          : old
      })
      return { previousSettings }
    },
    onError: (_err, _next, context) => {
      if (context?.previousSettings) {
        const restored = context.previousSettings
        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old ? { ...old, workspaceSettings: restored } : old
        )
      }
      toast.error("Failed to save workspace steering words")
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: saved } : old
      )
    },
  })

  return (
    <div className="p-1">
      <SteeringWordsEditor
        title="Workspace steering words"
        description={
          <>
            Shared spellings the dictation model is nudged toward for everyone in this workspace — product names,
            people, domain jargon. Each member can add their own on top in their personal settings. {BAKED_IN_LABEL} are
            always included.
          </>
        }
        words={settings?.voiceSteeringWords ?? []}
        ready={settings != null}
        busy={mutation.isPending}
        canEdit={canManage}
        readOnlyNote="Only workspace admins can change the shared steering words."
        onChange={(next) => mutation.mutate(next)}
      />
    </div>
  )
}
