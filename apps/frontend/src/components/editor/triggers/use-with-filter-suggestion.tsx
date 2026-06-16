import { useCallback } from "react"
import type { Mentionable } from "./types"
import { MentionList } from "./mention-list"
import { filterSearchMentionables, useMentionables } from "@/hooks/use-mentionables"
import { useSuggestion } from "./use-suggestion"

/**
 * Hook for `with:@` filter suggestions in search context.
 * Filters for messages in streams where the selected user is a member.
 */
export function useWithFilterSuggestion() {
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
    extensionName: "withFilter",
    getItems: () => mentionables,
    filterItems: filterSearchMentionables,
    renderList,
  })

  return {
    suggestionConfig,
    renderWithFilterList: renderSuggestionList,
    isActive,
    close,
  }
}
