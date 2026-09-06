import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"

/**
 * A labelled, collapsible group of non-message results (Memories,
 * Conversations). Phone widths start collapsed so the message list is on
 * screen at once; the header keeps the count visible either way.
 */
export function ResultGroup({
  label,
  count,
  defaultOpen,
  action,
  children,
}: {
  label: string
  count: number
  defaultOpen: boolean
  /** Rendered at the end of the header row, outside the toggle (a "See all" link). */
  action?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="mb-3 border-b border-border/50 pb-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1 rounded-md py-1 pr-1 text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
          )}
          <span>{label}</span> <span className="tabular-nums text-muted-foreground/60">{count}</span>
        </button>
        {action}
      </div>
      {open && children}
    </div>
  )
}
