import { BotsTab } from "@/components/workspace-settings/bots-tab"
import { UserApiKeysSection } from "@/components/workspace-settings/user-api-keys-section"
import { SettingsSection } from "./setting-primitives"

export function DeveloperSettings({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="space-y-8">
      <SettingsSection section="dev-keys">
        <UserApiKeysSection workspaceId={workspaceId} />
      </SettingsSection>

      <SettingsSection section="dev-bots">
        <BotsTab workspaceId={workspaceId} scope="personal" />
      </SettingsSection>
    </div>
  )
}
