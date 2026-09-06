import { Link } from "react-router-dom"
import { MemoResultItem } from "@/components/memo/memo-result-item"
import { ResultGroup } from "./result-group"
import type { MemoExplorerResult } from "@/api"

export function MemoMatches({
  memos,
  exploreHref,
  compact = false,
  defaultOpen = true,
}: {
  memos: MemoExplorerResult[]
  /** `/w/<ws>/memory?q=<query>` — the memo explorer link this section points into; each card appends `&memo=<id>`. */
  exploreHref: string
  /** Drops tags/source rows and clamps to one line, for the sidebar panel's narrower column. */
  compact?: boolean
  /** False starts the group collapsed (phone widths, where an open group pushes the messages off screen). */
  defaultOpen?: boolean
}) {
  if (memos.length === 0) return null

  return (
    <ResultGroup
      label="Memories"
      count={memos.length}
      defaultOpen={defaultOpen}
      action={
        <Link to={exploreHref} className="text-[11px] text-muted-foreground hover:text-foreground">
          See all
        </Link>
      }
    >
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
    </ResultGroup>
  )
}
