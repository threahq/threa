import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, memo } from "react"
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { cn } from "@/lib/utils"
import {
  DESKTOP_GRID_COLUMNS as GRID_COLUMNS,
  chunkByColumns,
  indexToCoord,
  moveSelection,
  totalCount,
  type GridGeometry,
} from "@/lib/emoji-picker"
import type { EmojiEntry } from "@threa/types"
import type { SuggestionListRef } from "./suggestion-list"

const ROW_HEIGHT = 34 // w-8 (32px) + 2px vertical gap
const CONTAINER_HEIGHT = 256 // max-h-64 = 256px
const VirtuosoPadding = () => <div className="h-2" />

export interface EmojiGridProps {
  /** Recently used emojis (weight > 0), already filtered by the current query. Capped upstream. */
  recent: EmojiEntry[]
  /** All emojis in default order, already filtered by the current query. */
  all: EmojiEntry[]
  clientRect: (() => DOMRect | null) | null
  command: (item: EmojiEntry) => void
}

interface EmojiButtonProps {
  item: EmojiEntry
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
}

const EmojiButton = memo(function EmojiButton({ item, isSelected, onClick, onMouseEnter }: EmojiButtonProps) {
  return (
    <button
      role="option"
      aria-selected={isSelected}
      aria-label={`:${item.shortcode}:`}
      title={`:${item.shortcode}:`}
      data-selected={isSelected ? "true" : undefined}
      className={cn(
        "flex items-center justify-center w-8 h-8 rounded text-xl",
        "cursor-pointer hover:bg-accent",
        isSelected && "bg-accent ring-1 ring-ring"
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {item.emoji}
    </button>
  )
})

/**
 * Virtualized two-section emoji picker for the : trigger.
 * - Recently used (max 2 rows, non-virtualized)
 * - Emojis (virtualized, default order)
 *
 * Arrow keys navigate a combined flat index; crossing the section boundary
 * preserves the column.
 */
function EmojiGridInner(
  { recent, all, clientRect, command }: EmojiGridProps,
  ref: React.ForwardedRef<SuggestionListRef>
) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const rangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null)

  const geometry: GridGeometry = useMemo(
    () => ({ recentCount: recent.length, allCount: all.length, columns: GRID_COLUMNS }),
    [recent.length, all.length]
  )

  const total = totalCount(geometry)

  const allRows = useMemo(() => chunkByColumns(all, GRID_COLUMNS), [all])
  const recentRows = useMemo(() => chunkByColumns(recent, GRID_COLUMNS), [recent])

  useEffect(() => {
    setSelectedIndex(0)
    if (total > 0) {
      virtuosoRef.current?.scrollToIndex({ index: 0 })
    }
  }, [total])

  const scrollAllRowIfNeeded = (allRow: number) => {
    const range = rangeRef.current
    if (range && (allRow < range.startIndex || allRow > range.endIndex)) {
      virtuosoRef.current?.scrollToIndex({ index: allRow, align: allRow < range.startIndex ? "start" : "end" })
    }
  }

  const scrollAllRow = (allRow: number) => {
    virtuosoRef.current?.scrollToIndex({ index: allRow, align: "start" })
  }

  const ensureVisible = (index: number, force: boolean) => {
    const coord = indexToCoord(index, geometry)
    if (coord.section !== "all") return
    if (force) scrollAllRow(coord.row)
    else scrollAllRowIfNeeded(coord.row)
  }

  const visibleRowCount = Math.floor(CONTAINER_HEIGHT / ROW_HEIGHT)

  const { refs, floatingStyles } = useFloating({
    placement: "bottom-start",
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
      if (total === 0) return false

      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          event.preventDefault()
          const next = moveSelection(selectedIndex, event.key, geometry)
          if (next !== selectedIndex) {
            setSelectedIndex(next)
            ensureVisible(next, false)
          }
          return true
        }
        case "Home": {
          event.preventDefault()
          setSelectedIndex(0)
          ensureVisible(0, true)
          return true
        }
        case "End": {
          event.preventDefault()
          const last = total - 1
          setSelectedIndex(last)
          ensureVisible(last, true)
          return true
        }
        case "PageUp": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          if (coord.section === "all") {
            const newRow = Math.max(0, coord.row - visibleRowCount)
            const newIndex = geometry.recentCount + Math.min(newRow * GRID_COLUMNS + coord.col, all.length - 1)
            setSelectedIndex(newIndex)
            ensureVisible(newIndex, true)
          }
          return true
        }
        case "PageDown": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          if (coord.section === "all") {
            const allRowCount = Math.ceil(all.length / GRID_COLUMNS)
            const newRow = Math.min(allRowCount - 1, coord.row + visibleRowCount)
            const newIndex = geometry.recentCount + Math.min(newRow * GRID_COLUMNS + coord.col, all.length - 1)
            setSelectedIndex(newIndex)
            ensureVisible(newIndex, true)
          } else if (all.length > 0) {
            const newIndex = geometry.recentCount + Math.min(coord.col, all.length - 1)
            setSelectedIndex(newIndex)
            ensureVisible(newIndex, true)
          }
          return true
        }
        case "Tab":
        case "Enter": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          const item = coord.section === "recent" ? recent[selectedIndex] : all[selectedIndex - geometry.recentCount]
          if (item) command(item)
          return true
        }
        case "Escape":
          return true
        default:
          return false
      }
    },
  }))

  if (!clientRect || total === 0) return null

  const selectedCoord = indexToCoord(selectedIndex, geometry)
  const selectedEmoji =
    selectedCoord.section === "recent" ? recent[selectedIndex] : all[selectedIndex - geometry.recentCount]

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className="z-50 rounded-md border bg-popover text-popover-foreground shadow-md pointer-events-auto w-[280px]"
      role="listbox"
      aria-label="Emoji picker"
      data-emoji-grid
    >
      {recent.length > 0 && (
        <div className="px-2 pt-2 pb-1">
          <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider px-0.5 mb-1">
            Recently used
          </p>
          <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
            {recentRows.map((rowItems, rowIdx) =>
              rowItems.map((item, colIdx) => {
                const itemIndex = rowIdx * GRID_COLUMNS + colIdx
                return (
                  <EmojiButton
                    key={`recent-${item.shortcode}`}
                    item={item}
                    isSelected={itemIndex === selectedIndex}
                    onClick={() => command(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                  />
                )
              })
            )}
          </div>
        </div>
      )}
      {recent.length > 0 && all.length > 0 && <div className="border-t" />}
      {all.length > 0 && (
        <Virtuoso
          ref={virtuosoRef}
          totalCount={allRows.length}
          fixedItemHeight={ROW_HEIGHT}
          increaseViewportBy={ROW_HEIGHT * 3}
          rangeChanged={(range) => {
            rangeRef.current = range
          }}
          style={{ height: CONTAINER_HEIGHT }}
          components={{ Header: VirtuosoPadding, Footer: VirtuosoPadding }}
          itemContent={(index) => {
            const rowItems = allRows[index]
            const rowStartIndex = geometry.recentCount + index * GRID_COLUMNS
            return (
              <div className="flex gap-0.5 px-2 pb-0.5">
                {rowItems.map((item, colIndex) => {
                  const itemIndex = rowStartIndex + colIndex
                  return (
                    <EmojiButton
                      key={item.shortcode}
                      item={item}
                      isSelected={itemIndex === selectedIndex}
                      onClick={() => command(item)}
                      onMouseEnter={() => setSelectedIndex(itemIndex)}
                    />
                  )
                })}
              </div>
            )
          }}
        />
      )}
      {selectedEmoji && (
        <div className="border-t px-2 py-1.5 text-xs text-muted-foreground truncate">
          <span className="mr-1.5">{selectedEmoji.emoji}</span>
          <span className="font-mono">:{selectedEmoji.shortcode}:</span>
        </div>
      )}
    </div>
  )
}

export const EmojiGrid = forwardRef(EmojiGridInner)
