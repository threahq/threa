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
  }: SuggestionListProps<T>,
  ref: React.ForwardedRef<SuggestionListRef>
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

  // Scroll selected item into view
  useEffect(() => {
    const selectedRef = itemRefs.current[selectedIndex]
    selectedRef?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  const { refs, floatingStyles } = useFloating({
    placement,
    middleware: [offset(4), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  // Update reference element based on cursor position
  useEffect(() => {
    if (clientRect) {
      refs.setReference({
        getBoundingClientRect: () => clientRect() ?? new DOMRect(),
      })
    }
  }, [clientRect, refs])

  // Handle keyboard navigation
  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (items.length === 0) return false

      switch (event.key) {
        case "ArrowUp":
          event.preventDefault()
          setSelectedIndex((prev) => (prev - 1 + items.length) % items.length)
          return true
        case "ArrowDown":
          event.preventDefault()
          setSelectedIndex((prev) => (prev + 1) % items.length)
          return true
        case "Tab":
        case "Enter":
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
                onMouseEnter={() => setSelectedIndex(index)}
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
