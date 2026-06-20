import { forwardRef, useMemo, useCallback } from "react"
import { SmilePlus, X } from "lucide-react"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks"
import { useCoarsePointer } from "@/hooks/use-pointer"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"
import { ReactionEmojiPicker } from "./reaction-emoji-picker"
import { AllReactionsPopover } from "./all-reactions-popover"
import { ReactionPillDetails } from "./reaction-details"

const MAX_VISIBLE_REACTIONS = 5

interface MessageReactionsProps {
  reactions: Record<string, string[]>
  workspaceId: string
  messageId: string
  currentUserId: string | null
}

export function MessageReactions({ reactions, workspaceId, messageId, currentUserId }: MessageReactionsProps) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const isTouch = useCoarsePointer()
  const { toggleReaction, toggleByEmoji } = useMessageReactions(workspaceId, messageId)

  const sortedReactions = useMemo(() => {
    return Object.entries(reactions)
      .filter(([, users]) => users.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
  }, [reactions])

  const visibleReactions = sortedReactions.slice(0, MAX_VISIBLE_REACTIONS)
  const overflowCount = sortedReactions.length - MAX_VISIBLE_REACTIONS

  const activeShortcodes = useMemo(() => {
    if (!currentUserId) return new Set<string>()
    const active = new Set<string>()
    for (const [shortcode, userIds] of Object.entries(reactions)) {
      if (userIds.includes(currentUserId)) {
        active.add(stripColons(shortcode))
      }
    }
    return active
  }, [currentUserId, reactions])

  const allReactionShortcodes = useMemo(() => reactionShortcodes(reactions), [reactions])

  const handleToggleReaction = useCallback(
    (shortcode: string) => toggleReaction(shortcode, reactions, currentUserId),
    [toggleReaction, reactions, currentUserId]
  )

  if (sortedReactions.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {visibleReactions.map(([shortcode, userIds]) => (
        <ReactionPillDetails key={shortcode} emoji={shortcode} reactions={reactions} workspaceId={workspaceId}>
          <ReactionPill
            emoji={toEmoji(shortcode) ?? shortcode}
            userIds={userIds}
            currentUserId={currentUserId}
            isTouch={isTouch}
            onToggle={() => handleToggleReaction(shortcode)}
          />
        </ReactionPillDetails>
      ))}

      {overflowCount > 0 && (
        <AllReactionsPopover reactions={reactions} workspaceId={workspaceId}>
          <button
            type="button"
            className="inline-flex min-h-[26px] items-center gap-1 rounded-full border border-transparent bg-primary/[0.05] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-primary/[0.1] hover:text-foreground"
          >
            +{overflowCount}
          </button>
        </AllReactionsPopover>
      )}

      <ReactionEmojiPicker
        workspaceId={workspaceId}
        onSelect={(emoji) => toggleByEmoji(emoji, reactions, currentUserId)}
        activeShortcodes={activeShortcodes}
        allReactionShortcodes={allReactionShortcodes}
        trigger={
          <button
            type="button"
            className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-primary/[0.08] hover:text-primary"
            aria-label="Add reaction"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
        }
      />
    </div>
  )
}

interface ReactionPillProps {
  emoji: string
  userIds: string[]
  currentUserId: string | null
  isTouch: boolean
  onToggle: () => void
}

// Forwards ref and spreads extra props so Radix HoverCardTrigger `asChild` can inject handlers.
const ReactionPill = forwardRef<HTMLButtonElement, ReactionPillProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ emoji, userIds, currentUserId, isTouch, onToggle, ...rest }, ref) => {
    const hasReacted = currentUserId ? userIds.includes(currentUserId) : false

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "group/pill relative inline-flex min-h-[26px] items-center gap-1 rounded-full border pl-2 pr-2.5 text-xs transition-colors",
          hasReacted
            ? "border-primary/50 bg-primary/[0.14] text-primary hover:bg-primary/[0.2]"
            : "border-transparent bg-primary/[0.05] text-muted-foreground hover:bg-primary/[0.1] hover:text-foreground"
        )}
        onClick={onToggle}
        {...rest}
      >
        {/* Emoji — with a fine pointer, fades to X icon on hover when user has reacted */}
        <span className="relative text-sm leading-none w-4 h-4 flex items-center justify-center">
          <span className={cn("transition-opacity", hasReacted && !isTouch && "group-hover/pill:opacity-0")}>
            {emoji}
          </span>
          {hasReacted && !isTouch && (
            <X className="absolute inset-0 h-4 w-4 opacity-0 group-hover/pill:opacity-100 transition-opacity text-primary/70" />
          )}
        </span>
        <span className={cn("tabular-nums", hasReacted && "font-medium")}>{userIds.length}</span>
      </button>
    )
  }
)
ReactionPill.displayName = "ReactionPill"
