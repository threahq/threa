import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { MentionIndicator } from "@/components/mention-indicator"
import { useLongPress } from "@/hooks/use-long-press"
import { useTouchCapable } from "@/hooks/use-touch-capable"
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

  // Move focus relative to the option that currently holds it, in RENDER order.
  // Rows render grouped, so the flat `data-index` is not visual order — a group
  // can own non-adjacent indices. Walking the live `[data-index]` node list
  // keeps Up/Down matching what the user sees.
  const focusOptionFrom = (currentIndex: number, to: "next" | "prev" | "first" | "last") => {
    const list = listRef.current
    if (!list) return
    const options = Array.from(list.querySelectorAll<HTMLElement>("[data-index]"))
    if (options.length === 0) return
    const pos = options.findIndex((el) => el.dataset.index === String(currentIndex))
    const target = {
      next: Math.min(pos + 1, options.length - 1),
      prev: Math.max(pos - 1, 0),
      first: 0,
      last: options.length - 1,
    }[to]
    options[target]?.focus()
  }

  // Roving arrow-key navigation for selection mode: the listbox is one tab stop
  // (only the active option has tabIndex 0), and Up/Down/Home/End move focus
  // between options, per the WAI-ARIA listbox pattern. Enter/Space toggle.
  const handleSelectionKeyDown = (e: React.KeyboardEvent, index: number, itemId: string) => {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault()
        e.stopPropagation()
        selection?.onToggle(itemId)
        break
      case "ArrowDown":
        e.preventDefault()
        e.stopPropagation()
        focusOptionFrom(index, "next")
        break
      case "ArrowUp":
        e.preventDefault()
        e.stopPropagation()
        focusOptionFrom(index, "prev")
        break
      case "Home":
        e.preventDefault()
        e.stopPropagation()
        focusOptionFrom(index, "first")
        break
      case "End":
        e.preventDefault()
        e.stopPropagation()
        focusOptionFrom(index, "last")
        break
    }
  }

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
          {groupItems.map(({ item, index }) => (
            <ItemRow
              key={item.id}
              item={item}
              index={index}
              isHighlighted={index === selectedIndex}
              isChecked={selection?.selectedIds.has(item.id) ?? false}
              selectionEnabled={selectionEnabled}
              onSelectIndex={onSelectIndex}
              onClick={handleClick}
              onSelectionKeyDown={handleSelectionKeyDown}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * One list row. A component (not inlined in the map) because a row owns
 * hook-driven state: the long-press gesture that opens its context drawer on
 * touch.
 */
function ItemRow({
  item,
  index,
  isHighlighted,
  isChecked,
  selectionEnabled,
  onSelectIndex,
  onClick,
  onSelectionKeyDown,
}: {
  item: QuickSwitcherItem
  index: number
  isHighlighted: boolean
  isChecked: boolean
  selectionEnabled: boolean
  onSelectIndex: (index: number) => void
  onClick: (e: React.MouseEvent, item: QuickSwitcherItem) => void
  onSelectionKeyDown: (e: React.KeyboardEvent, index: number, itemId: string) => void
}) {
  const Icon = item.icon
  const touchCapable = useTouchCapable()

  // A long press on a navigating row has to suppress the synthetic click that
  // follows it, or the drawer opens AND the row routes away underneath it. A
  // timestamp window, not a boolean: with no synthetic click (the platform does
  // not always send one) a boolean latch would swallow the user's next real tap.
  // Same shape as `useSidebarItemDrawer`, whose rows are also links.
  const suppressClicksUntilRef = useRef(0)

  // Additive touch gesture; a mouse never fires it, and batch mode owns the whole
  // row as a selection toggle. NOTE: no `deferToInteractiveElements` — these
  // handlers sit ON the row's own `<a href>`, and that option's `closest()` test
  // matches the element itself, so it would refuse every touch on the row and the
  // gesture would never fire at all. The menu button is kept from arming it by
  // stopping touchstart at its wrapper instead.
  const longPress = useLongPress({
    enabled: touchCapable && !selectionEnabled && !!item.onLongPress,
    // The action drawer is Vaul gesture-aware. Mount it only after the held
    // touch ends so the opening finger cannot drive its first release frame.
    triggerOnTouchEnd: true,
    onLongPress: () => {
      suppressClicksUntilRef.current = Date.now() + 750
      item.onLongPress?.()
    },
  })

  // Roving tabindex in selection mode: active option is the tab stop.
  let rowTabIndex: number | undefined
  if (selectionEnabled) rowTabIndex = isHighlighted ? 0 : -1
  const iconFallback = Icon ? <Icon className="h-3.5 w-3.5 opacity-60" /> : item.label.slice(0, 1).toUpperCase()

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
          {item.description && <span className="text-xs text-muted-foreground truncate">{item.description}</span>}
        </div>
        {(item.mentionCount ?? 0) > 0 && <MentionIndicator count={item.mentionCount!} className="ml-auto" />}
        {!selectionEnabled && item.contextMenu && (
          // The row is a <Link>; a menu click must never navigate it.
          <div
            className="shrink-0"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            // Holding the ⋮ trigger must not also arm the row's long press.
            onTouchStart={(e) => e.stopPropagation()}
          >
            {item.contextMenu}
          </div>
        )}
      </div>
    </>
  )

  const className = cn(
    "group reveal-host relative flex select-none items-stretch rounded-[10px] text-sm outline-none transition-colors",
    selectionEnabled ? "cursor-pointer" : "cursor-default",
    // ring-inset keeps the checked outline from nudging neighbours (INV-21).
    isChecked && "bg-primary/[0.07] ring-1 ring-primary/45 ring-inset",
    // In selection mode the highlight tracks real DOM focus, so a keyboard user
    // sees which focusable row Enter/Space will toggle, and it can never desync
    // from a separate index-based highlight.
    !isChecked && selectionEnabled && "hover:bg-muted focus:bg-muted",
    !isChecked && !selectionEnabled && (isHighlighted ? "bg-muted" : "hover:bg-muted"),
    longPress.isPressed && "bg-muted"
  )

  // In batch mode a row never navigates, so it renders as a toggle <div> even
  // when it carries an href.
  if (item.href && !selectionEnabled) {
    return (
      <Link
        to={item.href}
        role="option"
        aria-selected={isHighlighted}
        data-index={index}
        className={className}
        onMouseEnter={() => onSelectIndex(index)}
        onClick={(e) => {
          if (suppressClicksUntilRef.current > Date.now()) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onClick(e, item)
        }}
        onTouchStart={longPress.handlers.onTouchStart}
        onTouchEnd={longPress.handlers.onTouchEnd}
        onTouchMove={longPress.handlers.onTouchMove}
        onTouchCancel={longPress.handlers.onTouchCancel}
        onContextMenu={longPress.handlers.onContextMenu}
      >
        {itemContent}
      </Link>
    )
  }

  return (
    <div
      role="option"
      aria-selected={selectionEnabled ? isChecked : isHighlighted}
      data-index={index}
      // Roving tabindex: only the active option is a tab stop, so the list is
      // one Tab stop and Arrow keys move between options (handled in
      // onSelectionKeyDown). Plain nav rows aren't focusable.
      tabIndex={rowTabIndex}
      className={className}
      // In selection mode the roving anchor follows focus, not hover, so the
      // sole tab stop can't drift out from under the focused row (hover
      // highlight is CSS-only via focus:/hover:bg-muted).
      onMouseEnter={selectionEnabled ? undefined : () => onSelectIndex(index)}
      onFocus={selectionEnabled ? () => onSelectIndex(index) : undefined}
      onClick={(e) => onClick(e, item)}
      onKeyDown={selectionEnabled ? (e) => onSelectionKeyDown(e, index, item.id) : undefined}
      onTouchStart={longPress.handlers.onTouchStart}
      onTouchEnd={longPress.handlers.onTouchEnd}
      onTouchMove={longPress.handlers.onTouchMove}
      onTouchCancel={longPress.handlers.onTouchCancel}
      onContextMenu={longPress.handlers.onContextMenu}
    >
      {itemContent}
    </div>
  )
}
