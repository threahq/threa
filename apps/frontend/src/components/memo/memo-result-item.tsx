import { Hash, MessageSquareQuote } from "lucide-react"
import { Link } from "react-router-dom"
import { RelativeTime } from "@/components/relative-time"
import { KnowledgeTypeBadge, formatStreamRef } from "@/components/memo/memo-detail"
import { getKnowledgeConfig } from "@/lib/memo-display"
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
  /** Drops the tags/source rows and clamps the abstract to one line, for tight spaces (sidebar search panel). */
  compact?: boolean
}) {
  const sourceLabel = formatStreamRef(result.sourceStream)
  const rootLabel = formatStreamRef(result.rootStream)
  const config = getKnowledgeConfig(result.memo.knowledgeType)

  return (
    <Link
      to={href}
      className={cn(
        // [overflow-wrap:anywhere] is inherited by descendants and collapses the
        // intrinsic min-content of long unbreakable strings (URLs, hashes) so the
        // Radix ScrollArea's display:table wrapper can't be forced wider than the
        // viewport. `break-words` alone is insufficient — per spec it doesn't
        // affect min-content calculation.
        "group block overflow-hidden rounded-lg border-l-[3px] border border-l-transparent bg-card transition-all [overflow-wrap:anywhere]",
        isActive
          ? cn("border-primary/30 shadow-sm", config.accent)
          : "border-border/50 hover:border-border hover:shadow-sm"
      )}
    >
      <div className="min-w-0 px-3.5 py-3">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-foreground line-clamp-2">
            {result.memo.title}
          </h3>
          <RelativeTime
            date={result.memo.updatedAt}
            className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          />
        </div>

        <p
          className={cn(
            "mt-1.5 text-xs leading-relaxed text-muted-foreground",
            compact ? "line-clamp-1" : "line-clamp-2"
          )}
        >
          {result.memo.abstract}
        </p>

        {!compact && (
          <>
            <div className="mt-2.5 flex min-w-0 items-center gap-2">
              <KnowledgeTypeBadge type={result.memo.knowledgeType} size="xs" />

              {result.memo.tags.length > 0 && (
                <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                  {result.memo.tags.slice(0, 2).map((tag) => (
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

            {(sourceLabel || rootLabel) && (
              <div className="mt-2 flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground/60">
                <MessageSquareQuote className="h-2.5 w-2.5 shrink-0" />
                <span className="min-w-0 truncate">
                  {sourceLabel}
                  {sourceLabel && rootLabel && result.rootStream?.id !== result.sourceStream?.id && (
                    <span className="text-muted-foreground/40"> in {rootLabel}</span>
                  )}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </Link>
  )
}
