import { useCallback, useMemo } from "react"
import { useParams } from "react-router-dom"
import type { Editor, EditorEvents } from "@tiptap/core"
import { useCreateDoc } from "@/hooks/use-create-doc"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { useWorkspaceStream, useWorkspaceStreamsSelect, type CachedStream } from "@/stores/workspace-store"
import { DocSuggestionList } from "./doc-suggestion-list"
import { isNewDoc, rankDocs, selectActiveDocs, type DocSuggestionItem, type NewDocItem } from "./use-doc-suggestion"
import { useSuggestion } from "./use-suggestion"
import type { DocCreateOptions } from "./doc-create-extension"

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
 * Waits for `create` and links the doc it made where the trigger was, tracking that spot through anything typed
 * meanwhile. When nothing was created, the typed trigger comes back so the title isn't lost.
 */
export async function linkCreatedDoc(
  editor: Editor,
  at: number,
  create: () => Promise<{ id: string; displayName: string | null } | null>,
  typed: string
) {
  let pos = at
  // Bias left: text typed at the trigger's spot belongs after the chip, not before it.
  const track = ({ transaction }: EditorEvents["transaction"]) => {
    pos = transaction.mapping.map(pos, -1)
  }
  editor.on("transaction", track)
  try {
    const doc = await create()
    if (editor.isDestroyed) return
    if (doc) editor.commands.insertDocEmbed({ docId: doc.id, title: doc.displayName ?? "", at: pos })
    else editor.commands.insertContentAt(pos, typed)
  } finally {
    editor.off("transaction", track)
  }
}

/**
 * Manages the inline `/doc [title]` picker: "New doc" first, creating the doc under `hostStreamId` and linking it in
 * place, then the docs whose title already matches. `canCreate` is false where `hostStreamId` can't host a doc; the
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
        emptyState="Docs can't be created here"
      />
    ),
    []
  )

  const { suggestionConfig, renderSuggestionList } = useSuggestion<DocCreateItem>({
    extensionName: "docCreate",
    getItems: () => docs,
    filterItems,
    renderList,
    rendersEmptyState: true,
  })

  const onPick = useStableCallback(({ editor, item, at }: { editor: Editor; item: DocCreateItem; at: number }) => {
    if (!isNewDoc(item)) return
    void linkCreatedDoc(editor, at, () => createDoc.run(item.title), `/doc ${item.title}`)
  })
  const docCreateOptions = useMemo<DocCreateOptions>(
    () => ({ suggestion: suggestionConfig, onPick }),
    [suggestionConfig, onPick]
  )

  return { docCreateOptions, renderDocCreateList: renderSuggestionList, canCreate }
}
