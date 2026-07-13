import { forwardRef } from "react"
import type { Placement } from "@floating-ui/react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { PersonaAvatar } from "@/components/persona-avatar"
import { cn } from "@/lib/utils"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"
import type { Mentionable } from "./types"

export type MentionListRef = SuggestionListRef

interface MentionListProps {
  items: Mentionable[]
  clientRect: (() => DOMRect | null) | null
  command: (item: Mentionable) => void
  placement?: Placement
}

/** Avatar background and text colors by mention type */
const avatarStyles: Record<Mentionable["type"], string> = {
  user: "bg-[hsl(200_70%_50%/0.15)] text-[hsl(200_70%_50%)]",
  persona: "bg-primary/15 text-primary",
  bot: "bg-green-500/15 text-green-600 dark:text-green-400",
  broadcast: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
}

/** Type badge styles - small pill next to the slug */
const typeBadgeStyles: Record<Mentionable["type"], string> = {
  user: "bg-[hsl(200_70%_50%/0.1)] text-[hsl(200_70%_50%)]",
  persona: "bg-primary/10 text-primary",
  bot: "bg-green-500/10 text-green-600 dark:text-green-400",
  broadcast: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
}

const typeLabels: Record<Mentionable["type"], string> = {
  user: "User",
  persona: "AI",
  bot: "Bot",
  broadcast: "Notify",
}

function MentionItem({ item }: { item: Mentionable }) {
  const fallback = item.avatarEmoji ?? item.name.slice(0, 2).toUpperCase()

  return (
    <>
      {item.type === "persona" ? (
        <PersonaAvatar slug={item.slug} avatarUrl={item.avatarUrl} fallback={fallback} size="sm" />
      ) : (
        <Avatar className="h-7 w-7 shrink-0">
          <AvatarFallback className={cn("text-xs font-semibold", avatarStyles[item.type])}>{fallback}</AvatarFallback>
        </Avatar>
      )}
      <div className="flex flex-1 flex-col items-start min-w-0">
        <div className="flex items-center gap-1.5 w-full">
          <span className="text-[13px] font-medium truncate">
            {item.name}
            {item.isCurrentUser && <span className="text-muted-foreground font-normal"> (me)</span>}
          </span>
          <span
            className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0",
              item.mentionOnly ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : typeBadgeStyles[item.type]
            )}
          >
            {item.mentionOnly ? "Mention only" : typeLabels[item.type]}
          </span>
          {item.isPersonal && <span className="shrink-0 text-[10px] text-muted-foreground">Personal</span>}
        </div>
        <span className="text-xs text-muted-foreground truncate w-full">
          @{item.slug}
          {item.mentionOnly && " · only its owner can invoke it"}
        </span>
      </div>
    </>
  )
}

/**
 * Autocomplete list for @mentions.
 * Shows users, personas, and broadcast options with keyboard navigation.
 */
export const MentionList = forwardRef<MentionListRef, MentionListProps>(function MentionList(
  { items, clientRect, command, placement },
  ref
) {
  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={(item) => item.id}
      ariaLabel="Mention suggestions"
      renderItem={(item) => <MentionItem item={item} />}
      placement={placement}
      width="w-60"
      emptyState="No matches found"
    />
  )
})
