import { useCallback } from "react"
import { rankMatches } from "@/lib/match-score"
import { useSuggestion } from "./use-suggestion"
import { RefineList } from "./refine-list"
import { REFINE_OPTIONS, type RefineItem } from "./refine-extension"

export function filterRefineOptions(items: RefineItem[], query: string): RefineItem[] {
  return rankMatches(items, query, (item) => ({ labels: [item.id, item.label], keywords: [item.description] }))
}

/**
 * Hook for the `/refine` suggestion (`/` trigger in search inputs).
 */
export function useRefineSuggestion() {
  const getItems = useCallback(() => REFINE_OPTIONS, [])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<import("./suggestion-list").SuggestionListRef | null>
      items: RefineItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: RefineItem) => void
    }) => <RefineList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<RefineItem>({
    extensionName: "refine",
    getItems,
    filterItems: filterRefineOptions,
    renderList,
  })

  return {
    suggestionConfig,
    renderRefineList: renderSuggestionList,
    isActive,
    close,
  }
}
