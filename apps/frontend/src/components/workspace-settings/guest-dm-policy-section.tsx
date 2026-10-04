import {
  DEFAULT_WORKSPACE_SETTINGS,
  GUEST_DM_POLICIES,
  WORKSPACE_PERMISSION_SCOPES,
  type GuestDmPolicy,
} from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { hasPermission } from "@/lib/permissions"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface GuestDmPolicySectionProps {
  workspaceId: string
}

const POLICY_LABELS: Record<GuestDmPolicy, string> = {
  [GUEST_DM_POLICIES.OFF]: "Off",
  [GUEST_DM_POLICIES.ADMINS]: "Admins only",
  [GUEST_DM_POLICIES.OPEN]: "Everyone",
}

export function GuestDmPolicySection({ workspaceId }: GuestDmPolicySectionProps) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const policy = settings?.guestDmPolicy ?? DEFAULT_WORKSPACE_SETTINGS.guestDmPolicy
  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "guestDmPolicy",
    "Failed to save the guest direct message setting"
  )

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor="guest-dm-policy" className="text-sm font-medium">
          Direct messages with guests
        </Label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Who guests can message directly. Applies to existing DMs too: a DM this no longer allows becomes read-only.
        </p>
      </div>
      {canManage ? (
        <Select
          value={policy}
          disabled={settings == null || mutation.isPending}
          onValueChange={(value) => mutation.mutate(value as GuestDmPolicy)}
        >
          <SelectTrigger id="guest-dm-policy" className="h-8 w-[140px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(POLICY_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-sm text-muted-foreground">{POLICY_LABELS[policy]}</p>
      )}
    </div>
  )
}
