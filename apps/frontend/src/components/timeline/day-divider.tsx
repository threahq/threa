import { formatDayDivider } from "@/lib/dates"

interface DayDividerProps {
  /** Local start-of-day timestamp (ms) for the day this divider opens. */
  dayStartMs: number
}

/**
 * In-flow day boundary between messages from different calendar days. Unlike
 * `UnreadDivider` (which overlays the gap above a row), this occupies its own
 * timeline row so the virtualizer measures it. The label resolves at render
 * time so "Today"/"Yesterday" track the device's current day (INV-42).
 */
export function DayDivider({ dayStartMs }: DayDividerProps) {
  return (
    <div className="flex items-center gap-3 px-3 sm:px-6 py-2 select-none">
      <div className="flex-1 border-t border-border" />
      <span className="rounded-full border bg-background px-3 py-0.5 text-xs font-medium text-muted-foreground">
        {formatDayDivider(new Date(dayStartMs))}
      </span>
      <div className="flex-1 border-t border-border" />
    </div>
  )
}
