import { useState, useMemo, useCallback, useRef, useEffect, memo } from "react"
import { Search, SmilePlus } from "lucide-react"
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer"
import { useWorkspaceEmoji } from "@/hooks/use-workspace-emoji"
import { useCoarsePointer } from "@/hooks/use-pointer"
import { cn } from "@/lib/utils"
import {
  DESKTOP_GRID_COLUMNS,
  MAX_RECENTLY_USED_ROWS,
  chunkByColumns,
  filterBySearch,
  indexToCoord,
  moveSelection,
  pickRecentlyUsed,
  sortByDefaultOrder,
  totalCount,
  type GridGeometry,
} from "@/lib/emoji-picker"
import type { EmojiEntry } from "@threa/types"

const MOBILE_EMOJI_SIZE = 44
const MOBILE_ROW_HEIGHT = 46
const MobileVirtuosoPadding = () => <div className="h-1" />
const DesktopVirtuosoPadding = () => <div className="h-2" />
const DESKTOP_ROW_HEIGHT = 34
const CONTAINER_HEIGHT = 256
const MAX_MOBILE_COLUMNS = 8

interface ReactionEmojiPickerProps {
  workspaceId: string
  onSelect: (emoji: string) => void
  /** Custom trigger element — defaults to SmilePlus icon button */
  trigger?: React.ReactNode
  /** Additional class for the trigger wrapper */
  triggerClassName?: string
  /** Shortcodes the current user has already reacted with — highlighted */
  activeShortcodes?: Set<string>
  /** All shortcodes that have any reaction on this message (mine + others') */
  allReactionShortcodes?: Set<string>
  /** Controlled open state — when provided, the picker is externally controlled (no trigger rendered) */
  open?: boolean
  /** Controlled open change handler */
  onOpenChange?: (open: boolean) => void
}

interface EmojiButtonProps {
  item: EmojiEntry
  isSelected: boolean
  isActive: boolean
  isMobile: boolean
  onClick: () => void
  onMouseEnter: () => void
}

const EmojiButton = memo(function EmojiButton({
  item,
  isSelected,
  isActive,
  isMobile,
  onClick,
  onMouseEnter,
}: EmojiButtonProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      aria-label={`:${item.shortcode}:`}
      title={`:${item.shortcode}:`}
      data-selected={isSelected ? "true" : undefined}
      className={cn(
        "flex items-center justify-center rounded cursor-pointer",
        isMobile
          ? "w-full aspect-square text-2xl active:scale-90 transition-transform duration-75"
          : "w-8 h-8 text-xl hover:bg-accent active:bg-accent",
        isSelected && !isMobile && "bg-accent ring-1 ring-ring",
        isActive && "bg-primary/10 ring-1 ring-primary/30 rounded-lg"
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {item.emoji}
    </button>
  )
})

/** Shared emoji grid content used by both Popover (desktop) and Drawer (mobile) */
function EmojiGridContent({
  emojis,
  emojiWeights,
  activeShortcodes,
  allReactionShortcodes,
  search,
  setSearch,
  selectedIndex,
  setSelectedIndex,
  onSelect,
  onClose,
  searchInputRef,
  open,
  isMobile,
}: {
  emojis: EmojiEntry[]
  emojiWeights: Record<string, number>
  activeShortcodes: Set<string>
  allReactionShortcodes: Set<string>
  search: string
  setSearch: (s: string) => void
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  onSelect: (item: EmojiEntry) => void
  onClose: () => void
  searchInputRef: React.RefObject<HTMLInputElement | null>
  open: boolean
  isMobile: boolean
}) {
  const [columns, setColumns] = useState(isMobile ? MAX_MOBILE_COLUMNS : DESKTOP_GRID_COLUMNS)
  const rowHeight = isMobile ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const rangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null)
  const mobileContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isMobile || !mobileContainerRef.current) return
    const el = mobileContainerRef.current
    const measure = () => {
      const width = el.clientWidth ?? 0
      if (width > 0) {
        const cols = Math.min(MAX_MOBILE_COLUMNS, Math.max(5, Math.floor(width / MOBILE_EMOJI_SIZE)))
        setColumns(cols)
      }
    }
    requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [isMobile, open])

  const activeEmojis = useMemo(() => {
    if (allReactionShortcodes.size === 0) return []
    return emojis.filter((e) => allReactionShortcodes.has(e.shortcode))
  }, [emojis, allReactionShortcodes])

  const recentBase = useMemo(
    () => pickRecentlyUsed(emojis, emojiWeights, columns * MAX_RECENTLY_USED_ROWS),
    [emojis, emojiWeights, columns]
  )
  const allBase = useMemo(() => sortByDefaultOrder(emojis), [emojis])

  const recent = useMemo(() => filterBySearch(recentBase, search), [recentBase, search])
  const all = useMemo(() => filterBySearch(allBase, search), [allBase, search])

  const geometry: GridGeometry = useMemo(
    () => ({ recentCount: recent.length, allCount: all.length, columns }),
    [recent.length, all.length, columns]
  )

  const allRows = useMemo(() => chunkByColumns(all, columns), [all, columns])
  const recentRows = useMemo(() => chunkByColumns(recent, columns), [recent, columns])

  const total = totalCount(geometry)
  useEffect(() => {
    setSelectedIndex(0)
    if (open && total > 0) {
      virtuosoRef.current?.scrollToIndex({ index: 0 })
    }
  }, [total, open, setSelectedIndex])

  const scrollAllRowIfNeeded = useCallback((allRow: number) => {
    const range = rangeRef.current
    if (range && (allRow < range.startIndex || allRow > range.endIndex)) {
      virtuosoRef.current?.scrollToIndex({ index: allRow, align: allRow < range.startIndex ? "start" : "end" })
    }
  }, [])

  const scrollAllRow = useCallback((allRow: number) => {
    virtuosoRef.current?.scrollToIndex({ index: allRow, align: "start" })
  }, [])

  const ensureVisible = useCallback(
    (index: number, force: boolean) => {
      const coord = indexToCoord(index, geometry)
      if (coord.section !== "all") return
      if (force) scrollAllRow(coord.row)
      else scrollAllRowIfNeeded(coord.row)
    },
    [geometry, scrollAllRow, scrollAllRowIfNeeded]
  )

  const visibleRowCount = Math.floor(CONTAINER_HEIGHT / rowHeight)

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (total === 0) return

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
          break
        }
        case "Home": {
          event.preventDefault()
          setSelectedIndex(0)
          ensureVisible(0, true)
          break
        }
        case "End": {
          event.preventDefault()
          const last = total - 1
          setSelectedIndex(last)
          ensureVisible(last, true)
          break
        }
        case "PageUp": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          if (coord.section === "all") {
            const newRow = Math.max(0, coord.row - visibleRowCount)
            const newIndex = geometry.recentCount + Math.min(newRow * columns + coord.col, all.length - 1)
            setSelectedIndex(newIndex)
            ensureVisible(newIndex, true)
          }
          break
        }
        case "PageDown": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          if (coord.section === "all") {
            const allRowCount = Math.ceil(all.length / columns)
            const newRow = Math.min(allRowCount - 1, coord.row + visibleRowCount)
            const newIndex = geometry.recentCount + Math.min(newRow * columns + coord.col, all.length - 1)
            setSelectedIndex(newIndex)
            ensureVisible(newIndex, true)
          } else {
            // Jump from recent into the all section.
            if (all.length > 0) {
              const newIndex = geometry.recentCount + Math.min(coord.col, all.length - 1)
              setSelectedIndex(newIndex)
              ensureVisible(newIndex, true)
            }
          }
          break
        }
        case "Enter":
        case "Tab": {
          event.preventDefault()
          const coord = indexToCoord(selectedIndex, geometry)
          const item = coord.section === "recent" ? recent[selectedIndex] : all[selectedIndex - geometry.recentCount]
          if (item) onSelect(item)
          break
        }
        case "Escape": {
          event.preventDefault()
          onClose()
          break
        }
      }
    },
    [
      total,
      selectedIndex,
      geometry,
      recent,
      all,
      columns,
      visibleRowCount,
      setSelectedIndex,
      onSelect,
      onClose,
      ensureVisible,
    ]
  )

  const selectedEmoji: EmojiEntry | undefined = (() => {
    if (total === 0) return undefined
    const coord = indexToCoord(selectedIndex, geometry)
    if (coord.section === "recent") return recent[selectedIndex]
    return all[selectedIndex - geometry.recentCount]
  })()

  const renderRecentSection = (mobile: boolean) => {
    if (recent.length === 0) return null
    return (
      <div className={mobile ? "px-4 pb-2" : "px-2 pb-1"}>
        <p
          className={cn(
            "text-[10px] font-medium uppercase tracking-wider mb-1",
            mobile ? "text-muted-foreground/60" : "text-muted-foreground/70 px-0.5"
          )}
        >
          Recently used
        </p>
        <div
          className={mobile ? "grid gap-1" : "grid gap-0.5"}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {recentRows.map((rowItems, rowIdx) =>
            rowItems.map((item, colIdx) => {
              const itemIndex = rowIdx * columns + colIdx
              return (
                <EmojiButton
                  key={`recent-${item.shortcode}`}
                  item={item}
                  isSelected={itemIndex === selectedIndex}
                  isActive={activeShortcodes.has(item.shortcode)}
                  isMobile={mobile}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => setSelectedIndex(itemIndex)}
                />
              )
            })
          )}
        </div>
      </div>
    )
  }

  if (isMobile) {
    return (
      <>
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/50" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search emoji..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setSelectedIndex(0)
              }}
              className="w-full rounded-full bg-muted/60 pl-9 pr-4 py-2 text-sm outline-none placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>

        {activeEmojis.length > 0 && !search && (
          <div className="px-4 pb-2">
            <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">
              Reactions
            </p>
            <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {activeEmojis.map((item) => (
                <EmojiButton
                  key={item.shortcode}
                  item={item}
                  isSelected={false}
                  isActive={activeShortcodes.has(item.shortcode)}
                  isMobile={true}
                  onClick={() => onSelect(item)}
                  onMouseEnter={() => {}}
                />
              ))}
            </div>
          </div>
        )}

        {renderRecentSection(true)}

        {recent.length > 0 && all.length > 0 && <div className="border-t mx-4" />}

        {/* Emoji grid — stable container keeps ResizeObserver alive across empty/non-empty transitions */}
        <div ref={mobileContainerRef} style={{ height: "min(55dvh, 360px)" }}>
          {total === 0 && (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground px-4">
              No emojis found
            </div>
          )}
          {total > 0 && all.length > 0 && (
            <Virtuoso
              ref={virtuosoRef}
              totalCount={allRows.length}
              fixedItemHeight={MOBILE_ROW_HEIGHT}
              increaseViewportBy={MOBILE_ROW_HEIGHT * 3}
              style={{ height: "100%" }}
              components={{ Header: MobileVirtuosoPadding, Footer: MobileVirtuosoPadding }}
              role="listbox"
              aria-label="Emoji picker"
              itemContent={(index) => {
                const rowItems = allRows[index]
                const rowStartIndex = geometry.recentCount + index * columns
                return (
                  <div
                    className="px-4 pb-0.5"
                    style={{
                      display: "grid",
                      gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      gap: "2px",
                    }}
                  >
                    {rowItems.map((item, colIndex) => {
                      const itemIndex = rowStartIndex + colIndex
                      return (
                        <EmojiButton
                          key={item.shortcode}
                          item={item}
                          isSelected={itemIndex === selectedIndex}
                          isActive={activeShortcodes.has(item.shortcode)}
                          isMobile={true}
                          onClick={() => onSelect(item)}
                          onMouseEnter={() => setSelectedIndex(itemIndex)}
                        />
                      )
                    })}
                  </div>
                )
              }}
            />
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <div className="px-2 pt-2 pb-1">
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search emoji..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={handleKeyDown}
          className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {activeEmojis.length > 0 && !search && (
        <div className="px-2 pb-1">
          <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider px-0.5 mb-1">
            Reactions
          </p>
          <div className="flex gap-0.5 flex-wrap">
            {activeEmojis.map((item) => (
              <EmojiButton
                key={item.shortcode}
                item={item}
                isSelected={false}
                isActive={activeShortcodes.has(item.shortcode)}
                isMobile={false}
                onClick={() => onSelect(item)}
                onMouseEnter={() => {}}
              />
            ))}
          </div>
        </div>
      )}

      {renderRecentSection(false)}

      {recent.length > 0 && all.length > 0 && <div className="border-t" />}

      {total === 0 && (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground p-2"
          style={{ height: CONTAINER_HEIGHT }}
        >
          No emojis found
        </div>
      )}
      {total > 0 && all.length > 0 && (
        <Virtuoso
          ref={virtuosoRef}
          totalCount={allRows.length}
          fixedItemHeight={DESKTOP_ROW_HEIGHT}
          increaseViewportBy={DESKTOP_ROW_HEIGHT * 3}
          rangeChanged={(range) => {
            rangeRef.current = range
          }}
          style={{ height: CONTAINER_HEIGHT }}
          components={{ Header: DesktopVirtuosoPadding, Footer: DesktopVirtuosoPadding }}
          role="listbox"
          aria-label="Emoji picker"
          itemContent={(index) => {
            const rowItems = allRows[index]
            const rowStartIndex = geometry.recentCount + index * columns
            return (
              <div className="flex gap-0.5 px-2 pb-0.5">
                {rowItems.map((item, colIndex) => {
                  const itemIndex = rowStartIndex + colIndex
                  return (
                    <EmojiButton
                      key={item.shortcode}
                      item={item}
                      isSelected={itemIndex === selectedIndex}
                      isActive={activeShortcodes.has(item.shortcode)}
                      isMobile={false}
                      onClick={() => onSelect(item)}
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
    </>
  )
}

const EMPTY_SET = new Set<string>()

export function ReactionEmojiPicker({
  workspaceId,
  onSelect,
  trigger,
  triggerClassName,
  activeShortcodes = EMPTY_SET,
  allReactionShortcodes = EMPTY_SET,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ReactionEmojiPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : uncontrolledOpen
  const setOpen = isControlled ? (v: boolean) => controlledOnOpenChange?.(v) : setUncontrolledOpen
  const [search, setSearch] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const { emojis, emojiWeights } = useWorkspaceEmoji(workspaceId)
  // The input pointer drives the surface: a narrow desktop window gets the
  // popover, an iPad gets the drawer. Grid geometry follows the surface (not raw
  // viewport width) so the drawer always renders finger-sized rows and the
  // popover always renders the dense desktop grid.
  const useDrawer = useCoarsePointer()

  const handleSelect = useCallback(
    (item: EmojiEntry) => {
      onSelect(item.emoji)
      // In the drawer (touch), keep it open when toggling off an active reaction
      if (useDrawer && activeShortcodes.has(item.shortcode)) {
        return
      }
      setOpen(false)
      setSearch("")
      setSelectedIndex(0)
    },
    [onSelect, useDrawer, activeShortcodes]
  )

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setSearch("")
      setSelectedIndex(0)
    }
  }, [])

  const handleClose = useCallback(() => {
    setOpen(false)
    setSearch("")
    setSelectedIndex(0)
  }, [])

  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus()
    })
  }, [])

  const triggerElement = trigger ?? (
    <Button
      variant="outline"
      size="icon"
      className={cn("h-6 w-6 shadow-sm hover:border-primary/30 text-muted-foreground shrink-0", triggerClassName)}
      aria-label="Add reaction"
    >
      <SmilePlus className="h-3.5 w-3.5" />
    </Button>
  )

  const gridContent = (
    <EmojiGridContent
      emojis={emojis}
      emojiWeights={emojiWeights}
      activeShortcodes={activeShortcodes}
      allReactionShortcodes={allReactionShortcodes}
      search={search}
      setSearch={setSearch}
      selectedIndex={selectedIndex}
      setSelectedIndex={setSelectedIndex}
      onSelect={handleSelect}
      onClose={handleClose}
      searchInputRef={searchInputRef}
      open={open}
      isMobile={useDrawer}
    />
  )

  if (useDrawer) {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange}>
        {!isControlled && <DrawerTrigger asChild>{triggerElement}</DrawerTrigger>}
        <DrawerContent className="max-h-[85dvh]">
          <DrawerTitle className="sr-only">Pick an emoji</DrawerTitle>
          {gridContent}
          <div className="pb-[max(8px,env(safe-area-inset-bottom))]" />
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{triggerElement}</PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[280px] p-0"
        onCloseAutoFocus={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          focusSearch()
        }}
      >
        {gridContent}
      </PopoverContent>
    </Popover>
  )
}
