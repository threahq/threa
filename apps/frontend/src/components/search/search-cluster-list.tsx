import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { Archive, Brain, Loader2, MessagesSquare, Waypoints } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { useActors } from "@/hooks/use-actors"
import { cn } from "@/lib/utils"
import type { MemoExplorerResult, SearchCluster, SearchResultItem } from "@/api"
import { ResultRow } from "./result-row"
import { useSearchStreamLabels, type SearchStreamLabels } from "./use-search-stream-labels"

/** Hits shown before a row folds the rest behind "N more". */
const VISIBLE_HITS = 3
const VISIBLE_PARTICIPANTS = 3

interface SearchClusterListProps {
  workspaceId: string
  clusters: SearchCluster[]
  memos: MemoExplorerResult[]
  terms: string[]
  activeResultId: string | null
  /** `/w/<ws>/memory?q=<text>`; a memory chip opens `&memo=<id>` on it. */
  exploreHref: string
  onResultSelect: (result: SearchResultItem) => void
  onConversationSelect: (conversationId: string) => void
  onMemoSelect: (memoId: string) => void
  /** Phone widths fold every row's hits behind a count so the list fits on screen. */
  foldHits?: boolean
}

/** What the "N results" summary counts: every hit, and a hit-less topic row as one. */
export function countClusterResults(clusters: SearchCluster[]): number {
  return clusters.reduce((count, cluster) => count + Math.max(cluster.hits.length, 1), 0)
}

function clusterKey(cluster: SearchCluster, index: number): string {
  return cluster.conversation?.id ?? cluster.hits[0]?.id ?? `${cluster.streamId}:${index}`
}

/**
 * The default search view: one ranked row per conversation, with the matched
 * messages nested inside it. Rows without a conversation are single messages.
 */
export function SearchClusterList({
  workspaceId,
  clusters,
  memos,
  terms,
  activeResultId,
  exploreHref,
  onResultSelect,
  onConversationSelect,
  onMemoSelect,
  foldHits = false,
}: SearchClusterListProps) {
  const { getActorName } = useActors(workspaceId)
  const streamIds = useMemo(() => clusters.map((cluster) => cluster.streamId), [clusters])
  const streamLabels = useSearchStreamLabels(workspaceId, streamIds)
  const memosById = useMemo(() => new Map(memos.map((memo) => [memo.memo.id, memo])), [memos])
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())

  // A keyboard-selected hit must be visible, even when its row is folded.
  useEffect(() => {
    if (!activeResultId) return
    const index = clusters.findIndex((cluster) => cluster.hits.some((hit) => hit.id === activeResultId))
    if (index === -1) return
    const key = clusterKey(clusters[index]!, index)
    setExpandedKeys((current) => (current.has(key) ? current : new Set(current).add(key)))
  }, [activeResultId, clusters])

  const expand = useCallback((key: string) => {
    setExpandedKeys((current) => new Set(current).add(key))
  }, [])

  return (
    <ul className="flex flex-col gap-1.5">
      {clusters.map((cluster, index) => {
        const key = clusterKey(cluster, index)
        return (
          <ClusterRow
            key={key}
            workspaceId={workspaceId}
            cluster={cluster}
            memos={cluster.memoIds.flatMap((id) => memosById.get(id) ?? [])}
            terms={terms}
            activeResultId={activeResultId}
            exploreHref={exploreHref}
            streamLabels={streamLabels}
            getActorName={getActorName}
            expanded={expandedKeys.has(key)}
            onExpand={() => expand(key)}
            foldHits={foldHits}
            onResultSelect={onResultSelect}
            onConversationSelect={onConversationSelect}
            onMemoSelect={onMemoSelect}
          />
        )
      })}
    </ul>
  )
}

interface ClusterRowProps {
  workspaceId: string
  cluster: SearchCluster
  memos: MemoExplorerResult[]
  terms: string[]
  activeResultId: string | null
  exploreHref: string
  streamLabels: SearchStreamLabels
  getActorName: (id: string, type: SearchResultItem["authorType"]) => string
  expanded: boolean
  onExpand: () => void
  foldHits: boolean
  onResultSelect: (result: SearchResultItem) => void
  onConversationSelect: (conversationId: string) => void
  onMemoSelect: (memoId: string) => void
}

function ClusterRow({
  workspaceId,
  cluster,
  memos,
  terms,
  activeResultId,
  exploreHref,
  streamLabels,
  getActorName,
  expanded,
  onExpand,
  foldHits,
  onResultSelect,
  onConversationSelect,
  onMemoSelect,
}: ClusterRowProps) {
  const { conversation, hits } = cluster
  const matchedTopic = cluster.matchedVia.includes("topic")
  const hasChips = matchedTopic || memos.length > 0
  const folded = foldHits && !expanded
  const visibleHits = expanded ? hits : hits.slice(0, folded ? 0 : VISIBLE_HITS)
  const hiddenCount = hits.length - visibleHits.length
  const label = streamLabels.label(cluster.streamId)
  const isResolving = streamLabels.isResolving(cluster.streamId)
  const isArchived = streamLabels.isArchived(cluster.streamId)

  const stray = !conversation && hits.length === 1 && !hasChips
  if (stray) {
    return (
      <ResultRow
        workspaceId={workspaceId}
        result={hits[0]!}
        terms={terms}
        isActive={hits[0]!.id === activeResultId}
        onResultSelect={onResultSelect}
        actorName={getActorName(hits[0]!.authorId, hits[0]!.authorType)}
        streamLabel={label}
        isResolving={isResolving}
        isArchived={isArchived}
      />
    )
  }

  const streamLine = (
    <p className="flex h-3 items-center gap-1 text-[10px] leading-3 text-muted-foreground">
      {isResolving ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="Loading stream" />
      ) : (
        <span className="min-w-0 truncate" data-search-stream-label={cluster.streamId}>
          {label}
        </span>
      )}
      <span className="h-3 w-3 shrink-0">
        {isArchived && <Archive className="h-3 w-3 text-foreground" aria-label="Archived stream" role="img" />}
      </span>
    </p>
  )

  return (
    <li
      data-search-cluster={conversation?.id ?? undefined}
      className="rounded-lg border border-border/50 bg-card [overflow-wrap:anywhere]"
    >
      {conversation ? (
        <ConversationHeader
          workspaceId={workspaceId}
          conversation={conversation}
          anchorMessageId={conversation.firstMessageId ?? hits[0]?.id ?? null}
          streamLine={streamLine}
          getActorName={getActorName}
          onSelect={onConversationSelect}
        />
      ) : (
        <div className="px-3 pt-2">{streamLine}</div>
      )}

      {hasChips && (
        <div className="flex flex-wrap items-center gap-1 px-3 pb-1.5">
          {matchedTopic && (
            <span className="inline-flex h-5 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
              <Waypoints className="h-3 w-3" aria-hidden="true" />
              topic
            </span>
          )}
          {memos.map((result) => (
            <Link
              key={result.memo.id}
              to={`${exploreHref}&memo=${result.memo.id}`}
              onClick={() => onMemoSelect(result.memo.id)}
              data-search-memo-id={result.memo.id}
              title={result.memo.title}
              className="inline-flex h-5 max-w-full items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
            >
              <Brain className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{result.memo.title}</span>
            </Link>
          ))}
        </div>
      )}

      {visibleHits.length > 0 && (
        <ul className="flex flex-col gap-px px-1 pb-1">
          {visibleHits.map((hit) => (
            <ResultRow
              key={hit.id}
              workspaceId={workspaceId}
              result={hit}
              terms={terms}
              isActive={hit.id === activeResultId}
              onResultSelect={onResultSelect}
              actorName={getActorName(hit.authorId, hit.authorType)}
              isResolving={false}
              isArchived={false}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={onExpand}
          className={cn(
            "flex w-full items-center gap-1 px-3 text-left text-[11px] text-muted-foreground hover:text-foreground",
            folded ? "h-9 border-t border-border/40" : "pb-2 pt-0.5"
          )}
        >
          {folded
            ? `${hits.length} ${hits.length === 1 ? "match" : "matches"}${conversation ? ` of ${conversation.messageCount}` : ""}`
            : `${hiddenCount} more in this conversation`}
        </button>
      )}
    </li>
  )
}

function ConversationHeader({
  workspaceId,
  conversation,
  anchorMessageId,
  streamLine,
  getActorName,
  onSelect,
}: {
  workspaceId: string
  conversation: NonNullable<SearchCluster["conversation"]>
  anchorMessageId: string | null
  streamLine: ReactNode
  getActorName: ClusterRowProps["getActorName"]
  onSelect: (conversationId: string) => void
}) {
  const title = conversation.topicSummary ?? conversation.summary ?? "Untitled conversation"
  const names = conversation.participantIds.slice(0, VISIBLE_PARTICIPANTS).map((id) => getActorName(id, "user"))
  const extra = conversation.participantIds.length - names.length

  return (
    <Link
      to={`/w/${workspaceId}/s/${conversation.streamId}${anchorMessageId ? `?m=${anchorMessageId}` : ""}`}
      onClick={() => onSelect(conversation.id)}
      data-search-conversation-id={conversation.id}
      className="block min-w-0 rounded-t-lg px-3 pb-1.5 pt-2 transition-colors hover:bg-muted/60"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        {streamLine}
        {conversation.lastMessageAt && (
          <RelativeTime
            date={conversation.lastMessageAt}
            className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
            terse
          />
        )}
      </div>
      <h3 className="mt-0.5 text-[13px] font-semibold leading-snug text-foreground line-clamp-2">{title}</h3>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
          <MessagesSquare className="h-2.5 w-2.5" aria-hidden="true" />
          {conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}
        </span>
        {names.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {names.join(", ")}
              {extra > 0 && ` +${extra}`}
            </span>
          </>
        )}
      </p>
    </Link>
  )
}
