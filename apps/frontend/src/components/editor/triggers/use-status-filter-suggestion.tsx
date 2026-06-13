import { useCallback } from "react"
import { rankMatches } from "@/lib/match-score"
import { useSuggestion } from "./use-suggestion"
import { StatusFilterList } from "./status-filter-list"
import { STATUS_FILTER_OPTIONS, type StatusFilterItem } from "./status-filter-extension"

/**
 * Filters and ranks status options by query string. Label and inserted value
 * are both visible match targets; the description is a hidden alias scored a
 * tier below.
 */
export function filterStatusOptions(items: StatusFilterItem[], query: string): StatusFilterItem[] {
  return rankMatches(items, query, (item) => ({
    labels: [item.label, item.value],
    keywords: [item.description],
  }))
}

/**
 * Hook for managing status filter suggestions (`status:` trigger).
 */
export function useStatusFilterSuggestion() {
  const getItems = useCallback(() => STATUS_FILTER_OPTIONS, [])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<import("./suggestion-list").SuggestionListRef | null>
      items: StatusFilterItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: StatusFilterItem) => void
    }) => (
      <StatusFilterList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />
    ),
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<StatusFilterItem>({
    extensionName: "statusFilter",
    getItems,
    filterItems: filterStatusOptions,
    renderList,
  })

  return {
    suggestionConfig,
    renderStatusFilterList: renderSuggestionList,
    isActive,
    close,
  }
}
