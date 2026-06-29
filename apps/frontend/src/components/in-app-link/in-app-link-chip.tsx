import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { chipBase, triggerStyles } from "@/lib/markdown/mention-renderer"
import type { ChipMessageParts } from "@/hooks/use-in-app-link-chip"

const inlineChip = "inline-flex max-w-[16rem] items-center gap-1 align-bottom"

/**
 * Inline chip for an in-app stream/message link, shared by the composer NodeView
 * (`InAppLinkView`) and the timeline markdown renderer (`MarkdownLink`) — the
 * same split `MemoChip` uses. Speaks the mention vocabulary (`chipBase` shape +
 * the channel `triggerStyles` palette): a channel shows its `#` as a text prefix,
 * reading exactly like a `#channel` mention; a message reads "{author} in
 * #channel" behind a leading glyph. The rich preview (author face, snippet) lives
 * in the below-message card, not here — the chip is a compact text reference, so
 * it resolves synchronously from the baked label and never flickers or reflows.
 */
export function InAppLinkChip({
  icon: Icon,
  prefix,
  label,
  messageParts,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  prefix?: string
  label: ReactNode
  messageParts?: ChipMessageParts
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
      {messageParts ? (
        // Author truncates; the location suffix stays pinned so it survives
        // truncation — its own leading space separates it from the author.
        <span className="inline-flex min-w-0 items-center">
          <span className="min-w-0 truncate">{messageParts.lead}</span>
          {messageParts.tail && <span className="shrink-0 whitespace-nowrap">{messageParts.tail}</span>}
        </span>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </span>
  )
}
