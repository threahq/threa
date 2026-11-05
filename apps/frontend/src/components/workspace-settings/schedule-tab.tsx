import { useWorkspaceDefaultWorkSchedule } from "@/hooks/use-work-schedule"
import { useWorkspaceSettingMutation } from "@/hooks/use-workspace-setting-mutation"
import { WorkScheduleEditor, WorkScheduleLine } from "@/components/settings/work-schedule-editor"
import { SettingsDisclosure, SettingsSection } from "@/components/settings/setting-primitives"
import { accessDescription, useWorkspaceAccess } from "./workspace-permission"

interface ScheduleTabProps {
  workspaceId: string
}

/** Every edit saves, since the editor can only produce valid shifts. */
export function ScheduleTab({ workspaceId }: ScheduleTabProps) {
  const access = useWorkspaceAccess(workspaceId)
  const saved = useWorkspaceDefaultWorkSchedule(workspaceId)
  const save = useWorkspaceSettingMutation(workspaceId, "defaultWorkSchedule", "Couldn't save the workspace's hours")

  return (
    <SettingsSection section="defaults-time">
      <SettingsDisclosure
        setting="default-working-hours"
        summary={<WorkScheduleLine schedule={saved} />}
        description={accessDescription("default-working-hours", access)}
      >
        <WorkScheduleEditor value={saved} onChange={(next) => save.mutate(next)} disabled={!access.allowed} />
      </SettingsDisclosure>
    </SettingsSection>
  )
}
