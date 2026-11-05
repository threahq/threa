import { DEFAULT_WORKSPACE_SETTINGS, GUEST_DM_POLICIES, type GuestDmPolicy } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { ChoiceSetting, type ChoiceOption } from "@/components/settings/setting-primitives"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface GuestDmPolicySectionProps {
  workspaceId: string
}

const POLICY_OPTIONS: readonly ChoiceOption<GuestDmPolicy>[] = [
  { value: GUEST_DM_POLICIES.OFF, label: "Off" },
  { value: GUEST_DM_POLICIES.ADMINS, label: "Admins only" },
  { value: GUEST_DM_POLICIES.OPEN, label: "Everyone" },
]

export function GuestDmPolicySection({ workspaceId }: GuestDmPolicySectionProps) {
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
  const policy = settings?.guestDmPolicy ?? DEFAULT_WORKSPACE_SETTINGS.guestDmPolicy
  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "guestDmPolicy",
    "Failed to save the guest direct message setting"
  )

  return (
    <ChoiceSetting
      setting="guest-dms"
      variant="segmented"
      value={policy}
      options={POLICY_OPTIONS}
      loading={!access.known}
      disabled={!access.allowed || settings == null || mutation.isPending}
      description={accessDescription("guest-dms", access)}
      onValueChange={(value) => mutation.mutate(value)}
    />
  )
}
