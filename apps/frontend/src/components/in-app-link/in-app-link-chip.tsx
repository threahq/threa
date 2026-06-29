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
 * face or sigil (restricted/pending, uncached message) fall back to a glyph. The
 * leading face/glyph occupies the same 16px slot in every variant so the chip
 * never changes height as it resolves (INV-21).
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
  /** Pending message chip: reserve the resolved avatar's footprint with a skeleton. */
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
    // A message resolves to "{author} to/in {where}", but the in-flight fallback
    // label is the link's baked markdown text, which can be stale (e.g. an older
    // viewer-relative "… to You"). Render it transparently under a shimmer: the
    // text is hidden so wrong words never flash, but it still reserves the baked
    // label's width — which for a current-generation chip equals the resolved
    // label — so the chip doesn't reflow surrounding text when it settles
    // (INV-21). Goes loading → final, never wrong-text → final.
    return (
      <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
        <span className="h-4 w-4 shrink-0 animate-pulse rounded-[4px] bg-foreground/10" aria-hidden="true" />
        <span
          className="inline-flex h-3 min-w-0 max-w-full animate-pulse items-center truncate rounded bg-foreground/10 text-transparent"
          aria-hidden="true"
        >
          {label}
        </span>
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
          <>
            {/* Author truncates; the location suffix stays pinned so it survives. */}
            <span className="min-w-0 truncate">{messageParts.lead}</span>
            {messageParts.tail && <span className="shrink-0 whitespace-nowrap">{messageParts.tail}</span>}
          </>
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
