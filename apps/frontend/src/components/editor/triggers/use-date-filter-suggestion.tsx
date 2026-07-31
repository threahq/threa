import { useCallback, useState, useRef } from "react"
import { createPortal } from "react-dom"
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion"
import { DateFilterList } from "./date-filter-list"
import { getDateFilterOptions, type DateFilterItem, type DateFilterType } from "./date-filter-extension"
import type { SuggestionListRef } from "./suggestion-list"
import { rankMatches } from "@/lib/match-score"

interface DateFilterState {
  items: DateFilterItem[]
  clientRect: (() => DOMRect | null) | null
  command: ((item: DateFilterItem) => void) | null
  filterType: DateFilterType
}

/**
 * Filters date options by query, surfacing a custom option when the query is a
 * partial ISO date (YYYY-MM-DD).
 */
export function filterDateOptions(items: DateFilterItem[], query: string): DateFilterItem[] {
  if (!query) return items

  const isDateLike = /^\d{4}(-\d{0,2})?(-\d{0,2})?$/.test(query)
  if (isDateLike) {
    const filterType = items[0]?.filterType ?? "after"
    const customOption: DateFilterItem = {
      id: "custom",
      label: query,
      value: query,
      description: "Custom date",
      filterType,
    }
    return [customOption, ...items.filter((item) => item.value.startsWith(query))]
  }

  return rankMatches(items, query, (item) => ({ labels: [item.label], keywords: [item.value] }))
}

function detectFilterType(text: string): DateFilterType {
  if (text.startsWith("before:")) return "before"
  return "after"
}

/**
 * Hook for managing date filter suggestions (`after:` and `before:` triggers).
 */
export function useDateFilterSuggestion() {
  const [state, setState] = useState<DateFilterState | null>(null)
  const listRef = useRef<SuggestionListRef>(null)
  const currentFilterTypeRef = useRef<DateFilterType>("after")

  const getItems = useCallback(({ query }: { query: string }) => {
    const baseItems = getDateFilterOptions(currentFilterTypeRef.current)
    return filterDateOptions(baseItems, query)
  }, [])

  const onStart = useCallback((props: SuggestionProps<DateFilterItem>) => {
    const filterType = detectFilterType(props.text || "after:")
    currentFilterTypeRef.current = filterType

    const items = filterDateOptions(getDateFilterOptions(filterType), props.query)

    setState({
      items,
      clientRect: props.clientRect ?? null,
      command: props.command,
      filterType,
    })
  }, [])

  const onUpdate = useCallback((props: SuggestionProps<DateFilterItem>) => {
    const filterType = detectFilterType(props.text || "after:")
    currentFilterTypeRef.current = filterType

    const items = filterDateOptions(getDateFilterOptions(filterType), props.query)

    setState({
      items,
      clientRect: props.clientRect ?? null,
      command: props.command,
      filterType,
    })
  }, [])

  const onExit = useCallback(() => {
    setState(null)
  }, [])

  // Imperative close for when Radix intercepts Escape before TipTap
  const close = useCallback(() => {
    setState(null)
  }, [])

  const onKeyDown = useCallback((props: SuggestionKeyDownProps) => {
    if (props.event.key === "Escape") {
      setState(null)
      return true
    }
    return listRef.current?.onKeyDown(props.event) ?? false
  }, [])

  const suggestionConfig = {
    items: getItems,
    render: () => ({
      onStart,
      onUpdate,
      onExit,
      onKeyDown,
    }),
  }

  const renderDateFilterList = useCallback(() => {
    if (!state || !state.command) return null

    return createPortal(
      <DateFilterList ref={listRef} items={state.items} clientRect={state.clientRect} command={state.command} />,
      document.body
    )
  }, [state])

  return {
    suggestionConfig,
    renderDateFilterList,
    isActive: state !== null,
    close,
  }
}
