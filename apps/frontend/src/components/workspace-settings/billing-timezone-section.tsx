import { DEFAULT_WORKSPACE_SETTINGS } from "@threahq/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { TimezonePicker, formatTimezoneLabel } from "@/components/ui/timezone-picker"
import { SETTING_CONTROL_CLASS, SettingRow, settingIds } from "@/components/settings/setting-primitives"
import { settingDef } from "@/components/settings/settings-registry"
import { GatedControl, accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface BillingTimezoneSectionProps {
  workspaceId: string
}

export function BillingTimezoneSection({ workspaceId }: BillingTimezoneSectionProps) {
  const ids = settingIds("workspace-timezone")
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const access = useWorkspaceAccess(workspaceId)
  const settings = bootstrap?.workspaceSettings ?? null
  const savedValue = settings?.billingTimezone ?? DEFAULT_WORKSPACE_SETTINGS.billingTimezone

  const mutation = useWorkspaceSettingMutation(workspaceId, "billingTimezone", "Failed to save the workspace timezone")

  return (
    <SettingRow
      setting="workspace-timezone"
      labelFor={false}
      description={accessDescription("workspace-timezone", access)}
      control={
        <GatedControl access={access} readOnly={formatTimezoneLabel(savedValue)}>
          <TimezonePicker
            id={ids.control}
            value={savedValue}
            disabled={settings == null || mutation.isPending}
            onChange={(billingTimezone) => {
              if (billingTimezone !== savedValue) mutation.mutate(billingTimezone)
            }}
            className={SETTING_CONTROL_CLASS}
            aria-labelledby={ids.label}
            aria-describedby={settingDef("workspace-timezone").description ? ids.description : undefined}
          />
        </GatedControl>
      }
    />
  )
}
