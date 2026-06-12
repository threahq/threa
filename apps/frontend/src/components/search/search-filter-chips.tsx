import { X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { getFilterLabel, removeFilterFromQuery, type ParsedFilter } from "@/lib/search-query-parser"

interface SearchFilterChipsProps {
  query: string
  parsedFilters: ParsedFilter[]
  onQueryChange: (query: string) => void
}

/**
 * Removable chips for the structured filters embedded in the query string
 * (`from:@user`, `in:#channel`, …). Removing a chip rewrites the query —
 * the query string stays the single source of truth.
 */
export function SearchFilterChips({ query, parsedFilters, onQueryChange }: SearchFilterChipsProps) {
  if (parsedFilters.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {parsedFilters.map((filter, index) => (
        <Badge key={`${filter.raw}-${index}`} variant="secondary" className="gap-1 pr-0.5 text-[11px] font-normal">
          <span className="text-muted-foreground">{filter.type}:</span>
          {getFilterLabel(filter)}
          <button
            type="button"
            aria-label={`Remove filter ${getFilterLabel(filter)}`}
            onClick={() => onQueryChange(removeFilterFromQuery(query, index))}
            className="rounded-full p-0.5 transition-colors hover:bg-destructive/20"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}
