import { Link } from "react-router-dom"
import { MemoResultItem } from "@/components/memo/memo-result-item"
import type { MemoExplorerResult } from "@/api"

/**
 * Top memo matches for a search query, rendered above message results on the
 * search page and sidebar search panel. Renders nothing when there are no
 * memo matches — a query can match a memo and no message, or vice versa.
 */
export function MemoMatches({
  memos,
  exploreHref,
  compact = false,
}: {
  memos: MemoExplorerResult[]
  /** `/w/<ws>/memory?q=<query>` — the memo explorer link this section points into; each card appends `&memo=<id>`. */
  exploreHref: string
  /** Drops tags/source rows and clamps to one line, for the sidebar panel's narrower column. */
  compact?: boolean
}) {
  if (memos.length === 0) return null

  return (
    <div className="mb-3 border-b border-border/50 pb-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Memories</span>
        <Link to={exploreHref} className="text-[11px] text-muted-foreground hover:text-foreground">
          See all
        </Link>
      </div>
      <ul className="flex flex-col gap-1.5">
        {memos.map((result) => (
          <li key={result.memo.id}>
            <MemoResultItem
              result={result}
              isActive={false}
              href={`${exploreHref}&memo=${result.memo.id}`}
              compact={compact}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}
