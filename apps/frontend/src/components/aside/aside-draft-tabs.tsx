import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AsideDraftRow } from "./use-aside-drafts"

interface AsideDraftTabsProps {
  drafts: AsideDraftRow[]
  /** The draft currently open for writing, if any. */
  openScope: string | null
  onOpen: (scope: string) => void
  onNew: () => void
}

/**
 * The aside's drafts as one segmented strip: several can live at once, and
 * which one you are writing is a choice, not a navigation. A list of rows
 * costs a screenful before you reach your own words; a strip costs a line and
 * still names every draft.
 */
export function AsideDraftTabs({ drafts, openScope, onOpen, onNew }: AsideDraftTabsProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {drafts.length > 0 && (
        <div role="tablist" aria-label="Drafts" className="flex w-max shrink-0 items-center rounded-lg border">
          {drafts.map((draft, index) => {
            const active = draft.scope === openScope
            return (
              <button
                key={draft.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-draft-scope={draft.scope}
                onClick={() => onOpen(draft.scope)}
                className={cn(
                  "max-w-[11rem] truncate px-2.5 py-1 text-[11px] transition-colors",
                  index > 0 && "border-l",
                  index === 0 && "rounded-l-[7px]",
                  index === drafts.length - 1 && "rounded-r-[7px]",
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                {draft.isEmpty ? "Empty draft" : draft.preview}
              </button>
            )
          })}
        </div>
      )}
      <button
        type="button"
        aria-label="New draft"
        onClick={onNew}
        className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary"
      >
        <Plus className="h-3 w-3" aria-hidden />
        {drafts.length === 0 && "Start a draft"}
      </button>
    </div>
  )
}
