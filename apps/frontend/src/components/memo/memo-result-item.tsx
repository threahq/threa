import { useState } from "react"
import { ChevronDown, ChevronRight, Hash, MessageSquareQuote } from "lucide-react"
import { Link } from "react-router-dom"
import { capture } from "@/lib/analytics/posthog"
import { RelativeTime } from "@/components/relative-time"
import { Skeleton } from "@/components/ui/skeleton"
import { KnowledgeTypeBadge, formatStreamRef } from "@/components/memo/memo-detail"
import { useMemoDetail } from "@/hooks"
import { getKnowledgeConfig } from "@/lib/memo-display"
import { stripMarkdownToInline } from "@/lib/markdown/strip"
import { cn } from "@/lib/utils"
import type { MemoExplorerResult } from "@/api"

export function MemoResultItem({
  result,
  isActive,
  href,
  compact = false,
}: {
  result: MemoExplorerResult
  isActive: boolean
  href: string
  /** Drops the tags row and clamps the abstract to one line, for tight spaces (sidebar search panel). */
  compact?: boolean
}) {
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const { memo } = result
  const sourceLabel = formatStreamRef(result.sourceStream)
  const rootLabel = formatStreamRef(result.rootStream)
  const config = getKnowledgeConfig(memo.knowledgeType)
  const firstSourceId = memo.sourceMessageId ?? memo.sourceMessageIds[0] ?? null
  const sourceHref =
    result.sourceStream && firstSourceId
      ? `/w/${memo.workspaceId}/s/${result.sourceStream.id}?m=${firstSourceId}`
      : null
  const sourceCount = memo.sourceMessageIds.length

  return (
    <div
      className={cn(
        // [overflow-wrap:anywhere] is inherited by descendants and collapses the
        // intrinsic min-content of long unbreakable strings (URLs, hashes) so the
        // Radix ScrollArea's display:table wrapper can't be forced wider than the
        // viewport. `break-words` alone is insufficient — per spec it doesn't
        // affect min-content calculation.
        "group overflow-hidden rounded-lg border-l-[3px] border border-l-transparent bg-card transition-all [overflow-wrap:anywhere]",
        isActive
          ? cn("border-primary/30 shadow-sm", config.accent)
          : "border-border/50 hover:border-border hover:shadow-sm"
      )}
    >
      <Link to={href} onClick={() => capture("memo_opened")} className="block min-w-0 px-3.5 pt-3 pb-2">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground line-clamp-2">
            {memo.title}
          </h3>
          <RelativeTime
            date={memo.updatedAt}
            className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          />
        </div>

        <p
          className={cn(
            "mt-1.5 text-xs leading-relaxed text-muted-foreground",
            compact ? "line-clamp-1" : "line-clamp-2"
          )}
        >
          {memo.abstract}
        </p>

        {!compact && (
          <div className="mt-2.5 flex min-w-0 items-center gap-2">
            <KnowledgeTypeBadge type={memo.knowledgeType} size="xs" />

            {memo.tags.length > 0 && (
              <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                {memo.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex min-w-0 items-center gap-0.5 text-[10px] text-muted-foreground/70"
                  >
                    <Hash className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{tag}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Link>

      {(sourceLabel || rootLabel) && (
        <div className="flex min-w-0 items-center gap-1 px-3.5 pb-2 text-[10px] text-muted-foreground/60">
          <MessageSquareQuote className="h-2.5 w-2.5 shrink-0" />
          {sourceHref ? (
            <Link
              to={sourceHref}
              className="min-w-0 truncate hover:text-foreground hover:underline"
              data-memo-source-link={memo.id}
            >
              <SourceLabel count={sourceCount} sourceLabel={sourceLabel} rootLabel={rootLabel} result={result} />
            </Link>
          ) : (
            <span className="min-w-0 truncate">
              <SourceLabel count={sourceCount} sourceLabel={sourceLabel} rootLabel={rootLabel} result={result} />
            </span>
          )}
          {sourceCount > 0 && (
            <button
              type="button"
              onClick={() => setSourcesOpen((open) => !open)}
              aria-expanded={sourcesOpen}
              aria-label={sourcesOpen ? "Hide source messages" : "Show source messages"}
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-muted/60 hover:text-foreground"
            >
              {sourcesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          )}
        </div>
      )}

      {sourcesOpen && <MemoSourceMessages workspaceId={memo.workspaceId} memoId={memo.id} />}
    </div>
  )
}

function SourceLabel({
  count,
  sourceLabel,
  rootLabel,
  result,
}: {
  count: number
  sourceLabel: string | null
  rootLabel: string | null
  result: MemoExplorerResult
}) {
  const countPrefix = count > 0 ? `${count} ${count === 1 ? "message" : "messages"} in ` : ""
  return (
    <>
      <span className="tabular-nums">{`${countPrefix}${sourceLabel ?? ""}`}</span>
      {sourceLabel && rootLabel && result.rootStream?.id !== result.sourceStream?.id && (
        <span className="text-muted-foreground/40"> in {rootLabel}</span>
      )}
    </>
  )
}

function MemoSourceMessages({ workspaceId, memoId }: { workspaceId: string; memoId: string }) {
  const { data, isLoading, error } = useMemoDetail(workspaceId, memoId)
  const messages = data?.memo.sourceMessages ?? []

  if (error) {
    return <p className="px-3.5 pb-2.5 text-[11px] text-destructive">Couldn't load source messages.</p>
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-1 px-3.5 pb-2.5">
        <Skeleton className="h-8 rounded-md" />
        <Skeleton className="h-8 rounded-md" />
      </div>
    )
  }

  if (messages.length === 0) {
    return <p className="px-3.5 pb-2.5 text-[11px] text-muted-foreground/60">No accessible source messages.</p>
  }

  return (
    <ul className="flex flex-col gap-px border-t border-border/40 px-1.5 py-1.5" data-memo-source-messages={memoId}>
      {messages.map((message) => (
        <li key={message.id}>
          <Link
            to={`/w/${workspaceId}/s/${message.streamId}?m=${message.id}`}
            className="block rounded-md border-l-2 border-transparent py-1 pl-2 pr-1.5 transition-colors hover:bg-muted/60"
          >
            <p className="text-xs leading-snug text-foreground/90 line-clamp-2">
              {stripMarkdownToInline(message.content)}
            </p>
            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <span className="min-w-0 truncate">{message.authorName}</span>
              <span aria-hidden="true">·</span>
              <RelativeTime date={message.createdAt} className="shrink-0 tabular-nums" />
            </p>
          </Link>
        </li>
      ))}
    </ul>
  )
}
