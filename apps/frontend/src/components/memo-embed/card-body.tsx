import { type ReactNode } from "react"
import { Hash } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { RelativeTime } from "@/components/relative-time"
import { getKnowledgeConfig } from "@/lib/memo-display"
import { cn } from "@/lib/utils"
import type { MemoEmbedSource } from "@/hooks/use-memo-embed-source"

/**
 * Body renderer shared between the two memo-embed surfaces:
 *
 *   - `MemoEmbedView` — TipTap NodeView mounted inside the composer.
 *   - `MemoEmbedBlock` — paragraph swap inside the markdown renderer, used in
 *     the timeline / thread panel / activity feed.
 *
 * Both want the same gold-accent icon + eyebrow + title for each
 * `MemoEmbedSource` status. `trailing` is the top-right slot: the display block
 * passes the memo's date, the composer NodeView passes its remove button.
 *
 * `fallbackTitle` is the pre-hydration label stamped on the node at insert
 * time so the card reads sensibly before the live memo resolves.
 */
export function MemoEmbedCardBody({
  source,
  fallbackTitle,
  trailing,
}: {
  source: MemoEmbedSource
  fallbackTitle: string
  trailing?: ReactNode
}) {
  if (source.status === "missing") {
    return (
      <Row
        icon={<Hash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
        trailing={trailing}
      >
        <p className="font-medium leading-snug text-foreground/80 line-clamp-2">{fallbackTitle || "Memo"}</p>
        <p className="mt-0.5 text-xs italic text-muted-foreground">Memo no longer available</p>
      </Row>
    )
  }

  if (source.status === "pending") {
    return (
      <Row icon={<Hash className="mt-0.5 h-4 w-4 shrink-0 text-primary/60" aria-hidden="true" />} trailing={trailing}>
        {source.showSkeleton ? (
          <>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-1.5 h-3.5 w-48" />
          </>
        ) : (
          // Before the staggered-skeleton threshold, render the cached title so
          // the fast path (memo resolves within 300ms) doesn't flash a loader.
          <p className="font-medium leading-snug text-foreground line-clamp-2">{fallbackTitle || "Memo"}</p>
        )}
      </Row>
    )
  }

  const config = getKnowledgeConfig(source.knowledgeType)
  const Icon = config.icon
  const tags = source.tags.slice(0, 2)

  return (
    <Row icon={<Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />} trailing={trailing}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-medium lowercase text-primary/90">{config.label}</span>
        {tags.map((tag) => (
          <span key={tag} className="inline-flex min-w-0 items-center gap-0.5 text-muted-foreground/70">
            <Hash className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate lowercase">{tag}</span>
          </span>
        ))}
      </div>
      <p className="mt-0.5 font-medium leading-snug text-foreground line-clamp-2">{source.title || fallbackTitle}</p>
    </Row>
  )
}

function Row({ icon, trailing, children }: { icon: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </div>
  )
}

/** The memo's date for the display-block trailing slot. */
export function MemoEmbedDate({ source }: { source: MemoEmbedSource }) {
  if (source.status !== "resolved") return null
  return (
    <RelativeTime
      date={source.updatedAt}
      terse
      className={cn("mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70")}
    />
  )
}
