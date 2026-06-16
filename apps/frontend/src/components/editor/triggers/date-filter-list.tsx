import { forwardRef, useCallback, useState, useImperativeHandle, useEffect, useRef } from "react"
import { formatISODate } from "@/lib/dates"
import { Calendar as CalendarIcon } from "lucide-react"
import { Calendar } from "@/components/ui/calendar"
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react"
import { cn } from "@/lib/utils"
import { SuggestionList, type SuggestionListRef, type SuggestionListProps } from "./suggestion-list"
import type { DateFilterItem, DateFilterType } from "./date-filter-extension"

interface DateFilterListProps extends Omit<
  SuggestionListProps<DateFilterItem>,
  "getKey" | "ariaLabel" | "renderItem"
> {}

export const DateFilterList = forwardRef<SuggestionListRef, DateFilterListProps>(function DateFilterList(
  { items, clientRect, command, placement },
  ref
) {
  const [showCalendar, setShowCalendar] = useState(false)
  const [filterType, setFilterType] = useState<DateFilterType>("after")
  const listRef = useRef<SuggestionListRef>(null)

  // Calendar is closed explicitly via:
  // - User selects a date (handleDateSelect)
  // - User presses Escape (onKeyDown handler)
  // - Popover closes entirely (parent handles via onExit)
  // We don't close on items change to avoid jarring UX when typing while calendar is open

  const { refs, floatingStyles } = useFloating({
    placement: placement ?? "bottom-start",
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

  const handleCommand = useCallback(
    (item: DateFilterItem) => {
      if (item.isCustom) {
        setFilterType(item.filterType)
        setShowCalendar(true)
      } else {
        command(item)
      }
    },
    [command]
  )

  const handleDateSelect = useCallback(
    (date: Date | undefined) => {
      if (date) {
        const isoDate = formatISODate(date)
        const syntheticItem: DateFilterItem = {
          id: "selected",
          label: isoDate,
          value: isoDate,
          description: "Selected date",
          filterType,
        }
        command(syntheticItem)
        setShowCalendar(false)
      }
    },
    [command, filterType]
  )

  useImperativeHandle(ref, () => ({
    onKeyDown: (event: KeyboardEvent) => {
      if (showCalendar) {
        if (event.key === "Escape") {
          setShowCalendar(false)
          return true
        }
        // Calendar handles its own keyboard navigation
        return false
      }
      return listRef.current?.onKeyDown(event) ?? false
    },
  }))

  const renderItem = useCallback((item: DateFilterItem) => <DateFilterItemContent item={item} />, [])

  if (!clientRect) return null

  if (showCalendar) {
    return (
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={cn("z-50 rounded-md border bg-popover text-popover-foreground shadow-md", "p-0 overflow-hidden")}
        role="dialog"
        aria-label="Date picker"
      >
        <Calendar mode="single" onSelect={handleDateSelect} className="rounded-md" defaultMonth={new Date()} />
      </div>
    )
  }

  return (
    <SuggestionList
      ref={listRef}
      items={items}
      clientRect={clientRect}
      command={handleCommand}
      getKey={(item) => item.id}
      ariaLabel="Date options"
      width="220px"
      renderItem={renderItem}
      placement={placement}
    />
  )
})

function DateFilterItemContent({ item }: { item: DateFilterItem }) {
  return (
    <>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex flex-1 flex-col items-start min-w-0">
        <span className="font-medium">{item.label}</span>
        <span className="text-xs text-muted-foreground">{item.description}</span>
      </div>
    </>
  )
}
