import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { chipBase, triggerStyles } from "@/lib/markdown/mention-renderer"
import type { ChipAvatar, ChipMessageParts } from "@/hooks/use-in-app-link-chip"

const inlineChip = "inline-flex max-w-[16rem] items-center gap-1 align-bottom"

/**
 * Inline chip for an in-app stream/message link, shared by the composer NodeView
 * (`InAppLinkView`) and the timeline markdown renderer (`MarkdownLink`) — the
 * same split `MemoChip` uses. Speaks the mention vocabulary (`chipBase` shape +
 * the channel `triggerStyles` palette): a channel shows its `#` as a text
 * prefix, reading exactly like a `#channel` mention. A message leads with its
 * author's face (`avatar`) and a "{author} in #channel" label; kinds with no
 * face or sigil (restricted, uncached message) fall back to a glyph, and a
 * pending message shows a neutral placeholder in the same slot. The leading
 * face/glyph/placeholder occupies the same 16px slot in every variant so the
 * chip never changes height as it resolves (INV-21).
 */
export function InAppLinkChip({
  icon: Icon,
  prefix,
  label,
  avatar,
  messageParts,
  avatarSkeleton,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  prefix?: string
  label: ReactNode
  avatar?: ChipAvatar
  messageParts?: ChipMessageParts
  /** Pending message chip: show the baked label with a neutral avatar placeholder. */
  avatarSkeleton?: boolean
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

  if (avatarSkeleton && !avatar) {
    // Pending message chip: render the baked label as real text behind a neutral,
    // gently-pulsing avatar placeholder — the exact footprint the resolved chip
    // occupies. For a current-generation link the baked label already equals the
    // resolved "{author} … {where}", so resolving only swaps the placeholder for
    // the avatar image; the text doesn't move and the chip never reflows (INV-21).
    // Deliberately not a shimmer bar: a grey bar collapsing into taller, colored
    // text is itself the layout shift this is meant to avoid.
    return (
      <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
        <span className="h-4 w-4 shrink-0 animate-pulse rounded-[4px] bg-foreground/10" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
    )
  }

  if (avatar) {
    return (
      <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
        <Avatar className="h-4 w-4 shrink-0 rounded-[4px]">
          {avatar.url && <AvatarImage src={avatar.url} alt={avatar.name} />}
          <AvatarFallback className="rounded-[4px] bg-foreground/10 text-[8px] font-semibold">
            {avatar.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        {messageParts ? (
          // One text child, so the chip has a single avatar↔text gap that matches
          // the pending skeleton's footprint and doesn't reflow when it settles
          // (INV-21). Author truncates; the location suffix stays pinned so it
          // survives — its own leading space separates it from the author.
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
