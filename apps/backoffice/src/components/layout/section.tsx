import { useId, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export const NOTE_TEXT = "text-[0.8125rem] leading-snug"

export function Section({
  label,
  description,
  actions,
  className,
  children,
}: {
  label: string
  description?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </h2>
          {description ? <p className={cn("max-w-2xl text-muted-foreground", NOTE_TEXT)}>{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}
