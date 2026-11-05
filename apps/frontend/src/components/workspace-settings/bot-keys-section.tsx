import { BOT_KEY_PREFIX } from "@threahq/types"
import { botsApi } from "@/api/bots"
import { SettingRow } from "@/components/settings/setting-primitives"
import { ApiKeysPanel } from "./api-keys-panel"

interface BotKeysSectionProps {
  workspaceId: string
  botId: string
  isArchived: boolean
}

export function BotKeysSection({ workspaceId, botId, isArchived }: BotKeysSectionProps) {
  return (
    <ApiKeysPanel
      source={{
        queryKey: ["bot-keys", workspaceId, botId],
        secretPrefix: BOT_KEY_PREFIX,
        list: () => botsApi.listKeys(workspaceId, botId),
        create: (input) => botsApi.createKey(workspaceId, botId, input),
        updateScopes: (keyId, scopes) => botsApi.updateKeyScopes(workspaceId, botId, keyId, scopes),
        updateVersion: (keyId, apiVersion) => botsApi.updateKeyVersion(workspaceId, botId, keyId, apiVersion),
        revoke: (keyId) => botsApi.revokeKey(workspaceId, botId, keyId),
      }}
      readOnly={isArchived}
      nameLabel="Key name"
      namePlaceholder="e.g. production, staging"
    >
      {({ newKeyButton, list }) => (
        <SettingRow label="API keys" description="A bot needs one to send messages." control={newKeyButton}>
          {list}
        </SettingRow>
      )}
    </ApiKeysPanel>
  )
}
