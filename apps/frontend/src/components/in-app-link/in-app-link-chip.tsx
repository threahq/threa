import { type ComponentType, type ReactNode } from "react"
import { Link2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import { chipBase, triggerStyles } from "@/lib/markdown/mention-renderer"
import type { ChipAvatar } from "@/hooks/use-in-app-link-chip"

const inlineChip = "inline-flex max-w-[16rem] items-center gap-1 align-bottom"

/**
 * Inline chip for an in-app stream/message link, shared by the composer NodeView
 * (`InAppLinkView`) and the timeline markdown renderer (`MarkdownLink`) — the
 * same split `MemoChip` uses. Speaks the mention vocabulary (`chipBase` shape +
 * the channel `triggerStyles` palette): a channel shows its `#` as a text
 * prefix, reading exactly like a `#channel` mention. A message leads with its
 * author's face (`avatar`), reading like "{author} in #channel"; kinds with no
 * face or sigil (restricted/pending, uncached message) fall back to a glyph.
 */
export function InAppLinkChip({
  icon: Icon,
  prefix,
  label,
  avatar,
  className,
}: {
  icon?: ComponentType<{ className?: string }>
  prefix?: string
  label: ReactNode
  avatar?: ChipAvatar
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

  if (avatar) {
    return (
      <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
        <Avatar className="h-4 w-4 shrink-0 rounded-[4px]">
          {avatar.url && <AvatarImage src={avatar.url} alt={avatar.name} />}
          <AvatarFallback className="rounded-[4px] bg-foreground/10 text-[8px] font-semibold">
            {avatar.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <span className="truncate">{label}</span>
      </span>
    )
  }

  const ChipIcon = Icon ?? Link2
  return (
    <span className={cn(chipBase, inlineChip, triggerStyles.channel, className)} data-type="in-app-link-chip">
      <ChipIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}
