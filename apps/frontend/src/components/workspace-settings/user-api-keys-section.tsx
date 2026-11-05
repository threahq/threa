import { userApiKeyKeys, workspacesApi } from "@/api/workspaces"
import { SettingRow } from "@/components/settings/setting-primitives"
import { ApiKeysPanel } from "./api-keys-panel"

interface UserApiKeysSectionProps {
  workspaceId: string
}

export function UserApiKeysSection({ workspaceId }: UserApiKeysSectionProps) {
  return (
    <ApiKeysPanel
      source={{
        queryKey: userApiKeyKeys.list(workspaceId),
        secretPrefix: "threa_uk_",
        list: () => workspacesApi.listUserApiKeys(workspaceId),
        create: (input) => workspacesApi.createUserApiKey(workspaceId, input),
        updateScopes: (keyId, scopes) => workspacesApi.updateUserApiKeyScopes(workspaceId, keyId, scopes),
        updateVersion: (keyId, apiVersion) => workspacesApi.updateUserApiKeyVersion(workspaceId, keyId, apiVersion),
        revoke: (keyId) => workspacesApi.revokeUserApiKey(workspaceId, keyId),
      }}
      nameLabel="Name"
      namePlaceholder="e.g. CI pipeline, local dev script"
    >
      {({ newKeyButton, list }) => (
        <SettingRow setting="personal-api-keys" labelFor={false} control={newKeyButton}>
          {list}
        </SettingRow>
      )}
    </ApiKeysPanel>
  )
}
