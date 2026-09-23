import { RollingNumber } from "@/components/rolling-number"
import { forwardRef, useMemo, useCallback, useLayoutEffect, useRef } from "react"
import { SmilePlus, X } from "lucide-react"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"
import { ReactionEmojiPicker } from "./reaction-emoji-picker"
import { AllReactionsPopover } from "./all-reactions-popover"
import { ReactionPillDetails } from "./reaction-details"
import { GROW_MS, PopIn } from "./pop-in"

const MAX_VISIBLE_REACTIONS = 5

interface MessageReactionsProps {
  reactions: Record<string, string[]>
  workspaceId: string
  messageId: string
  currentUserId: string | null
}

interface AddedReactions {
  seen: Set<string> | null
  /** When the row appeared on a message that had no reactions. */
  rowAt: number | undefined
  /** When each pill joined a row that was already showing. */
  pillAt: Map<string, number>
}

/**
 * Reactions added while the message is on screen. The first render only seeds,
 * so reactions the message already had paint in place.
 */
function useAddedReactions(shortcodes: readonly string[]): AddedReactions {
  const ref = useRef<AddedReactions>({ seen: null, rowAt: undefined, pillAt: new Map() })
  const added = ref.current
  const { seen } = added

  if (seen) {
    const fresh = shortcodes.filter((shortcode) => !seen.has(shortcode))
    if (fresh.length > 0) {
      const now = performance.now()
      if (seen.size === 0) added.rowAt ??= now
      else for (const shortcode of fresh) if (!added.pillAt.has(shortcode)) added.pillAt.set(shortcode, now)
    }
  }

  useLayoutEffect(() => {
    added.seen = new Set(shortcodes)
    const now = performance.now()
    if (added.rowAt !== undefined && now - added.rowAt >= GROW_MS) added.rowAt = undefined
    for (const [shortcode, at] of added.pillAt) if (now - at >= GROW_MS) added.pillAt.delete(shortcode)
  })

  return added
}

/** Mounted for every message, with or without reactions, so a first reaction
 *  can tell itself apart from reactions the message loaded with. */
export function MessageReactions(props: MessageReactionsProps) {
  const shortcodes = Object.entries(props.reactions)
    .filter(([, users]) => users.length > 0)
    .map(([shortcode]) => stripColons(shortcode))
  const added = useAddedReactions(shortcodes)

  if (shortcodes.length === 0) return null
  return (
    <PopIn arrivedAt={added.rowAt}>
      <ReactionRow {...props} pillAt={added.pillAt} />
    </PopIn>
  )
}

function ReactionRow({
  reactions,
  workspaceId,
  messageId,
  currentUserId,
  pillAt,
}: MessageReactionsProps & { pillAt: ReadonlyMap<string, number> }) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
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

  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5">
      {visibleReactions.map(([shortcode, userIds]) => (
        <PopIn key={shortcode} axis="x" arrivedAt={pillAt.get(stripColons(shortcode))}>
          <ReactionPillDetails emoji={shortcode} reactions={reactions} workspaceId={workspaceId}>
            <ReactionPill
              emoji={toEmoji(shortcode) ?? shortcode}
              userIds={userIds}
              currentUserId={currentUserId}
              onToggle={() => handleToggleReaction(shortcode)}
            />
          </ReactionPillDetails>
        </PopIn>
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
  onToggle: () => void
}

// Forwards ref and spreads extra props so Radix HoverCardTrigger `asChild` can inject handlers.
const ReactionPill = forwardRef<HTMLButtonElement, ReactionPillProps & React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ emoji, userIds, currentUserId, onToggle, ...rest }, ref) => {
    const hasReacted = currentUserId ? userIds.includes(currentUserId) : false

    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "reveal-host relative inline-flex min-h-[26px] items-center gap-1 rounded-full border pl-2 pr-2.5 text-xs transition-colors",
          hasReacted
            ? "border-primary/50 bg-primary/[0.14] text-primary hover:bg-primary/[0.2]"
            : "border-transparent bg-primary/[0.05] text-muted-foreground hover:bg-primary/[0.1] hover:text-foreground"
        )}
        onClick={onToggle}
        {...rest}
      >
        {/* Remove affordance: a mouse hover reveals the X over the emoji; touch
            taps the pill to toggle, so the X stays hidden there. */}
        <span className="relative text-sm leading-none w-4 h-4 flex items-center justify-center">
          <span>{emoji}</span>
          {hasReacted && <X className="reveal-actions-hover-only absolute inset-0 h-4 w-4 text-primary/70" />}
        </span>
        <span className={cn("tabular-nums", hasReacted && "font-medium")}>
          <RollingNumber value={userIds.length} />
        </span>
      </button>
    )
  }
)
ReactionPill.displayName = "ReactionPill"
