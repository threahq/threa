import { RollingNumber } from "@/components/rolling-number"
import { forwardRef, useMemo, useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react"
import { SmilePlus, X } from "lucide-react"
import { useMessageReactions, stripColons, reactionShortcodes } from "@/hooks"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { cn } from "@/lib/utils"
import { ReactionEmojiPicker } from "./reaction-emoji-picker"
import { AllReactionsPopover } from "./all-reactions-popover"
import { ReactionPillDetails } from "./reaction-details"
import { GROW_MS, PopIn, SHRINK_MS } from "./pop-in"

const MAX_VISIBLE_REACTIONS = 5

interface MessageReactionsProps {
  reactions: Record<string, string[]>
  workspaceId: string
  messageId: string
  currentUserId: string | null
}

type Reaction = [shortcode: string, userIds: string[]]

interface ShownReaction {
  shortcode: string
  userIds: string[]
  arrivedAt: number | undefined
  leaving: boolean
}

interface ReactionMotion {
  seen: Set<string> | null
  shown: ShownReaction[]
  rowAt: number | undefined
  rowLeftAt: number | undefined
  pillAt: Map<string, number>
  pillLeftAt: Map<string, number>
}

/** An arrival time that makes something re-added mid-shrink grow back from
 *  about the size it had shrunk to, rather than from nothing. */
function returnedAt(now: number, leftAt: number | undefined) {
  if (leftAt === undefined) return now
  const shrunk = Math.min(1, (now - leftAt) / SHRINK_MS)
  return now - (1 - shrunk) * GROW_MS
}

/**
 * The pills to render, with the ones added while the message is on screen
 * growing in and the ones removed still shrinking out. The first render only
 * seeds, so reactions the message loaded with paint in place. The row as a
 * whole grows in on the first reaction and shrinks out on the last, its pills
 * holding still inside it.
 */
function useReactionMotion(visible: readonly Reaction[]) {
  const ref = useRef<ReactionMotion>({
    seen: null,
    shown: [],
    rowAt: undefined,
    rowLeftAt: undefined,
    pillAt: new Map(),
    pillLeftAt: new Map(),
  })
  const motion = ref.current
  const [, expire] = useReducer((n: number) => n + 1, 0)
  const now = performance.now()

  if (motion.seen) {
    const seen = motion.seen
    const current = new Set(visible.map(([shortcode]) => shortcode))
    const added = visible.filter(([shortcode]) => !seen.has(shortcode))
    if (visible.length === 0) {
      if (motion.shown.length > 0) motion.rowLeftAt ??= now
    } else {
      const rowLeftAt = motion.rowLeftAt
      motion.rowLeftAt = undefined
      if (seen.size === 0) motion.rowAt ??= returnedAt(now, rowLeftAt)
      else
        for (const [shortcode] of added)
          if (!motion.pillAt.has(shortcode)) motion.pillAt.set(shortcode, returnedAt(now, motion.pillLeftAt.get(shortcode)))
      for (const pill of motion.shown) {
        if (!pill.leaving && !current.has(pill.shortcode)) motion.pillLeftAt.set(pill.shortcode, now)
      }
    }
    for (const shortcode of current) motion.pillLeftAt.delete(shortcode)
  }

  let shown: ShownReaction[]
  if (visible.length === 0 && motion.rowLeftAt !== undefined) {
    shown = motion.shown
  } else {
    shown = visible.map(([shortcode, userIds]) => ({
      shortcode,
      userIds,
      arrivedAt: motion.pillAt.get(shortcode),
      leaving: false,
    }))
    motion.shown.forEach((pill, index) => {
      if (motion.pillLeftAt.has(pill.shortcode))
        shown.splice(Math.min(index, shown.length), 0, { ...pill, leaving: true })
    })
  }

  useLayoutEffect(() => {
    motion.seen = new Set(visible.map(([shortcode]) => shortcode))
    motion.shown = shown
    const at = performance.now()
    if (motion.rowAt !== undefined && at - motion.rowAt >= GROW_MS) motion.rowAt = undefined
    for (const [shortcode, t] of motion.pillAt) if (at - t >= GROW_MS) motion.pillAt.delete(shortcode)
  })

  // Leaving pills stay rendered until the last shrink ends, then one re-render
  // drops them all. A later leave moves `leavingUntil` and re-arms the timer, so
  // everything still leaving when it fires is done; re-checking the clock instead
  // strands them, since browsers truncate the delay and fire a fraction early.
  const leavingUntil = Math.max(motion.rowLeftAt ?? -Infinity, ...motion.pillLeftAt.values()) + SHRINK_MS
  useEffect(() => {
    if (!Number.isFinite(leavingUntil)) return
    const timer = window.setTimeout(() => {
      if (motion.rowLeftAt !== undefined) {
        motion.rowLeftAt = undefined
        motion.shown = []
      }
      motion.pillLeftAt.clear()
      expire()
    }, leavingUntil - performance.now())
    return () => window.clearTimeout(timer)
  }, [leavingUntil, motion])

  return {
    shown,
    rowAt: motion.rowAt,
    rowLeaving: visible.length === 0 && motion.rowLeftAt !== undefined,
  }
}

/** Mounted for every message, with or without reactions, so a first reaction
 *  can tell itself apart from reactions the message loaded with. */
export function MessageReactions(props: MessageReactionsProps) {
  const sorted = Object.entries(props.reactions)
    .filter(([, users]) => users.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  const { shown, rowAt, rowLeaving } = useReactionMotion(sorted.slice(0, MAX_VISIBLE_REACTIONS))

  if (shown.length === 0) return null
  return (
    <PopIn arrivedAt={rowAt} leaving={rowLeaving}>
      <ReactionRow {...props} shown={shown} overflowCount={sorted.length - MAX_VISIBLE_REACTIONS} />
    </PopIn>
  )
}

function ReactionRow({
  reactions,
  workspaceId,
  messageId,
  currentUserId,
  shown,
  overflowCount,
}: MessageReactionsProps & { shown: ShownReaction[]; overflowCount: number }) {
  const { toEmoji } = useWorkspaceEmoji(workspaceId)
  const { toggleReaction, toggleByEmoji } = useMessageReactions(workspaceId, messageId)

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
      {shown.map(({ shortcode, userIds, arrivedAt, leaving }) => (
        <PopIn key={shortcode} axis="x" arrivedAt={arrivedAt} leaving={leaving}>
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
