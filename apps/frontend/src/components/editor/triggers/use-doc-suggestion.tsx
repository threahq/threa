import { useCallback } from "react"
import { useParams } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"
import { DocSuggestionList } from "./doc-suggestion-list"
import { useSuggestion } from "./use-suggestion"

export type DocSuggestionItem = Pick<CachedStream, "id" | "displayName" | "parentStreamId" | "createdAt">

const DOC_SUGGESTION_LIMIT = 8

function selectActiveDocs(streams: CachedStream[]): DocSuggestionItem[] {
  return streams
    .filter((stream) => stream.type === StreamTypes.DOC && !stream.archivedAt)
    .map(({ id, displayName, parentStreamId, createdAt }) => ({ id, displayName, parentStreamId, createdAt }))
}

/**
 * Manages the inline `/doc` picker over the workspace's cached docs: titles containing the query,
 * docs hosted by `hostStreamId` first, then newest, never `excludeDocId` (the doc being edited).
 */
export function useDocSuggestion(hostStreamId?: string, excludeDocId?: string) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const docs = useWorkspaceStreamsSelect(workspaceId, selectActiveDocs)

  const filterItems = useCallback(
    (items: DocSuggestionItem[], query: string) => {
      const needle = query.trim().toLowerCase()
      const hostRank = (doc: DocSuggestionItem) => (hostStreamId && doc.parentStreamId === hostStreamId ? 0 : 1)
      return items
        .filter((doc) => doc.id !== excludeDocId && (doc.displayName ?? "").toLowerCase().includes(needle))
        .sort((a, b) => hostRank(a) - hostRank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, DOC_SUGGESTION_LIMIT)
    },
    [hostStreamId, excludeDocId]
  )

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: DocSuggestionItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: DocSuggestionItem) => void
    }) => (
      <DocSuggestionList
        ref={props.ref}
        items={props.items}
        clientRect={props.clientRect}
        command={props.command}
        emptyState="No docs found"
      />
    ),
    []
  )

  const { suggestionConfig, renderSuggestionList, isActive } = useSuggestion<DocSuggestionItem>({
    extensionName: "docSearch",
    getItems: () => docs,
    filterItems,
    renderList,
    rendersEmptyState: true,
  })

  return { suggestionConfig, renderDocList: renderSuggestionList, isActive }
}
