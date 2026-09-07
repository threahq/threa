import { Loader2, Sparkles, TriangleAlert, X } from "lucide-react"
import type { SearchRefinement } from "@threahq/types"
import { Badge } from "@/components/ui/badge"
import { serializeRefine } from "@/lib/search-query-parser"
import { cn } from "@/lib/utils"

type RefineChipState = "idle" | "pending" | "failed"

interface SearchRefineChipsProps {
  refines: SearchRefinement[]
  /** Row titles by conversation id, for the chips that name a row. */
  conversationTitles: Map<string, string>
  onRemove: (index: number) => void
  /** Reopens the refine row on that chip's prose; the text is inert without it. */
  onEdit?: (index: number) => void
  /** A search carrying these refinements is in flight. */
  pending?: boolean
  /** The last request could not apply the refinement. */
  failed?: boolean
}

/**
 * Removable chips for the committed refinements, in the order they were given.
 * Renders as `display: contents` so each chip wraps as its own flex item in the
 * caller's row next to the filter chips. The newest chip carries the state of
 * the request it belongs to.
 */
export function SearchRefineChips({
  refines,
  conversationTitles,
  onRemove,
  onEdit,
  pending = false,
  failed = false,
}: SearchRefineChipsProps) {
  if (refines.length === 0) return null

  return (
    <div className="contents">
      {refines.map((refine, index) => {
        const state = chipState(index === refines.length - 1, pending, failed)
        const key = serializeRefine(refine)
        const label = refineLabel(refine, conversationTitles)
        const editable = typeof refine === "string" && onEdit !== undefined
        return (
          <Badge
            key={`${key}-${index}`}
            variant="secondary"
            className={cn(
              "max-w-full gap-1 pr-0.5 text-[11px] font-normal",
              state === "failed" && "border-destructive/40 bg-destructive/10 text-destructive"
            )}
            data-search-refine={key}
            data-search-refine-state={state === "idle" ? undefined : state}
          >
            <RefineChipIcon state={state} />
            {editable ? (
              <button
                type="button"
                className="min-w-0 truncate hover:underline"
                title={label}
                onClick={() => onEdit(index)}
              >
                {label}
              </button>
            ) : (
              <span className="min-w-0 truncate" title={label}>
                {label}
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove refinement ${label}`}
              onClick={() => onRemove(index)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/20"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )
      })}
    </div>
  )
}

/** A row refinement whose conversation left the list still reads as itself, by action alone. */
function refineLabel(refine: SearchRefinement, conversationTitles: Map<string, string>): string {
  if (typeof refine === "string") return refine
  const action = refine.kind === "more" ? "More like" : "Drop"
  return `${action} ${conversationTitles.get(refine.conversationId) ?? "this conversation"}`
}

function chipState(isNewest: boolean, pending: boolean, failed: boolean): RefineChipState {
  if (!isNewest) return "idle"
  if (pending) return "pending"
  if (failed) return "failed"
  return "idle"
}

function RefineChipIcon({ state }: { state: RefineChipState }) {
  if (state === "pending") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
  }
  if (state === "failed") {
    return <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
  }
  return <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
}
