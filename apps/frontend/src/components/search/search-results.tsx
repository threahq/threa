import { useMemo } from "react"
import { useActors } from "@/hooks/use-actors"
import type { SearchResultItem } from "@/api"
import { ResultRow } from "./result-row"
import { useSearchStreamLabels } from "./use-search-stream-labels"

interface SearchResultsProps {
  workspaceId: string
  results: SearchResultItem[]
  terms: string[]
  activeResultId: string | null
  onResultSelect: (result: SearchResultItem) => void
}

/** The flat Ranked view: every message hit in API order, each labelled with its stream. */
export function SearchResults({ workspaceId, results, terms, activeResultId, onResultSelect }: SearchResultsProps) {
  const { getActorName } = useActors(workspaceId)
  const streamIds = useMemo(() => results.map((result) => result.streamId), [results])
  const streamLabels = useSearchStreamLabels(workspaceId, streamIds)

  return (
    <ul className="flex flex-col gap-0.5">
      {results.map((result) => (
        <ResultRow
          key={result.id}
          workspaceId={workspaceId}
          result={result}
          terms={terms}
          isActive={result.id === activeResultId}
          onResultSelect={onResultSelect}
          actorName={getActorName(result.authorId, result.authorType)}
          streamLabel={streamLabels.label(result.streamId)}
          isResolving={streamLabels.isResolving(result.streamId)}
          isArchived={streamLabels.isArchived(result.streamId)}
        />
      ))}
    </ul>
  )
}
