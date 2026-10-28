import { type ReactNode } from "react"
import { StreamTypes } from "@threahq/types"
import { STREAM_ICONS } from "@/lib/streams"
import { cn } from "@/lib/utils"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

/** The inline doc chip: glyph and title. */
export function DocChip({ label, className }: { label: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-baseline text-sm",
        "bg-primary/10 font-medium text-primary [&_*]:[text-decoration:inherit]",
        className
      )}
      data-type="doc-chip"
    >
      <DocGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-[14rem] truncate">{label}</span>
    </span>
  )
}
