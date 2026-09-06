import { useCallback } from "react"
import { rankMatches } from "@/lib/match-score"
import { useSuggestion } from "./use-suggestion"
import { SteerList } from "./steer-list"
import { STEER_OPTIONS, type SteerItem } from "./steer-extension"

export function filterSteerOptions(items: SteerItem[], query: string): SteerItem[] {
  return rankMatches(items, query, (item) => ({ labels: [item.id, item.label], keywords: [item.description] }))
}

/**
 * Hook for the `/steer` suggestion (`/` trigger in search inputs).
 */
export function useSteerSuggestion() {
  const getItems = useCallback(() => STEER_OPTIONS, [])

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<import("./suggestion-list").SuggestionListRef | null>
      items: SteerItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: SteerItem) => void
    }) => <SteerList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<SteerItem>({
    extensionName: "steer",
    getItems,
    filterItems: filterSteerOptions,
    renderList,
  })

  return {
    suggestionConfig,
    renderSteerList: renderSuggestionList,
    isActive,
    close,
  }
}
