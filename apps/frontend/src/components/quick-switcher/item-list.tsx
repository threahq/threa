import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { MentionIndicator } from "@/components/mention-indicator"
import { URGENCY_COLORS } from "@/components/layout/sidebar/config"
import type { QuickSwitcherItem } from "./types"

interface ItemListProps {
  items: QuickSwitcherItem[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  onSelectItem: (item: QuickSwitcherItem, withModifier: boolean) => void
  isLoading?: boolean
  emptyMessage?: string
}

export function ItemList({
  items,
  selectedIndex,
  onSelectIndex,
  onSelectItem,
  isLoading,
  emptyMessage,
}: ItemListProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll selected item into view
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

  // Group items by their group property
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

  const handleClick = (e: React.MouseEvent, item: QuickSwitcherItem) => {
    // Modifier clicks route through onSelectItem too, so mouse and Enter
    // share one path: panel-able destinations open in a new side panel,
    // anything else in a new browser tab.
    e.preventDefault()
    onSelectItem(item, e.metaKey || e.ctrlKey)
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      className="max-h-[400px] overflow-y-auto p-2 max-sm:max-h-none max-sm:flex-1 max-sm:min-h-0"
    >
      {Object.entries(groups).map(([groupName, groupItems]) => (
        <div key={groupName || "_ungrouped"} role="group" aria-label={groupName || undefined} className="mb-1">
          {groupName && <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{groupName}</div>}
          {groupItems.map(({ item, index }) => {
            const Icon = item.icon
            const ActionIcon = item.actionIcon
            const isSelected = index === selectedIndex
            const iconFallback = Icon ? (
              <Icon className="h-3.5 w-3.5 opacity-60" />
            ) : (
              item.label.slice(0, 1).toUpperCase()
            )

            const hasUnread = (item.unreadCount ?? 0) > 0
            const urgency = item.urgency ?? "quiet"
            const showUrgencyStrip = urgency !== "quiet"

            const itemContent = (
              <>
                {showUrgencyStrip && (
                  <div
                    className="w-1 flex-shrink-0 rounded-l-[10px] transition-colors duration-300"
                    style={{ backgroundColor: URGENCY_COLORS[urgency] }}
                  />
                )}
                <div className="flex items-center gap-3 flex-1 min-w-0 px-3 py-3">
                  {item.avatarUrl ? (
                    <Avatar className="h-7 w-7 rounded-md">
                      <AvatarImage src={item.avatarUrl} alt={item.label} />
                      <AvatarFallback className="rounded-md">{iconFallback}</AvatarFallback>
                    </Avatar>
                  ) : (
                    Icon && <Icon className="h-4 w-4 opacity-50" />
                  )}
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className={cn("truncate", hasUnread ? "font-semibold" : "font-normal")}>{item.label}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground truncate">{item.description}</span>
                    )}
                  </div>
                  {(item.mentionCount ?? 0) > 0 && <MentionIndicator count={item.mentionCount!} className="ml-auto" />}
                  {item.onAction && ActionIcon && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 max-sm:opacity-100 transition-opacity"
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
              "group relative flex cursor-default select-none items-stretch rounded-[10px] text-sm outline-none transition-colors",
              isSelected ? "bg-muted" : "hover:bg-muted"
            )

            if (item.href) {
              return (
                <Link
                  key={item.id}
                  to={item.href}
                  role="option"
                  aria-selected={isSelected}
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
                aria-selected={isSelected}
                data-index={index}
                className={className}
                onMouseEnter={() => onSelectIndex(index)}
                onClick={(e) => handleClick(e, item)}
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
