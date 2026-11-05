import { DEFAULT_MAX_PENDING_FOLLOW_UPS, MAX_PENDING_FOLLOW_UPS_MIN, MAX_PENDING_FOLLOW_UPS_MAX } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { NumberField, SettingRow, settingIds, useSettingDescribedBy } from "@/components/settings/setting-primitives"
import { GatedControl, accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface FollowUpLimitSectionProps {
  workspaceId: string
}

/**
 * Workspace cap on an agent's pending follow-ups per stream. The tool's
 * self-reported limit reflects this the next time the agent schedules.
 */
export function FollowUpLimitSection({ workspaceId }: FollowUpLimitSectionProps) {
  const access = useWorkspaceAccess(workspaceId)
  const settings = useCachedWorkspaceBootstrap(workspaceId)?.workspaceSettings ?? null
  const savedValue = settings?.maxPendingFollowUps ?? DEFAULT_MAX_PENDING_FOLLOW_UPS
  const mutation = useWorkspaceSettingMutation(workspaceId, "maxPendingFollowUps", "Failed to save the follow-up limit")
  const describedBy = useSettingDescribedBy("follow-up-limit")

  return (
    <SettingRow
      setting="follow-up-limit"
      labelFor={access.allowed}
      description={accessDescription("follow-up-limit", access)}
      control={
        <GatedControl access={access} readOnly={`${savedValue} follow-ups`}>
          <NumberField
            id={settingIds("follow-up-limit").control}
            value={savedValue}
            min={MAX_PENDING_FOLLOW_UPS_MIN}
            max={MAX_PENDING_FOLLOW_UPS_MAX}
            unit="follow-ups"
            disabled={settings == null || mutation.isPending}
            onCommit={(next) => mutation.mutate(next)}
            aria-describedby={describedBy}
          />
        </GatedControl>
      }
    />
  )
}
