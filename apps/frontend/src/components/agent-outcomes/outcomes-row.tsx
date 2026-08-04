import { TerminalSquare, Timer } from "lucide-react"
import { usePreferences } from "@/contexts"
import { useFormattedDate } from "@/hooks"
import { useStreamName } from "@/hooks/use-stream-name"
import { formatFutureTime } from "@/lib/dates"
import { cn } from "@/lib/utils"
import type { OutcomeItem } from "@/lib/agent-outcomes/items"

interface OutcomesRowProps {
  workspaceId: string
  item: OutcomeItem
  isSelected: boolean
  onSelect: (id: string) => void
}

export function OutcomesRow({ workspaceId, item, isSelected, onSelect }: OutcomesRowProps) {
  const { preferences } = usePreferences()
  const { formatRelative } = useFormattedDate()
  const streamName = useStreamName(workspaceId, item.streamId, "noun")

  const occursAt = new Date(item.occursAt)
  const now = new Date()
  // Only the time format travels into a UI label; the timezone stays the
  // device's (INV-42).
  const timeLabel =
    occursAt.getTime() > now.getTime()
      ? formatFutureTime(occursAt, now, { timeFormat: preferences?.timeFormat })
      : formatRelative(occursAt, now, { terse: true })

  const Icon = item.kind === "follow_up" ? Timer : TerminalSquare

  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-current={isSelected}
      data-outcome-id={item.id}
      className={cn(
        "flex w-full items-center gap-3 rounded-item px-3 py-2 text-left transition-colors",
        isSelected ? "bg-accent" : "hover:bg-muted/60"
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          item.isSettled ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide",
              item.statusPillClass
            )}
          >
            {item.statusLabel}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{streamName ?? "this stream"}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{timeLabel}</span>
        </div>
      </div>
    </button>
  )
}
