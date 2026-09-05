import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react"
import { useFloating, offset, flip, shift, autoUpdate, type Placement } from "@floating-ui/react"
import { cn } from "@/lib/utils"

/**
 * Common interface for suggestion list keyboard handling.
 * Each list component (MentionList, ChannelList, CommandList) implements this.
 */
export interface SuggestionListRef {
  onKeyDown: (event: KeyboardEvent) => boolean
}

export interface SuggestionListProps<T> {
  items: T[]
  clientRect: (() => DOMRect | null) | null
  command: (item: T) => void
  getKey: (item: T) => string
  ariaLabel: string
  width?: string
  renderItem: (item: T) => ReactNode
  /** Preferred placement direction. Defaults to "bottom-start". Uses flip() to auto-adjust. */
  placement?: Placement
  /** Content shown when items is empty. When omitted, the list returns null for zero results. */
  emptyState?: ReactNode
  /**
   * Opt in to a highlight that survives an items recompute. The highlight then
   * follows the row's key and resets only when this value changes, so a list
   * whose data ticks underneath it (an upload's progress) keeps the row the user
   * arrowed to. Pass the query for a list that re-ranks as you type — typing
   * must still land on the best match, not strand the highlight on a row that
   * has since fallen down the ranking.
   *
   * Omitted, every items change resets to the first row.
   */
  highlightResetKey?: string
  /**
   * Open with no row armed: nothing is highlighted and Enter/Tab fall through to
   * the editor until the user arrows or hovers. For a list that opens on a
   * prefix which is also markdown (`##` is an h2 marker) — the rows are visible
   * so the user knows to keep typing, and the key that would send still sends.
   */
  deferSelection?: boolean
}

/**
 * Generic autocomplete suggestion list with keyboard navigation.
 * Used as the base for MentionList, ChannelList, and CommandList.
 */
function SuggestionListInner<T>(
  {
    items,
    clientRect,
    command,
    getKey,
    ariaLabel,
    width = "w-64",
    renderItem,
    placement = "bottom-start",
    emptyState,
    highlightResetKey,
    deferSelection = false,
  }: SuggestionListProps<T>,
  ref: React.ForwardedRef<SuggestionListRef>
) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const keys = items.map(getKey)
  // The highlight follows the row's key, not its position, so a recompute that
  // only changes array identity can't move it. A key no longer in the list
  // resolves to the first row.
  const explicitIndex = selectedKey === null ? -1 : keys.indexOf(selectedKey)
  const selectedIndex = deferSelection && explicitIndex < 0 ? -1 : Math.max(0, explicitIndex)
  const keysRef = useRef<string[]>(keys)
  keysRef.current = keys
  const keySignature = keys.join("\u0000")

  const followsKey = highlightResetKey !== undefined

  useEffect(() => {
    if (followsKey) return
    setSelectedKey(null)
  }, [items, followsKey])

  useEffect(() => {
    if (!followsKey) return
    setSelectedKey(null)
  }, [highlightResetKey, followsKey])

  // Drop a highlight whose row is gone, so the state matches what is painted.
  useEffect(() => {
    if (!followsKey) return
    setSelectedKey((prev) => (prev !== null && keysRef.current.includes(prev) ? prev : null))
  }, [keySignature, followsKey])

  useEffect(() => {
    const selectedRef = itemRefs.current[selectedIndex]
    selectedRef?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  const { refs, floatingStyles } = useFloating({
    placement,
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  useEffect(() => {
    if (clientRect) {
      refs.setReference({
        getBoundingClientRect: () => clientRect() ?? new DOMRect(),
      })
    }
  }, [clientRect, refs])

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (items.length === 0) return false

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault()
          setSelectedKey(keys[selectedIndex < 0 ? items.length - 1 : (selectedIndex - 1 + items.length) % items.length])
          return true
        case "ArrowDown":
          event.preventDefault()
          setSelectedKey(keys[selectedIndex < 0 ? 0 : (selectedIndex + 1) % items.length])
          return true
        case "Tab":
        case "Enter":
          if (selectedIndex < 0) return false
          event.preventDefault()
          command(items[selectedIndex])
          return true
        case "Escape":
          return true
        default:
          return false
      }
    },
  }))

  if (!clientRect) return null

  const isEmpty = items.length === 0

  if (isEmpty && !emptyState) return null

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className={cn(
        "z-50 rounded-[10px] border bg-popover text-popover-foreground pointer-events-auto shadow-md",
        width
      )}
      role="listbox"
      aria-label={ariaLabel}
    >
      <div className="max-h-[min(280px,50dvh)] overflow-y-auto overscroll-contain touch-pan-y [-webkit-overflow-scrolling:touch]">
        <div className="p-1">
          {isEmpty ? (
            <div className="px-2.5 py-2 text-sm text-muted-foreground">{emptyState}</div>
          ) : (
            items.map((item, index) => (
              <button
                key={getKey(item)}
                ref={(el) => {
                  itemRefs.current[index] = el
                }}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none text-left",
                  "cursor-pointer transition-colors duration-100",
                  "hover:bg-muted",
                  index === selectedIndex && "bg-muted"
                )}
                onClick={() => command(item)}
                onMouseEnter={() => setSelectedKey(getKey(item))}
              >
                {renderItem(item)}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// forwardRef doesn't preserve generics, so we cast it
export const SuggestionList = forwardRef(SuggestionListInner) as <T>(
  props: SuggestionListProps<T> & { ref?: React.ForwardedRef<SuggestionListRef> }
) => ReturnType<typeof SuggestionListInner>
