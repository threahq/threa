import { useCallback } from "react"
import { rankMatches } from "@/lib/match-score"
import { useSuggestion } from "./use-suggestion"
import { FilterTypeList } from "./filter-type-list"
import { FILTER_TYPE_OPTIONS, type FilterTypeItem } from "./filter-type-extension"

/**
 * Filters and ranks stream type options by query string. Label and inserted
 * value are both visible match targets; the description is a hidden alias
 * scored a tier below.
 */
export function filterFilterTypes(items: FilterTypeItem[], query: string): FilterTypeItem[] {
  return rankMatches(items, query, (item) => ({
    labels: [item.label, item.value],
    keywords: [item.description],
  }))
}

/**
 * Hook for managing filter type suggestions (`is:` trigger).
 */
export function useFilterTypeSuggestion() {
  const getItems = useCallback(() => FILTER_TYPE_OPTIONS, [])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<import("./suggestion-list").SuggestionListRef | null>
      items: FilterTypeItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: FilterTypeItem) => void
    }) => <FilterTypeList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<FilterTypeItem>({
    extensionName: "filterType",
    getItems,
    filterItems: filterFilterTypes,
    renderList,
  })

  return {
    suggestionConfig,
    renderFilterTypeList: renderSuggestionList,
    isActive,
    close,
  }
}
