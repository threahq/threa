import { useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import type { WorkSchedule } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { usePreferences } from "@/contexts"
import { useWorkspaceDefaultWorkSchedule } from "@/hooks/use-work-schedule"
import { WorkScheduleEditor } from "./work-schedule-editor"

/**
 * Personal working week + working hours. When the user has no override they
 * inherit the workspace default; flipping "Use a custom schedule" seeds the
 * editor from that default and stores a personal override. Schedule-aware
 * scheduling presets ("Tomorrow morning", "Next week") resolve against it.
 */
export function ScheduleSettings() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { preferences, updatePreference, isLoading } = usePreferences()
  const workspaceDefault = useWorkspaceDefaultWorkSchedule(workspaceId ?? "")

  const savedOverride = preferences?.workSchedule ?? null
  const usingCustom = savedOverride !== null

  // Local draft so editing time fields doesn't fire a mutation per keystroke;
  // the explicit Save commits the override.
  const [draft, setDraft] = useState<WorkSchedule>(savedOverride ?? workspaceDefault)

  useEffect(() => {
    setDraft(savedOverride ?? workspaceDefault)
  }, [savedOverride, workspaceDefault])

  const dirty = usingCustom && JSON.stringify(draft) !== JSON.stringify(savedOverride)

  const toggleCustom = (on: boolean) => {
    // Enabling seeds the override from the current effective default; disabling
    // clears it (null → inherit workspace default).
    void updatePreference("workSchedule", on ? workspaceDefault : null)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Working schedule</h3>
          <p className="text-sm text-muted-foreground">
            Your working week and hours. Scheduling shortcuts like “Tomorrow morning” and “Next week” snap to when you
            start work, in your local time.
          </p>
        </div>
        <label className="flex items-center gap-3 cursor-pointer">
          <Switch checked={usingCustom} onCheckedChange={toggleCustom} disabled={isLoading} />
          <span className="text-sm">Use a custom schedule (otherwise inherit the workspace default)</span>
        </label>
      </section>

      {usingCustom && (
        <>
          <Separator />
          <section className="space-y-3">
            <WorkScheduleEditor value={draft} onChange={setDraft} disabled={isLoading} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!dirty || isLoading}
                onClick={() => setDraft(savedOverride ?? workspaceDefault)}
              >
                Reset
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || isLoading}
                onClick={() => void updatePreference("workSchedule", draft)}
              >
                Save schedule
              </Button>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
