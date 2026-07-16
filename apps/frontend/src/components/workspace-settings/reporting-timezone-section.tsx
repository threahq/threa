import { WORKSPACE_PERMISSION_SCOPES, DEFAULT_WORKSPACE_SETTINGS } from "@threa/types"
import { useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { hasPermission } from "@/lib/permissions"
import { Label } from "@/components/ui/label"
import { TimezonePicker, formatTimezoneLabel } from "@/components/ui/timezone-picker"

interface ReportingTimezoneSectionProps {
  workspaceId: string
}

/**
 * The workspace's reporting timezone for AI spend. The AI usage dashboard offers
 * it alongside the viewer's device timezone, so a distributed workspace can read
 * one shared set of day and month lines. Editing is gated to admins; others see
 * the current zone read-only.
 */
export function ReportingTimezoneSection({ workspaceId }: ReportingTimezoneSectionProps) {
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const savedValue = settings?.reportingTimezone ?? DEFAULT_WORKSPACE_SETTINGS.reportingTimezone

  const mutation = useWorkspaceSettingMutation(
    workspaceId,
    "reportingTimezone",
    "Failed to save the workspace timezone"
  )

  return (
    <div>
      <Label className="text-sm font-medium">Workspace timezone</Label>
      <p className="text-xs text-muted-foreground mt-0.5">
        The timezone AI spend is reported in when members pick “Workspace timezone” on the AI usage dashboard. Members
        can still read the dashboard in their own timezone.
      </p>
      {canManage ? (
        <div className="mt-2">
          <TimezonePicker
            value={savedValue}
            disabled={settings == null || mutation.isPending}
            onChange={(reportingTimezone) => {
              if (reportingTimezone !== savedValue) mutation.mutate(reportingTimezone)
            }}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mt-2 font-mono">{formatTimezoneLabel(savedValue)}</p>
      )}
    </div>
  )
}
