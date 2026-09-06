import { Link } from "react-router-dom"
import { Archive, Loader2 } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { cn } from "@/lib/utils"
import type { SearchResultItem } from "@/api"
import { buildSnippet, HighlightedText } from "./highlight"

interface ResultRowProps {
  workspaceId: string
  result: SearchResultItem
  terms: string[]
  isActive: boolean
  onResultSelect: (result: SearchResultItem) => void
  actorName: string
  /** Omitted when the surrounding row already names the stream. */
  streamLabel?: string
  isResolving: boolean
  isArchived: boolean
}

export function ResultRow({
  workspaceId,
  result,
  terms,
  isActive,
  onResultSelect,
  actorName,
  streamLabel,
  isResolving,
  isArchived,
}: ResultRowProps) {
  const snippet = buildSnippet(result.content, terms)
  return (
    <li>
      <Link
        to={`/w/${workspaceId}/s/${result.streamId}?m=${result.id}`}
        onClick={() => onResultSelect(result)}
        data-search-result-id={result.id}
        aria-current={isActive ? "true" : undefined}
        className={cn(
          "block rounded-md border-l-2 py-1.5 pl-3 pr-2 transition-colors",
          isActive ? "border-primary bg-accent" : "border-transparent hover:bg-muted/60"
        )}
      >
        {streamLabel !== undefined && (
          <p className="mb-0.5 flex h-3 items-center gap-1 text-[10px] leading-3 text-muted-foreground">
            {isResolving ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="Loading stream" />
            ) : (
              <span className="min-w-0 truncate" data-search-stream-label={result.streamId}>
                {streamLabel}
              </span>
            )}
            <span className="h-3 w-3 shrink-0">
              {isArchived && <Archive className="h-3 w-3 text-foreground" aria-label="Archived stream" role="img" />}
            </span>
          </p>
        )}
        <p className="text-xs leading-snug text-foreground/90 line-clamp-2 [overflow-wrap:anywhere]">
          {snippet.truncatedStart && <span className="text-muted-foreground/60">…</span>}
          <HighlightedText text={snippet.text} terms={terms} />
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <span className="min-w-0 truncate">{actorName}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime date={result.createdAt} className="shrink-0 tabular-nums" />
        </p>
      </Link>
    </li>
  )
}
