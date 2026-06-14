import { useMemo, useRef, type ReactNode } from "react"
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
   * Dictation button. Kept inline at every width — its live recording overlays
   * (clock, polish toggle, error toast) anchor to the button, so it can't fold
   * into the menu.
   */
  micButton?: ReactNode
  /** Stashed-drafts picker trigger; kept inline (its popover needs an anchor). */
  stashedDraftsTrigger?: ReactNode
  /** Scheduled-messages picker trigger; kept inline (its popover needs an anchor). */
  scheduledMessagesTrigger?: ReactNode
  sendButton: ReactNode
}

/**
 * The desktop composer's bottom action row. Folds its secondary insert actions
 * (emoji, mention, command, attach, expand) into a left-anchored "+" menu as
 * the composer narrows — so the bar stays on one clean line in a side panel or
 * small window instead of overflowing. Formatting, dictation, stash, schedule
 * and Send are always reachable.
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
    const list: CollapsibleAction[] = [
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
      },
    ]
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
    return list
  }, [onInsertEmoji, onInsertMention, onInsertCommand, onAttachClick, onExpandClick])

  // Formatting (Aa) + Send are always present; the picker slots only when host-provided.
  const pinnedCount = 2 + (micButton ? 1 : 0) + (stashedDraftsTrigger ? 1 : 0) + (scheduledMessagesTrigger ? 1 : 0)

  const { inline: inlineActions, overflow: overflowActions } = useMemo(
    () => planActionOverflow(actions, width, pinnedCount),
    [actions, width, pinnedCount]
  )

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
              {overflowActions.map((action) => (
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

      {inlineActions.map((action) => (
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

      {micButton}
      {stashedDraftsTrigger}
      {scheduledMessagesTrigger}
      {sendButton}
    </div>
  )
}
