import { type ComponentProps, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { NOTE_TEXT } from "./section"

export const CARD_CLASS = "rounded-lg border bg-card"

export const ROW_PADDING = "px-4 py-3"

export function RowList({ className, ...props }: ComponentProps<"ul">) {
  return <ul className={cn(CARD_CLASS, "divide-y overflow-hidden", className)} {...props} />
}

export function RowText({ title, meta, badges }: { title: ReactNode; meta?: ReactNode; badges?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
        {badges}
      </div>
      {meta ? <div className={cn("min-w-0 truncate text-muted-foreground", NOTE_TEXT)}>{meta}</div> : null}
    </div>
  )
}

export function MetaLine({ parts }: { parts: ReactNode[] }) {
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? <span className="px-1.5 text-muted-foreground/50">·</span> : null}
          {part}
        </span>
      ))}
    </>
  )
}

export function LinkRow({ to, children }: { to: string; children: ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        className={cn(
          "group flex min-h-14 items-center gap-4 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          ROW_PADDING
        )}
      >
        {children}
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      </Link>
    </li>
  )
}

export function ListPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
