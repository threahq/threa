import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ChevronDown, ChevronRight } from "lucide-react"
import {
  useWorkspaceDmPeers,
  useWorkspacePersonas,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { resolveStreamName, type StreamNameCaches } from "@/lib/streams"
import { RelativeTime } from "@/components/relative-time"
import { cn } from "@/lib/utils"
import type { SearchResultItem } from "@/api"
import { buildSnippet, HighlightedText } from "./highlight"
import { groupResultsByStream } from "./group-results"

interface SearchResultsProps {
  workspaceId: string
  results: SearchResultItem[]
  /** Highlightable free-text terms from the query. */
  terms: string[]
  /** Message id of the result the user last opened (active row styling). */
  activeResultId: string | null
  /** Called when the user opens a result (click or keyboard). */
  onResultSelect: (result: SearchResultItem) => void
}

/** Per-ancestor-segment budget when truncating breadcrumbs (px). */
const ANCESTOR_SEGMENT_WIDTH = 104
/** Separator chevron width incl. gaps (px). */
const SEPARATOR_WIDTH = 16
/** Chrome around the breadcrumb: expand chevron, count badge, paddings (px). */
const HEADER_CHROME_WIDTH = 72
/** Minimum room the current (last) segment keeps for itself (px). */
const CURRENT_SEGMENT_MIN_WIDTH = 72

/**
 * Decide how many trailing ancestors fit next to the current label. Hidden
 * ancestors collapse into a leading "…" — the truncation leans toward the
 * end of the path ("… › Doubly nested thread"), matching the thread panel.
 */
function visibleAncestorCount(ancestorCount: number, containerWidth: number): number {
  const available = containerWidth - HEADER_CHROME_WIDTH - CURRENT_SEGMENT_MIN_WIDTH
  const perAncestor = ANCESTOR_SEGMENT_WIDTH + SEPARATOR_WIDTH
  return Math.max(0, Math.min(ancestorCount, Math.floor(available / perAncestor)))
}

/**
 * Search results grouped by stream, VS Code search-panel style: collapsible
 * per-stream sections ordered as a depth-first walk of the stream tree
 * (channel first, then its threads by creation), dense rows with highlighted
 * match snippets. Thread groups carry their full nesting as a breadcrumb.
 * Rows are links to the stream focused on the matched message (`?m=`), so the
 * timeline scrolls to and highlights it (INV-40 — navigation is a link).
 */
export function SearchResults({ workspaceId, results, terms, activeResultId, onResultSelect }: SearchResultsProps) {
  const users = useWorkspaceUsers(workspaceId)
  const personas = useWorkspacePersonas(workspaceId)
  const streams = useWorkspaceStreams(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)

  const [collapsedStreams, setCollapsedStreams] = useState<Set<string>>(new Set())

  // Track the rendered width so breadcrumb truncation adapts to the sidebar
  // width (resizable 200–400px) and the full-page layout alike.
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(260)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(container)
    setContainerWidth(container.offsetWidth)
    return () => observer.disconnect()
  }, [])

  const streamsById = useMemo(() => new Map(streams.map((s) => [s.id, s])), [streams])
  const groups = useMemo(() => groupResultsByStream(results, streamsById), [results, streamsById])

  // Keyboard navigation can land on a result inside a collapsed group —
  // reveal it rather than highlighting an invisible row.
  useEffect(() => {
    if (!activeResultId) return
    const streamId = results.find((r) => r.id === activeResultId)?.streamId
    if (!streamId) return
    setCollapsedStreams((current) => {
      if (!current.has(streamId)) return current
      const next = new Set(current)
      next.delete(streamId)
      return next
    })
  }, [activeResultId, results])

  const nodeLabel = useMemo(() => {
    const caches: StreamNameCaches = { streams, users, dmPeers }
    return (streamId: string) => resolveStreamName(streamId, caches, "breadcrumb") ?? "Unknown stream"
  }, [streams, users, dmPeers])

  // Id → name maps so each row resolves its author in O(1) instead of
  // scanning the user/persona arrays per result on every render.
  const authorNamesById = useMemo(() => {
    const names = new Map<string, string>()
    for (const user of users) names.set(user.id, user.name)
    for (const persona of personas) names.set(persona.id, persona.name)
    return names
  }, [users, personas])

  const authorName = (result: SearchResultItem): string =>
    authorNamesById.get(result.authorId) ?? (result.authorType === "persona" ? "Assistant" : "Unknown")

  const toggleGroup = useCallback((streamId: string) => {
    setCollapsedStreams((current) => {
      const next = new Set(current)
      if (next.has(streamId)) {
        next.delete(streamId)
      } else {
        next.add(streamId)
      }
      return next
    })
  }, [])

  return (
    <div ref={containerRef} className="flex flex-col gap-0.5">
      {groups.map((group) => {
        const isCollapsed = collapsedStreams.has(group.streamId)
        const pathLabels = group.path.map(nodeLabel)
        const currentLabel = pathLabels[pathLabels.length - 1] ?? "Unknown stream"
        const ancestors = pathLabels.slice(0, -1)
        const shownCount = visibleAncestorCount(ancestors.length, containerWidth)
        const shownAncestors = shownCount > 0 ? ancestors.slice(ancestors.length - shownCount) : []
        const hasHidden = ancestors.length > shownCount

        return (
          <section key={group.streamId}>
            <button
              type="button"
              onClick={() => toggleGroup(group.streamId)}
              aria-expanded={!isCollapsed}
              title={pathLabels.join(" › ")}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left",
                "text-xs font-semibold text-foreground/90 transition-colors hover:bg-muted/60",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <span className="min-w-0 truncate">{currentLabel}</span>
              <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                {group.results.length}
              </span>
            </button>

            {!isCollapsed && (
              <ul className="mb-1 flex flex-col">
                {group.results.map((result) => {
                  const snippet = buildSnippet(result.content, terms)
                  const isActive = result.id === activeResultId
                  return (
                    <li key={result.id}>
                      <Link
                        to={`/w/${workspaceId}/s/${result.streamId}?m=${result.id}`}
                        onClick={() => onResultSelect(result)}
                        data-search-result-id={result.id}
                        aria-current={isActive ? "true" : undefined}
                        className={cn(
                          "block rounded-md border-l-2 py-1.5 pl-3 pr-2 ml-[5px] transition-colors",
                          isActive
                            ? "border-primary bg-accent"
                            : "border-border/60 hover:border-border hover:bg-muted/50"
                        )}
                      >
                        <p className="text-xs leading-snug text-foreground/90 line-clamp-2 [overflow-wrap:anywhere]">
                          {snippet.truncatedStart && <span className="text-muted-foreground/60">…</span>}
                          <HighlightedText text={snippet.text} terms={terms} />
                        </p>
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                          <span className="min-w-0 truncate">{authorName(result)}</span>
                          <span aria-hidden="true">·</span>
                          <RelativeTime date={result.createdAt} className="shrink-0 tabular-nums" />
                        </p>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
