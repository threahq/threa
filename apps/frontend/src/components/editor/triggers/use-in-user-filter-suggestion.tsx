import { useCallback } from "react"
import type { Mentionable } from "./types"
import { MentionList } from "./mention-list"
import { filterUsersOnly, useMentionables } from "@/hooks/use-mentionables"
import { useSuggestion } from "./use-suggestion"

/**
 * Hook for `in:` and `in:@` filter suggestions in search context. Users only,
 * not personas, since you can only DM with users.
 */
export function useInUserFilterSuggestion() {
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
    extensionName: "inUserFilter",
    getItems: () => mentionables,
    filterItems: filterUsersOnly,
    renderList,
  })

  return {
    suggestionConfig,
    renderInUserFilterList: renderSuggestionList,
    isActive,
    close,
  }
}
