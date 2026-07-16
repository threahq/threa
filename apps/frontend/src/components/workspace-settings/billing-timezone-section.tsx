import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  WORKSPACE_PERMISSION_SCOPES,
  DEFAULT_WORKSPACE_SETTINGS,
  type WorkspaceBootstrap,
  type WorkspaceSettings,
} from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { Label } from "@/components/ui/label"
import { TimezonePicker, formatTimezoneLabel } from "@/components/ui/timezone-picker"

interface BillingTimezoneSectionProps {
  workspaceId: string
}

/**
 * The workspace's reporting timezone for AI spend. The AI usage dashboard offers
 * it alongside the viewer's device timezone, so a distributed workspace can read
 * one shared set of day and month lines. Editing is gated to admins; others see
 * the current zone read-only.
 */
export function BillingTimezoneSection({ workspaceId }: BillingTimezoneSectionProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const settings = bootstrap?.workspaceSettings ?? null
  const savedValue = settings?.billingTimezone ?? DEFAULT_WORKSPACE_SETTINGS.billingTimezone

  const mutation = useMutation({
    mutationFn: (billingTimezone: string) => workspaceSettingsApi.update(workspaceId, { billingTimezone }),
    onMutate: async (billingTimezone) => {
      await queryClient.cancelQueries({ queryKey: workspaceKeys.bootstrap(workspaceId) })
      let previousSettings: WorkspaceSettings | null = null
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        previousSettings = old?.workspaceSettings ?? null
        return old?.workspaceSettings
          ? { ...old, workspaceSettings: { ...old.workspaceSettings, billingTimezone } }
          : old
      })
      return { previousSettings }
    },
    onError: (_err, _next, context) => {
      if (context?.previousSettings) {
        const restored = context.previousSettings
        queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
          old ? { ...old, workspaceSettings: restored } : old
        )
      }
      toast.error("Failed to save the workspace timezone")
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: saved } : old
      )
    },
  })

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
            onChange={(billingTimezone) => {
              if (billingTimezone !== savedValue) mutation.mutate(billingTimezone)
            }}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mt-2 font-mono">{formatTimezoneLabel(savedValue)}</p>
      )}
    </div>
  )
}
