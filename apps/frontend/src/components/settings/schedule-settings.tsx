import { useParams } from "react-router-dom"
import { usePreferences } from "@/contexts"
import { useWorkspaceDefaultWorkSchedule } from "@/hooks/use-work-schedule"
import { SettingStateAction, SettingsDisclosure, SettingsSection } from "./setting-primitives"
import { WorkScheduleEditor, WorkScheduleLine } from "./work-schedule-editor"

/**
 * Personal working hours, the week on one line with the day-by-day editor
 * behind it. With no override the workspace's hours apply; customizing seeds
 * an override from them. Every edit saves, since the editor can only produce
 * valid shifts.
 */
export function ScheduleSettings() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference, isLoading } = usePreferences()
  const workspaceHours = useWorkspaceDefaultWorkSchedule(workspaceId)
  const ownHours = preferences?.workSchedule ?? null

  return (
    <SettingsSection section="working-hours">
      <SettingsDisclosure
        setting="working-hours"
        summary={
          ownHours ? (
            <WorkScheduleLine schedule={ownHours} />
          ) : (
            <>
              Workspace hours · <WorkScheduleLine schedule={workspaceHours} />
            </>
          )
        }
      >
        {/* One button whose action flips, so focus stays put across the switch. */}
        <SettingStateAction
          action={{
            disabled: isLoading,
            "aria-label": ownHours ? undefined : "Customize working hours",
            onClick: () => void updatePreference("workSchedule", ownHours ? null : workspaceHours),
            children: ownHours ? "Use the workspace's hours" : "Customize",
          }}
        >
          {ownHours ? "Your own hours." : "Using the workspace's hours."}
        </SettingStateAction>
        {ownHours && (
          <WorkScheduleEditor
            value={ownHours}
            onChange={(next) => void updatePreference("workSchedule", next)}
            disabled={isLoading}
          />
        )}
      </SettingsDisclosure>
    </SettingsSection>
  )
}
