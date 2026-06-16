import { useCallback } from "react"
import type { Mentionable } from "./types"
import { MentionList } from "./mention-list"
import { filterMentionables, useMentionables, type MentionStreamContext } from "@/hooks/use-mentionables"
import { useSuggestion } from "./use-suggestion"

export function useMentionSuggestion(streamContext?: MentionStreamContext) {
  const { mentionables } = useMentionables(streamContext)

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: Mentionable[]
      clientRect: (() => DOMRect | null) | null
      command: (item: Mentionable) => void
    }) => <MentionList ref={props.ref} items={props.items} clientRect={props.clientRect} command={props.command} />,
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive } = useSuggestion<Mentionable>({
    extensionName: "mention",
    getItems: () => mentionables,
    filterItems: filterMentionables,
    renderList,
  })

  return {
    suggestionConfig,
    renderMentionList: renderSuggestionList,
    isActive,
  }
}
