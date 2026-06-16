import { Fragment, useMemo, useRef, type ReactNode } from "react"
import { AtSign, Maximize2, Paperclip, Plus, Slash } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useElementWidth } from "@/hooks/use-element-width"
import { cn } from "@/lib/utils"

/**
 * Approximate rendered width of one 28px icon button plus its 4px flex gap.
 * Rounding up biases the estimate toward folding one action early rather than
 * letting the bar overflow — a folded action is reachable in the "+" menu, an
 * overflowed bar wraps and looks broken (INV-21).
 */
const CONTROL_PX = 34

type CollapsibleKey = "emoji" | "mention" | "command" | "attach" | "expand"

interface CollapsibleAction {
  key: CollapsibleKey
  /** Display text — tooltip on the inline icon button, row text in the menu. */
  label: string
  /** Accessible name; defaults to `label` when the two should match. */
  ariaLabel?: string
  icon: ReactNode
  onSelect: () => void
  /** Lower folds into the overflow menu first as the bar narrows. */
  collapsePriority: number
}

/**
 * Decide which secondary actions stay inline and which fold into the overflow
 * menu for a given bar width. Pure so the responsiveness can be unit-tested
 * without a real ResizeObserver (jsdom stubs it to a no-op).
 *
 * Actions keep their incoming array order in both result lists (that's the
 * left-to-right display order); only `collapsePriority` decides *which* ones
 * fold. A constant slot is reserved for the always-present left affordance
 * (the format hint, or the "+" trigger) so the count doesn't oscillate as the
 * menu appears and disappears.
 */
export function planActionOverflow<T extends { key: string; collapsePriority: number }>(
  actions: T[],
  width: number,
  pinnedCount: number
): { inline: T[]; overflow: T[] } {
  // width === 0 means "not measured yet" — assume roomy so a freshly mounted
  // full-width composer paints expanded instead of flashing collapsed.
  const reservedPx = (pinnedCount + 1) * CONTROL_PX
  const inlineSlots = width === 0 ? actions.length : Math.max(0, Math.floor((width - reservedPx) / CONTROL_PX))
  const overflowCount = Math.max(0, actions.length - inlineSlots)
  if (overflowCount === 0) return { inline: actions, overflow: [] }

  const collapsed = new Set(
    [...actions]
      .sort((a, b) => a.collapsePriority - b.collapsePriority)
      .slice(0, overflowCount)
      .map((a) => a.key)
  )
  return {
    inline: actions.filter((a) => !collapsed.has(a.key)),
    overflow: actions.filter((a) => collapsed.has(a.key)),
  }
}

/**
 * How many of the un-foldable trigger buttons (dictation, stash, schedule) can
 * stay inline at a given width. Unlike the insert actions, these can't fold
 * into the "+" menu — their live overlays / popovers need a visible anchor — so
 * once the bar is too narrow even for the all-folded minimum (`+`, Aa, Send,
 * plus each trigger), the lowest-priority triggers are dropped. This is the
 * last-resort guard that keeps the row from spilling its pill at any width; it
 * only bites well below the panel and main-column floors, so in normal use
 * every trigger stays inline.
 */
export function planTriggerVisibility(width: number, triggerCount: number): number {
  if (width === 0) return triggerCount // unmeasured → assume roomy
  // Irreducible inline minimum with every action folded: "+", Aa, Send = 3 slots.
  const slots = Math.floor(width / CONTROL_PX)
  return Math.max(0, Math.min(triggerCount, slots - 3))
}

export interface ComposerActionBarProps {
  disabled?: boolean
  formatOpen: boolean
  onToggleFormat: () => void
  onInsertEmoji: () => void
  onInsertMention: () => void
  onInsertCommand: () => void
  onAttachClick: () => void
  /** Desktop fullscreen-expand entry point; omitted by hosts without one. */
  onExpandClick?: () => void
  /**
   * Dictation button. Can't fold into the "+" menu (its live recording overlays
   * — clock, polish toggle, error toast — anchor to the button), so it stays
   * inline and is the last trigger dropped if the bar is squeezed past the
   * all-folded minimum.
   */
  micButton?: ReactNode
  /** Stashed-drafts picker trigger; inline (its popover needs an anchor), dropped second under extreme squeeze. */
  stashedDraftsTrigger?: ReactNode
  /** Scheduled-messages picker trigger; inline (its popover needs an anchor), dropped first under extreme squeeze. */
  scheduledMessagesTrigger?: ReactNode
  sendButton: ReactNode
}

/**
 * The desktop composer's bottom action row. Folds its secondary insert actions
 * (emoji, mention, command, attach, expand) into a left-anchored "+" menu as
 * the composer narrows — so the bar stays on one clean line in a side panel or
 * small window instead of overflowing. Formatting and Send are always inline;
 * the un-foldable triggers (dictation, stash, schedule) drop from the tail only
 * if the bar is squeezed past the all-folded minimum (`+` Aa Send), so the row
 * can never spill its pill at any width.
 *
 * Container-width driven (not viewport): a narrow composer collapses even on a
 * large screen, which viewport breakpoints can't express.
 */
export function ComposerActionBar({
  disabled = false,
  formatOpen,
  onToggleFormat,
  onInsertEmoji,
  onInsertMention,
  onInsertCommand,
  onAttachClick,
  onExpandClick,
  micButton,
  stashedDraftsTrigger,
  scheduledMessagesTrigger,
  sendButton,
}: ComposerActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(barRef)

  const actions = useMemo<CollapsibleAction[]>(() => {
    const list: CollapsibleAction[] = []
    if (onExpandClick) {
      list.push({
        key: "expand",
        label: "Expand editor",
        ariaLabel: "Expand to fullscreen editor",
        icon: <Maximize2 className="h-3.5 w-3.5" />,
        onSelect: onExpandClick,
        collapsePriority: 1,
      })
    }
    list.push(
      {
        key: "emoji",
        label: "Emoji",
        icon: <span className="text-sm leading-none">😊</span>,
        onSelect: onInsertEmoji,
        collapsePriority: 2,
      },
      {
        key: "mention",
        label: "Mention",
        icon: <AtSign className="h-4 w-4" />,
        onSelect: onInsertMention,
        collapsePriority: 3,
      },
      {
        key: "command",
        label: "Command",
        icon: <Slash className="h-4 w-4" />,
        onSelect: onInsertCommand,
        collapsePriority: 0,
      },
      {
        key: "attach",
        label: "Attach files",
        icon: <Paperclip className="h-4 w-4" />,
        onSelect: onAttachClick,
        collapsePriority: 4,
      }
    )
    return list
  }, [onInsertEmoji, onInsertMention, onInsertCommand, onAttachClick, onExpandClick])

  // Un-foldable triggers in keep-priority order (dictation kept longest, schedule
  // dropped first). Each present one stays inline until the bar is squeezed past
  // the all-folded minimum, then drops from the tail.
  const triggers = useMemo(
    () =>
      [
        { key: "mic", node: micButton },
        { key: "stash", node: stashedDraftsTrigger },
        { key: "schedule", node: scheduledMessagesTrigger },
      ].filter((t) => t.node != null),
    [micButton, stashedDraftsTrigger, scheduledMessagesTrigger]
  )
  const visibleTriggerCount = planTriggerVisibility(width, triggers.length)
  const visibleTriggers = triggers.slice(0, visibleTriggerCount)

  // Formatting (Aa) + Send are always inline; folded actions reserve the "+" slot.
  const pinnedCount = 2 + visibleTriggerCount

  const { inline: inlineActions, overflow: overflowActions } = useMemo(
    () => planActionOverflow(actions, width, pinnedCount),
    [actions, width, pinnedCount]
  )

  // Expand sits immediately before Formatting (Aa) to match the pre-overflow
  // toolbar order; the rest of the collapsible actions render after Aa.
  const expandAction = inlineActions.find((a) => a.key === "expand")
  const mainInlineActions = inlineActions.filter((a) => a.key !== "expand")

  return (
    <div ref={barRef} className="flex items-center gap-1">
      {overflowActions.length > 0 ? (
        <>
          {/* Left-anchored overflow menu. Bordered so it reads as "more
              options" rather than just another flat ghost action. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="More actions"
                className="h-7 w-7 shrink-0 border border-input data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
                disabled={disabled}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            {/* Keep focus where each action puts it (the editor caret, a file
                dialog) instead of snapping back to the trigger on close, so the
                emoji/mention suggestion popups still anchor at the caret. */}
            <DropdownMenuContent
              side="top"
              align="start"
              className="min-w-[168px]"
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              {/* Render collapsed actions bottom-up so the leftmost toolbar item
                  sits closest to the "+" trigger and the rightmost item is
                  farthest away — matching the spatial order of the bar. */}
              {[...overflowActions].reverse().map((action) => (
                <DropdownMenuItem key={action.key} className="gap-2 cursor-pointer" onSelect={action.onSelect}>
                  <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">{action.icon}</span>
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
        </>
      ) : (
        // truncate, never wrap: a second line grows the bar and shifts the
        // composer (INV-21).
        <span className="text-[11px] text-muted-foreground flex-1 truncate select-none pointer-events-none">
          Select text to format
        </span>
      )}

      {expandAction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={expandAction.ariaLabel ?? expandAction.label}
              className="h-7 w-7 shrink-0"
              onClick={expandAction.onSelect}
              disabled={disabled}
            >
              {expandAction.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {expandAction.label}
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Formatting"
            aria-pressed={formatOpen}
            className={cn("h-7 w-7 shrink-0", formatOpen && "bg-accent text-accent-foreground")}
            onClick={onToggleFormat}
            disabled={disabled}
          >
            <span className="text-[13px] font-bold leading-none tracking-tight">Aa</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Formatting
        </TooltipContent>
      </Tooltip>

      {mainInlineActions.map((action) => (
        <Tooltip key={action.key}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={action.ariaLabel ?? action.label}
              className="h-7 w-7 shrink-0"
              onClick={action.onSelect}
              disabled={disabled}
            >
              {action.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {action.label}
          </TooltipContent>
        </Tooltip>
      ))}

      {visibleTriggers.map((t) => (
        <Fragment key={t.key}>{t.node}</Fragment>
      ))}
      {sendButton}
    </div>
  )
}
