import { Sparkles, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"

interface SearchSteerChipsProps {
  steers: string[]
  onRemove: (index: number) => void
}

/**
 * Removable chips for the committed `/steer` refinements, in the order they
 * were given. Renders as `display: contents` so each chip wraps as its own
 * flex item in the caller's row next to the filter chips.
 */
export function SearchSteerChips({ steers, onRemove }: SearchSteerChipsProps) {
  if (steers.length === 0) return null

  return (
    <div className="contents">
      {steers.map((steer, index) => (
        <Badge
          key={`${steer}-${index}`}
          variant="secondary"
          className="max-w-full gap-1 pr-0.5 text-[11px] font-normal"
          data-search-steer={steer}
        >
          <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate" title={steer}>
            {steer}
          </span>
          <button
            type="button"
            aria-label={`Remove steer ${steer}`}
            onClick={() => onRemove(index)}
            className="rounded-full p-0.5 transition-colors hover:bg-destructive/20"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}
