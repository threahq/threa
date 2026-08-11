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
      {/* Left padding clears the rows' 4px urgency strip so the label lines up
          with their text rather than with the strip. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-background/90 py-1.5 pl-4 pr-3 backdrop-blur-sm sm:pl-5 sm:pr-4">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  )
}
