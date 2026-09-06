import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
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
 * on every unpinned scratchpad going forward.
 */
export function DefaultCompanionSection({ workspaceId }: DefaultCompanionSectionProps) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const { data: personas } = usePersonas(workspaceId)

  // Resolve the stored id (null = Ariadne) against the roster so the trigger and
  // the read-only fallback both name the persona that actually runs.
  const { selectedPersonaId, companionName } = resolveCompanionSelection(personas, settings?.defaultCompanionPersonaId)

  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "defaultCompanionPersonaId",
    "Failed to save the default companion"
  )

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
