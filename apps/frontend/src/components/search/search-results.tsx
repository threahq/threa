import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { Archive, ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import { useWorkspaceDmPeers, useWorkspaceStreams, useWorkspaceUsers } from "@/stores/workspace-store"
import { resolveStreamName, type StreamNameCaches } from "@/lib/streams"
import type { SearchResultDisplayMode } from "@/lib/search-result-display-mode"
import { RelativeTime } from "@/components/relative-time"
import { cn } from "@/lib/utils"
import { useActors } from "@/hooks/use-actors"
import { useEnsureSearchStreams } from "@/hooks/use-ensure-search-streams"
import type { SearchResultItem } from "@/api"
import { buildSnippet, HighlightedText } from "./highlight"
import { groupResultsByStream } from "./group-results"

interface SearchResultsProps {
  workspaceId: string
  results: SearchResultItem[]
  terms: string[]
  activeResultId: string | null
  onResultSelect: (result: SearchResultItem) => void
  mode: SearchResultDisplayMode
}

const ANCESTOR_SEGMENT_WIDTH = 104
const SEPARATOR_WIDTH = 16
const HEADER_CHROME_WIDTH = 72
const CURRENT_SEGMENT_MIN_WIDTH = 72

function visibleAncestorCount(ancestorCount: number, containerWidth: number): number {
  const available = containerWidth - HEADER_CHROME_WIDTH - CURRENT_SEGMENT_MIN_WIDTH
  return Math.max(0, Math.min(ancestorCount, Math.floor(available / (ANCESTOR_SEGMENT_WIDTH + SEPARATOR_WIDTH))))
}

interface ResultRowProps {
  workspaceId: string
  result: SearchResultItem
  terms: string[]
  isActive: boolean
  onResultSelect: (result: SearchResultItem) => void
  actorName: string
  streamLabel?: string
  isResolving: boolean
  isArchived: boolean
}

function ResultRow({
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

export function SearchResults({
  workspaceId,
  results,
  terms,
  activeResultId,
  onResultSelect,
  mode,
}: SearchResultsProps) {
  const users = useWorkspaceUsers(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const { getActorName } = useActors(workspaceId)
  const resolvingStreamIds = useEnsureSearchStreams(
    workspaceId,
    useMemo(() => results.map((result) => result.streamId), [results])
  )
  const [collapsedStreams, setCollapsedStreams] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(260)

  useEffect(() => {
    const container = containerRef.current
    if (!container || mode !== "grouped") return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(container)
    setContainerWidth(container.offsetWidth)
    return () => observer.disconnect()
  }, [mode])

  const streamsById = useMemo(() => new Map(streams.map((stream) => [stream.id, stream])), [streams])
  const groups = useMemo(() => groupResultsByStream(results, streamsById), [results, streamsById])
  const streamLabel = useMemo(() => {
    const caches: StreamNameCaches = { streams, users, dmPeers }
    return (streamId: string) => resolveStreamName(streamId, caches, "breadcrumb") ?? "Unknown stream"
  }, [streams, users, dmPeers])
  const isArchived = useCallback(
    (streamId: string, fallbackRootId?: string) => {
      const stream = streamsById.get(streamId)
      const rootStreamId =
        stream?.rootStreamId ?? (stream?.parentStreamId ? fallbackRootId : (stream?.id ?? fallbackRootId))
      return rootStreamId ? streamsById.get(rootStreamId)?.archivedAt != null : false
    },
    [streamsById]
  )

  useEffect(() => {
    if (mode !== "grouped" || !activeResultId) return
    const streamId = results.find((result) => result.id === activeResultId)?.streamId
    if (!streamId) return
    setCollapsedStreams((current) => {
      if (!current.has(streamId)) return current
      const next = new Set(current)
      next.delete(streamId)
      return next
    })
  }, [activeResultId, mode, results])

  const toggleGroup = useCallback((streamId: string) => {
    setCollapsedStreams((current) => {
      const next = new Set(current)
      if (next.has(streamId)) next.delete(streamId)
      else next.add(streamId)
      return next
    })
  }, [])

  if (mode === "ranked") {
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
            streamLabel={streamLabel(result.streamId)}
            isResolving={resolvingStreamIds.has(result.streamId)}
            isArchived={isArchived(result.streamId)}
          />
        ))}
      </ul>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1">
      {groups.map((group) => {
        const isCollapsed = collapsedStreams.has(group.streamId)
        const pathLabels = group.path.map(streamLabel)
        const currentLabel = pathLabels[pathLabels.length - 1] ?? "Unknown stream"
        const ancestors = pathLabels.slice(0, -1)
        const shownCount = visibleAncestorCount(ancestors.length, containerWidth)
        const shownAncestors = shownCount > 0 ? ancestors.slice(ancestors.length - shownCount) : []
        const hasHidden = ancestors.length > shownCount
        const archived = isArchived(group.streamId, group.path[0])
        return (
          <section key={group.streamId}>
            <button
              type="button"
              onClick={() => toggleGroup(group.streamId)}
              aria-expanded={!isCollapsed}
              title={pathLabels.join(" › ")}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs font-semibold transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                archived ? "text-muted-foreground" : "text-foreground/90"
              )}
            >
              {isCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/70" />
              )}
              {hasHidden && (
                <>
                  <span className="shrink-0 font-normal text-muted-foreground/60">…</span>
                  <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                </>
              )}
              {shownAncestors.map((label, index) => (
                <span key={`${index}-${label}`} className="contents">
                  <span
                    className="truncate font-normal text-muted-foreground/80"
                    style={{ maxWidth: ANCESTOR_SEGMENT_WIDTH }}
                  >
                    {label}
                  </span>
                  <ChevronRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/50" aria-hidden="true" />
                </span>
              ))}
              {resolvingStreamIds.has(group.streamId) ? (
                <Loader2
                  className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/70"
                  aria-label="Loading stream"
                />
              ) : (
                <span className="min-w-0 truncate">{currentLabel}</span>
              )}
              <span className="h-3 w-3 shrink-0">
                {archived && <Archive className="h-3 w-3 text-foreground" aria-label="Archived stream" role="img" />}
              </span>
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                {group.results.length}
              </span>
            </button>
            {!isCollapsed && (
              <ul className="mb-1 ml-2 flex flex-col gap-px">
                {group.results.map((result) => (
                  <ResultRow
                    key={result.id}
                    workspaceId={workspaceId}
                    result={result}
                    terms={terms}
                    isActive={result.id === activeResultId}
                    onResultSelect={onResultSelect}
                    actorName={getActorName(result.authorId, result.authorType)}
                    isResolving={false}
                    isArchived={false}
                  />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
