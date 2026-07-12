import { Clock, ArrowDownAZ } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { StreamSortMode } from "@/lib/stream-sort"
import { cn } from "@/lib/utils"

interface StreamSortToggleProps {
  value: StreamSortMode
  onChange: (mode: StreamSortMode) => void
  /** Icon size class; defaults to the modal size, pickers pass a smaller one. */
  iconClassName?: string
  className?: string
}

/**
 * Recency ↔ alphabetical sort toggle shared by every stream picker (share modal,
 * overlay composer target picker) so the two-icon control + its guarded
 * `onValueChange` live in one place instead of being copied per surface.
 */
export function StreamSortToggle({ value, onChange, iconClassName = "h-4 w-4", className }: StreamSortToggleProps) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next === "recency" || next === "alphabetical") onChange(next)
      }}
      aria-label="Sort streams"
      className={cn("shrink-0", className)}
    >
      <ToggleGroupItem value="recency" aria-label="Sort by recent activity" title="Recent activity">
        <Clock className={iconClassName} aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem value="alphabetical" aria-label="Sort A–Z" title="A–Z">
        <ArrowDownAZ className={iconClassName} aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
