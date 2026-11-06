import { type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { CARD_CLASS } from "./rows"

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{children}</div>
}

export function Stat({
  label,
  value,
  highlight,
  to,
}: {
  label: string
  value: number | null
  highlight?: boolean
  to?: string
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        {label}
        {to ? (
          <ArrowRight
            aria-hidden
            className="size-3.5 -translate-x-0.5 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100"
          />
        ) : null}
      </span>
      <span className={cn("text-3xl font-semibold tabular-nums", highlight ? "text-primary" : "text-foreground")}>
        {value == null ? <span className="text-muted-foreground">—</span> : value}
      </span>
    </>
  )
  const frame = cn(CARD_CLASS, "flex flex-col gap-2 px-5 py-4")
  if (!to) return <div className={frame}>{body}</div>
  return (
    <Link
      to={to}
      className={cn(
        frame,
        "group transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      )}
    >
      {body}
    </Link>
  )
}
