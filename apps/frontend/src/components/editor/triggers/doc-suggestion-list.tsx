import { forwardRef, type ReactNode } from "react"
import { useParams } from "react-router-dom"
import type { Placement } from "@floating-ui/react"
import { StreamTypes } from "@threahq/types"
import { STREAM_ICONS, streamLabel } from "@/lib/streams"
import { indexStreams, useWorkspaceStreams, type CachedStream } from "@/stores/workspace-store"
import { SuggestionList, type SuggestionListRef } from "./suggestion-list"
import type { DocSuggestionItem } from "./use-doc-suggestion"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

export type DocSuggestionListRef = SuggestionListRef

interface DocSuggestionListProps {
  items: DocSuggestionItem[]
  clientRect: (() => DOMRect | null) | null
  command: (item: DocSuggestionItem) => void
  placement?: Placement
  emptyState?: ReactNode
}

function DocSuggestionRow({ item, host }: { item: DocSuggestionItem; host: CachedStream | undefined }) {
  return (
    <>
      <DocGlyph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate text-[13px] font-medium">
        {streamLabel({ type: StreamTypes.DOC, displayName: item.displayName }, "generic")}
      </span>
      {host && <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{streamLabel(host)}</span>}
    </>
  )
}

/** Autocomplete list for the inline `/doc` trigger: each doc's title, with the stream that hosts it. */
export const DocSuggestionList = forwardRef<DocSuggestionListRef, DocSuggestionListProps>(function DocSuggestionList(
  { items, clientRect, command, placement, emptyState = "No docs found" },
  ref
) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const streamsById = indexStreams(useWorkspaceStreams(workspaceId))
  return (
    <SuggestionList
      ref={ref}
      items={items}
      clientRect={clientRect}
      command={command}
      getKey={(item) => item.id}
      ariaLabel="Doc suggestions"
      renderItem={(item) => (
        <DocSuggestionRow item={item} host={item.parentStreamId ? streamsById.get(item.parentStreamId) : undefined} />
      )}
      placement={placement}
      width="w-80"
      emptyState={emptyState}
    />
  )
})
