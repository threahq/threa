import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getUtcOffset } from "@/components/ui/timezone-picker"

/** Which timezone the dashboard draws its day and month lines in. */
export type UsageTimezoneMode = "device" | "workspace"

interface UsageTimezoneSelectorProps {
  mode: UsageTimezoneMode
  onModeChange: (mode: UsageTimezoneMode) => void
  deviceTimezone: string
  workspaceTimezone: string
}

function zoneHint(timezone: string): string {
  return `${timezone.replace(/_/g, " ")} · ${getUtcOffset(timezone)}`
}

/**
 * Reporting-timezone switch for the AI usage dashboard. Spend is stored as UTC
 * timestamps; the day and month boundaries are drawn at read time, so a viewer
 * can read the same month in their own zone or in the workspace's shared one.
 */
export function UsageTimezoneSelector({
  mode,
  onModeChange,
  deviceTimezone,
  workspaceTimezone,
}: UsageTimezoneSelectorProps) {
  return (
    <Select value={mode} onValueChange={(next) => onModeChange(next as UsageTimezoneMode)}>
      <SelectTrigger
        className="h-8 w-auto gap-2 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent focus:ring-0"
        aria-label="Reporting timezone"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="device">
          <span className="text-xs">Your timezone</span>
          <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">{zoneHint(deviceTimezone)}</span>
        </SelectItem>
        <SelectItem value="workspace">
          <span className="text-xs">Workspace timezone</span>
          <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">{zoneHint(workspaceTimezone)}</span>
        </SelectItem>
      </SelectContent>
    </Select>
  )
}
