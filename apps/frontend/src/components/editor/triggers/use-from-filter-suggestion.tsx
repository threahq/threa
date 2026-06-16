import { useCallback } from "react"
import type { Mentionable } from "./types"
import { MentionList } from "./mention-list"
import { filterSearchMentionables, useMentionables } from "@/hooks/use-mentionables"
import { useSuggestion } from "./use-suggestion"

/** Hook for `from:@` filter suggestions (users/personas) in search context. */
export function useFromFilterSuggestion() {
  const { mentionables } = useMentionables()

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: Mentionable[]
      clientRect: (() => DOMRect | null) | null
      command: (item: Mentionable) => void
    }) => <MentionList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive, close } = useSuggestion<Mentionable>({
    extensionName: "fromFilter",
    getItems: () => mentionables,
    filterItems: filterSearchMentionables,
    renderList,
  })

  return {
    suggestionConfig,
    renderFromFilterList: renderSuggestionList,
    isActive,
    close,
  }
}
