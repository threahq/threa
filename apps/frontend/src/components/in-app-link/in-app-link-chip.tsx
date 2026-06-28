import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { chipBase, triggerStyles } from "@/lib/markdown/mention-renderer"

/**
 * Inline chip for an in-app stream/message link, shared by the composer NodeView
 * (`InAppLinkView`) and the timeline markdown renderer (`MarkdownLink`) — the
 * same split `MemoChip` uses. Speaks the mention vocabulary (`chipBase` shape +
 * the channel `triggerStyles` palette): a channel shows its `#` as a text
 * prefix, reading exactly like a `#channel` mention; kinds with no sigil (DM,
 * message, restricted/pending) show a small leading glyph instead.
 */
export function InAppLinkChip({
  icon: Icon,
  prefix,
  label,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  prefix?: string
  label: ReactNode
  className?: string
}) {
  if (prefix) {
    return (
      <span className={cn(chipBase, triggerStyles.channel, className)} data-type="in-app-link-chip">
        {prefix}
        {label}
      </span>
    )
  }

  const ChipIcon = Icon ?? Link2
  return (
    <span
      className={cn(
        chipBase,
        "inline-flex max-w-[14rem] items-center gap-1 align-bottom",
        triggerStyles.channel,
        className
      )}
      data-type="in-app-link-chip"
    >
      <ChipIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}
