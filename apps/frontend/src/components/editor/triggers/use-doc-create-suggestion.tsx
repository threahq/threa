import { useCallback, useMemo } from "react"
import { useParams } from "react-router-dom"
import { useCreateDoc } from "@/hooks/use-create-doc"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { useWorkspaceStream, useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"
import { DocSuggestionList } from "./doc-suggestion-list"
import { isNewDoc, rankDocs, selectActiveDocs, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"
import { useSuggestion } from "./use-suggestion"
import { takeOverNewDoc, type DocCreateOptions } from "./doc-create-extension"

type DocCreateItem = DocSuggestionItem | NewDocItem

/** Existing docs offered under "New doc", so a title already taken is one Enter from being linked instead. */
const MATCHING_DOC_LIMIT = 3

const pickDocHost = (row: CachedStream) => ({
  id: row.id,
  displayName: row.displayName,
  type: row.type,
  e2eEnabled: row.e2eEnabled,
  archivedAt: row.archivedAt,
  parentStreamId: row.parentStreamId,
  rootStreamId: row.rootStreamId,
})

/**
 * Manages the inline `/doc [title]` picker: "New doc" first, creating the doc under `hostStreamId` and linking it in
 * place of the typed trigger, then the docs whose title already matches. `canCreate` is false where `hostStreamId` can't host a doc; the
 * picker then only links.
 */
export function useDocCreateSuggestion(hostStreamId?: string, excludeDocId?: string) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const docs = useWorkspaceStreamsSelect(workspaceId, selectActiveDocs)
  const host = useWorkspaceStream(workspaceId, hostStreamId, pickDocHost)
  const createDoc = useCreateDoc(workspaceId ?? "", host)
  const canCreate = createDoc.enabled

  const filterItems = useCallback(
    (items: DocCreateItem[], query: string): DocCreateItem[] => {
      const title = query.trim()
      const docsOnly = items.filter((item): item is DocSuggestionItem => !isNewDoc(item))
      const matches = title ? rankDocs(docsOnly, title, { hostStreamId, excludeDocId, limit: MATCHING_DOC_LIMIT }) : []
      return canCreate ? [{ kind: "new-doc", title }, ...matches] : matches
    },
    [canCreate, hostStreamId, excludeDocId]
  )

  const renderList = useCallback(
    (props: {
      ref: React.RefObject<{ onKeyDown: (event: KeyboardEvent) => boolean } | null>
      items: DocCreateItem[]
      clientRect: (() => DOMRect | null) | null
      command: (item: DocCreateItem) => void
    }) => (
      <DocSuggestionList
        ref={props.ref}
        items={props.items}
        clientRect={props.clientRect}
        command={props.command}
        creatingNewDoc={createDoc.pending}
        emptyState="Docs can't be created here"
      />
    ),
    [createDoc.pending]
  )

  const { suggestionConfig, renderSuggestionList } = useSuggestion<DocCreateItem>({
    extensionName: "docCreate",
    getItems: () => docs,
    filterItems,
    renderList,
    rendersEmptyState: true,
  })

  // Stable, so a create flipping `pending` doesn't hand the editor new extension options mid-create.
  const takeOver = useStableCallback(takeOverNewDoc(createDoc.create, createDoc.open))
  const docCreateOptions = useMemo<DocCreateOptions>(
    () => ({ suggestion: suggestionConfig, takeOver }),
    [suggestionConfig, takeOver]
  )

  return { docCreateOptions, renderDocCreateList: renderSuggestionList, canCreate }
}
