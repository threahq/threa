import { DEFAULT_WORKSPACE_SETTINGS, WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { hasPermission } from "@/lib/permissions"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

interface SandboxInternetSectionProps {
  workspaceId: string
}

export function SandboxInternetSection({ workspaceId }: SandboxInternetSectionProps) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const enabled = settings?.sandboxInternet ?? DEFAULT_WORKSPACE_SETTINGS.sandboxInternet
  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "sandboxInternet",
    "Failed to save the sandbox internet setting"
  )

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor="sandbox-internet" className="text-sm font-medium">
          Sandbox internet access
        </Label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Lets commands the assistant runs reach the internet. Attachments the assistant copies into its sandbox could
          then leave the workspace. Changing this gives every conversation a fresh sandbox, so files made in the old one
          are gone.
        </p>
      </div>
      {canManage ? (
        <Switch
          id="sandbox-internet"
          className="mt-0.5"
          checked={enabled}
          disabled={settings == null || mutation.isPending}
          onCheckedChange={(checked) => mutation.mutate(checked)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{enabled ? "On" : "Off"}</p>
      )}
    </div>
  )
}
