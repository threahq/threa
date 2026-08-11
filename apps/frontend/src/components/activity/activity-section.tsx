import type { ReactNode } from "react"

interface ActivitySectionProps {
  label: string
  /** Rendered as a pill beside the label; omitted when zero. */
  count?: number
  children: ReactNode
}

export function ActivitySection({ label, count, children }: ActivitySectionProps) {
  return (
    <section aria-label={label} className="mb-4 last:mb-0">
      {/* Transparent 2px border mirrors the rows' unread rail so the label
          lines up with their text instead of sitting 2px to its left. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-l-2 border-transparent bg-background/90 px-3 py-1.5 backdrop-blur-sm sm:px-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary">
            {count}
          </span>
        )}
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}
