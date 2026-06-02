import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { WORKSPACE_PERMISSION_SCOPES, type WorkSchedule, type WorkspaceBootstrap } from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys, useCachedWorkspaceBootstrap } from "@/hooks/use-workspaces"
import { useWorkspaceDefaultWorkSchedule } from "@/hooks/use-work-schedule"
import { hasPermission } from "@/lib/permissions"
import { Button } from "@/components/ui/button"
import { WorkScheduleEditor } from "@/components/settings/work-schedule-editor"

interface ScheduleTabProps {
  workspaceId: string
}

/**
 * Workspace-wide default working schedule. Members inherit this unless they set
 * a personal override in their own settings. Editing is gated to admins; others
 * see the schedule read-only.
 */
export function ScheduleTab({ workspaceId }: ScheduleTabProps) {
  const queryClient = useQueryClient()
  const bootstrap = useCachedWorkspaceBootstrap(workspaceId)
  const canManage = hasPermission(bootstrap?.viewerPermissions, WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const saved = useWorkspaceDefaultWorkSchedule(workspaceId)

  const [draft, setDraft] = useState<WorkSchedule>(saved)
  useEffect(() => {
    setDraft(saved)
  }, [saved])

  const mutation = useMutation({
    mutationFn: (defaultWorkSchedule: WorkSchedule) =>
      workspaceSettingsApi.update(workspaceId, { defaultWorkSchedule }),
    onSuccess: (settings) => {
      // Reflect the new default in the bootstrap cache so every schedule-aware
      // surface picks it up without a refetch.
      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) =>
        old ? { ...old, workspaceSettings: settings } : old
      )
      toast.success("Workspace schedule saved")
    },
    onError: () => toast.error("Failed to save workspace schedule"),
  })

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  return (
    <div className="space-y-4 p-1">
      <div>
        <h3 className="text-sm font-medium">Default working schedule</h3>
        <p className="text-sm text-muted-foreground">
          The working week and hours new members inherit. Scheduling shortcuts like “Tomorrow morning” and “Next week”
          snap to the start of work. Members can override this in their own settings.
        </p>
      </div>

      <WorkScheduleEditor value={draft} onChange={setDraft} disabled={!canManage || mutation.isPending} />

      {canManage ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!dirty || mutation.isPending}
            onClick={() => setDraft(saved)}
          >
            Reset
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || mutation.isPending}
            onClick={() => mutation.mutate(draft)}
          >
            Save schedule
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only workspace admins can change the default schedule.</p>
      )}
    </div>
  )
}
