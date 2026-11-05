import { DEFAULT_WORKSPACE_SETTINGS } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { SwitchSetting } from "@/components/settings/setting-primitives"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface SandboxInternetSectionProps {
  workspaceId: string
}

export function SandboxInternetSection({ workspaceId }: SandboxInternetSectionProps) {
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
  const enabled = settings?.sandboxInternet ?? DEFAULT_WORKSPACE_SETTINGS.sandboxInternet
  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "sandboxInternet",
    "Failed to save the sandbox internet setting"
  )

  return (
    <SwitchSetting
      setting="sandbox-internet"
      checked={enabled}
      loading={!access.known}
      disabled={!access.allowed || settings == null || mutation.isPending}
      description={accessDescription("sandbox-internet", access)}
      onCheckedChange={(checked) => mutation.mutate(checked)}
    />
  )
}
