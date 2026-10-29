import { useCallback } from "react"
import { useParams } from "react-router-dom"
import { StreamTypes } from "@threahq/types"
import { useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"
import { DocSuggestionList } from "./doc-suggestion-list"
import { useSuggestion } from "./use-suggestion"

export type DocSuggestionItem = Pick<CachedStream, "id" | "displayName" | "parentStreamId" | "createdAt">

/** The `/doc` picker's row that creates a doc titled `title` (untitled when empty) instead of linking one. */
export interface NewDocItem {
  kind: "new-doc"
  title: string
}

export function isNewDoc(item: DocSuggestionItem | NewDocItem): item is NewDocItem {
  return "kind" in item && item.kind === "new-doc"
}

const DOC_SUGGESTION_LIMIT = 8

export function selectActiveDocs(streams: CachedStream[]): DocSuggestionItem[] {
  return streams
    .filter((stream) => stream.type === StreamTypes.DOC && !stream.archivedAt)
    .map(({ id, displayName, parentStreamId, createdAt }) => ({ id, displayName, parentStreamId, createdAt }))
}

/** Titles containing `query`, docs hosted by `hostStreamId` first, then newest, never `excludeDocId` (the doc being edited). */
export function rankDocs(
  docs: DocSuggestionItem[],
  query: string,
  { hostStreamId, excludeDocId, limit }: { hostStreamId?: string; excludeDocId?: string; limit: number }
): DocSuggestionItem[] {
  const needle = query.trim().toLowerCase()
  const hostRank = (doc: DocSuggestionItem) => (hostStreamId && doc.parentStreamId === hostStreamId ? 0 : 1)
  return docs
    .filter((doc) => doc.id !== excludeDocId && (doc.displayName ?? "").toLowerCase().includes(needle))
    .sort((a, b) => hostRank(a) - hostRank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
}

/** Manages the inline `/docs` picker over the workspace's cached docs, ranked by `rankDocs`. */
export function useDocSuggestion(hostStreamId?: string, excludeDocId?: string) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const docs = useWorkspaceStreamsSelect(workspaceId, selectActiveDocs)

  const filterItems = useCallback(
    (items: DocSuggestionItem[], query: string) =>
      rankDocs(items, query, { hostStreamId, excludeDocId, limit: DOC_SUGGESTION_LIMIT }),
    [hostStreamId, excludeDocId]
  )

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: DocSuggestionItem[]
      query: string
      clientRect: (() => DOMRect | null) | null
      command: (item: DocSuggestionItem) => void
    }) => (
      <DocSuggestionList
        ref={props.ref}
        items={filterItems(docs, props.query)}
        highlightResetKey={props.query}
        clientRect={props.clientRect}
        command={(item) => !isNewDoc(item) && props.command(item)}
        emptyState="No docs found"
      />
    ),
    [docs, filterItems]
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
