import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { SteeringWordsEditor } from "@/components/settings/steering-words-editor"
import { SettingsSection } from "@/components/settings/setting-primitives"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface DictationTabProps {
  workspaceId: string
}

export function DictationTab({ workspaceId }: DictationTabProps) {
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "voiceSteeringWords",
    "Failed to save workspace steering words"
  )

  return (
    <SettingsSection section="defaults-voice">
      <SteeringWordsEditor
        setting="shared-steering-words"
        description={accessDescription("shared-steering-words", access)}
        words={settings?.voiceSteeringWords ?? []}
        ready={settings != null}
        busy={mutation.isPending}
        canEdit={access.allowed}
        onChange={(next) => mutation.mutate(next)}
      />
    </SettingsSection>
  )
}
