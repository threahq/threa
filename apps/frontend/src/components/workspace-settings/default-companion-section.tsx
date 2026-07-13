import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { WORKSPACE_PERMISSION_SCOPES, type WorkspaceBootstrap, type WorkspaceSettings } from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { usePersonas } from "@/hooks/use-personas"
import { hasPermission } from "@/lib/permissions"
import { Label } from "@/components/ui/label"
import { CompanionAgentSelect, resolveCompanionSelection } from "@/components/stream-settings/companion-agent-select"

interface DefaultCompanionSectionProps {
  workspaceId: string
}

/**
 * Workspace default companion persona: which agent unpinned scratchpads run when
 * neither the user nor the stream has picked one. Editing is admin-gated; others
 * see the resolved name read-only. Applied at dispatch, so a change takes effect
 * on every unpinned scratchpad going forward. Mirrors `FollowUpLimitSection`'s
 * optimistic bootstrap-cache plumbing.
 */
export function DefaultCompanionSection({ workspaceId }: DefaultCompanionSectionProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const { data: personas } = usePersonas(workspaceId)

  // Resolve the stored id (null = Ariadne) against the roster so the trigger and
  // the read-only fallback both name the persona that actually runs.
  const { selectedPersonaId, companionName } = resolveCompanionSelection(personas, settings?.defaultCompanionPersonaId)

  const mutation = useMutation({
    mutationFn: (defaultCompanionPersonaId: string) =>
      workspaceSettingsApi.update(workspaceId, { defaultCompanionPersonaId }),
    onMutate: async (defaultCompanionPersonaId) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      let previousSettings: WorkspaceSettings | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        previousSettings = old?.workspaceSettings ?? null
        return old?.workspaceSettings
          ? { ...old, workspaceSettings: { ...old.workspaceSettings, defaultCompanionPersonaId } }
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
      toast.error("Failed to save the default companion")
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: saved } : old
      )
    },
  })

  return (
    <div>
      <Label className="text-sm font-medium">Default companion</Label>
      <p className="text-xs text-muted-foreground mt-0.5">
        The agent that answers in scratchpads where neither the scratchpad nor the member has picked one.
      </p>
      {canManage && personas && personas.length > 0 ? (
        <CompanionAgentSelect
          workspaceId={workspaceId}
          personas={personas}
          value={selectedPersonaId}
          onChange={(personaId) => mutation.mutate(personaId)}
          disabled={settings == null || mutation.isPending}
          triggerClassName="mt-2 w-full sm:w-72"
        />
      ) : (
        <p className="text-sm text-muted-foreground mt-2">{companionName}</p>
      )}
    </div>
  )
}
