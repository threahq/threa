import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { chipBase, triggerStyles } from "@/lib/markdown/mention-renderer"

const inlineChip = "inline-flex max-w-[16rem] items-center gap-1 align-bottom"

/**
 * Inline chip for an in-app stream/message link, shared by the composer NodeView
 * (`InAppLinkView`) and the timeline markdown renderer (`MarkdownLink`) — the
 * same split `MemoChip` uses. Speaks the mention vocabulary (`chipBase` shape +
 * the channel `triggerStyles` palette): a channel shows its `#` as a text prefix,
 * reading exactly like a `#channel` mention; a message reads "{author} in
 * #channel" behind a leading glyph. A single end-truncated `label` (no internal
 * split) so the baked-label pending state and the resolved state truncate the
 * same way and never re-align. The rich preview (author face, snippet) lives in
 * the below-message card; the chip is a compact text reference.
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
    <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <ChipIcon className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className="truncate">{label}</span>
    </span>
  )
}
