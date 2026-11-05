import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { usePersonas } from "@/hooks/use-personas"
import { CompanionAgentSelect, resolveCompanionSelection } from "@/components/stream-settings/companion-agent-select"
import {
  SETTING_CONTROL_CLASS,
  SETTING_CONTROL_WIDTH,
  SettingRow,
  SettingValue,
  settingIds,
} from "@/components/settings/setting-primitives"
import { GatedControl, accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface DefaultCompanionSectionProps {
  workspaceId: string
}

/** A scratchpad pins its agent when it's created, so a change only reaches new scratchpads. */
export function DefaultCompanionSection({ workspaceId }: DefaultCompanionSectionProps) {
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
  const { data: personas } = usePersonas(workspaceId)

  // Resolve the stored id (null = Ariadne) against the roster so the trigger and
  // the read-only fallback both name the persona that actually runs.
  const { selectedPersonaId, companionName } = resolveCompanionSelection(personas, settings?.defaultCompanionPersonaId)

  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "defaultCompanionPersonaId",
    "Couldn't save the default agent"
  )

  const ids = settingIds("workspace-default-companion")
  return (
    <SettingRow
      setting="workspace-default-companion"
      labelFor={false}
      description={accessDescription("workspace-default-companion", access)}
      control={
        <GatedControl access={access} readOnly={companionName}>
          {personas && personas.length > 0 ? (
            <CompanionAgentSelect
              workspaceId={workspaceId}
              personas={personas}
              value={selectedPersonaId}
              onChange={(personaId) => mutation.mutate(personaId)}
              disabled={settings == null || mutation.isPending}
              triggerClassName={SETTING_CONTROL_CLASS}
              aria-labelledby={ids.label}
              aria-describedby={ids.description}
            />
          ) : (
            <SettingValue className={SETTING_CONTROL_WIDTH}>{companionName}</SettingValue>
          )}
        </GatedControl>
      }
    />
  )
}
