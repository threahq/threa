import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { MentionIndicator } from "@/components/mention-indicator"
import { URGENCY_COLORS } from "@/components/layout/sidebar/config"
import type { QuickSwitcherItem } from "./types"

/**
 * Optional batch-selection layer. While `enabled`, every row becomes a toggle
 * (its leading icon/avatar swaps in place for a check circle — same footprint,
 * no layout shift per INV-21), navigation is suppressed, and per-row actions
 * hide. Mirrors the message timeline's batch-select look (`bg-primary/[0.07]`
 * ring-inset on the checked row).
 */
export interface ItemListSelection {
  enabled: boolean
  selectedIds: Set<string>
  onToggle: (id: string) => void
}

interface ItemListProps {
  items: QuickSwitcherItem[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onSelectItem: (item: QuickSwitcherItem, withModifier: boolean) => void
  isLoading?: boolean
  emptyMessage?: string
  selection?: ItemListSelection
}

/**
 * Leading check circle shown in a row's leading slot while batch selection is
 * on. Sized to the footprint of the visual it replaces — the `h-7 w-7` avatar
 * on avatar rows, the `h-4 w-4` icon otherwise — so entering select mode swaps
 * in place without shifting the row (INV-21).
 */
function SelectionToggle({ checked, large }: { checked: boolean; large?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-content-center border transition-colors",
        large ? "h-7 w-7 rounded-md" : "h-4 w-4 rounded-full",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40 bg-transparent"
      )}
    >
      {checked && <Check className={large ? "h-3.5 w-3.5" : "h-2.5 w-2.5"} strokeWidth={3} />}
    </span>
  )
}

export function ItemList({
  items,
  selectedIndex,
  onSelectIndex,
  onSelectItem,
  isLoading,
  emptyMessage,
  selection,
}: ItemListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedElement = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      selectedElement?.scrollIntoView({ block: "nearest" })
    }
  }, [selectedIndex])

  if (isLoading) {
    return <div className="py-6 text-center text-sm text-muted-foreground">Loading...</div>
  }

  if (items.length === 0 && emptyMessage) {
    return <div className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</div>
  }

  if (items.length === 0) {
    return null
  }

  const groups = items.reduce(
    (acc, item, index) => {
      const group = item.group ?? ""
      if (!acc[group]) {
        acc[group] = []
      }
      acc[group].push({ item, index })
      return acc
    },
    {} as Record<string, Array<{ item: QuickSwitcherItem; index: number }>>
  )

  const selectionEnabled = selection?.enabled ?? false

  const handleClick = (e: React.MouseEvent, item: QuickSwitcherItem) => {
    if (selectionEnabled) {
      // In batch mode the whole row is a selection toggle — never navigate.
      e.preventDefault()
      selection?.onToggle(item.id)
      return
    }
    const isModifier = e.metaKey || e.ctrlKey
    if (isModifier && item.href) {
      // Let the browser handle Cmd+click on links natively (opens in new tab)
      return
    }
    e.preventDefault()
    onSelectItem(item, isModifier)
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-multiselectable={selectionEnabled || undefined}
      className="max-h-[400px] overflow-y-auto p-2 max-sm:max-h-none max-sm:flex-1 max-sm:min-h-0"
    >
      {Object.entries(groups).map(([groupName, groupItems]) => (
        <div key={groupName || "_ungrouped"} role="group" aria-label={groupName || undefined} className="mb-1">
          {groupName && <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{groupName}</div>}
          {groupItems.map(({ item, index }) => {
            const Icon = item.icon
            const ActionIcon = item.actionIcon
            const isHighlighted = index === selectedIndex
            const isChecked = selection?.selectedIds.has(item.id) ?? false
            const iconFallback = Icon ? (
              <Icon className="h-3.5 w-3.5 opacity-60" />
            ) : (
              item.label.slice(0, 1).toUpperCase()
            )

            const hasUnread = (item.unreadCount ?? 0) > 0
            const urgency = item.urgency ?? "quiet"
            const showUrgencyStrip = urgency !== "quiet"

            let leadingVisual: React.ReactNode = null
            if (selectionEnabled) {
              leadingVisual = <SelectionToggle checked={isChecked} large={!!item.avatarUrl} />
            } else if (item.avatarUrl) {
              leadingVisual = (
                <Avatar className="h-7 w-7 rounded-md">
                  <AvatarImage src={item.avatarUrl} alt={item.label} />
                  <AvatarFallback className="rounded-md">{iconFallback}</AvatarFallback>
                </Avatar>
              )
            } else if (Icon) {
              leadingVisual = <Icon className="h-4 w-4 opacity-50" />
            }

            const itemContent = (
              <>
                {showUrgencyStrip && (
                  <div
                    className="w-1 flex-shrink-0 rounded-l-[10px] transition-colors duration-300"
                    style={{ backgroundColor: URGENCY_COLORS[urgency] }}
                  />
                )}
                <div className="flex items-center gap-3 flex-1 min-w-0 px-3 py-3">
                  {leadingVisual}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={cn("truncate", hasUnread ? "font-semibold" : "font-normal")}>{item.label}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground truncate">{item.description}</span>
                    )}
                  </div>
                  {(item.mentionCount ?? 0) > 0 && <MentionIndicator count={item.mentionCount!} className="ml-auto" />}
                  {!selectionEnabled && item.onAction && ActionIcon && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="reveal-actions h-7 w-7 shrink-0"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        item.onAction?.()
                      }}
                      aria-label={item.actionLabel}
                    >
                      <ActionIcon className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                    </Button>
                  )}
                </div>
              </>
            )

            const className = cn(
              "group reveal-host relative flex select-none items-stretch rounded-[10px] text-sm outline-none transition-colors",
              selectionEnabled ? "cursor-pointer" : "cursor-default",
              // ring-inset keeps the checked outline from nudging neighbours (INV-21).
              isChecked && "bg-primary/[0.07] ring-1 ring-primary/45 ring-inset",
              // In selection mode the highlight tracks real DOM focus, so a
              // keyboard user sees which focusable row Enter/Space will toggle,
              // and it can never desync from a separate index-based highlight.
              !isChecked && selectionEnabled && "hover:bg-muted focus:bg-muted",
              !isChecked && !selectionEnabled && (isHighlighted ? "bg-muted" : "hover:bg-muted")
            )

            // In batch mode a row never navigates, so it renders as a toggle
            // <div> even when it carries an href.
            if (item.href && !selectionEnabled) {
              return (
                <Link
                  key={item.id}
                  to={item.href}
                  role="option"
                  aria-selected={isHighlighted}
                  data-index={index}
                  className={className}
                  onMouseEnter={() => onSelectIndex(index)}
                  onClick={(e) => handleClick(e, item)}
                >
                  {itemContent}
                </Link>
              )
            }

            return (
              <div
                key={item.id}
                role="option"
                aria-selected={selectionEnabled ? isChecked : isHighlighted}
                data-index={index}
                // Selection rows are focusable toggles so the list is operable
                // by keyboard alone (Enter/Space); plain nav rows are not.
                tabIndex={selectionEnabled ? 0 : undefined}
                className={className}
                onMouseEnter={() => onSelectIndex(index)}
                onClick={(e) => handleClick(e, item)}
                onKeyDown={
                  selectionEnabled
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault()
                          // Keep the toggle from bubbling to an ancestor keydown
                          // handler that might act on the same key.
                          e.stopPropagation()
                          selection?.onToggle(item.id)
                        }
                      }
                    : undefined
                }
              >
                {itemContent}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
