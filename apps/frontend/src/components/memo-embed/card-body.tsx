import { type ReactNode } from "react"
import { Hash } from "lucide-react"
import { RelativeTime } from "@/components/relative-time"
import { getKnowledgeConfig } from "@/lib/memo-display"
import { cn } from "@/lib/utils"
import type { MemoEmbedSource } from "@/hooks/use-memo-embed-source"

/**
 * Body renderer for the memo-embed preview card (`MemoEmbedBlock`), rendered
 * below a message for each referenced memo.
 *
 * Every status renders the SAME three boxes — eyebrow line, title block, date
 * slot — at the same size, so the card's geometry never depends on whether the
 * memo has resolved (INV-21). Only their contents differ. This is load-bearing:
 * the card used to be a line shorter until its fetch landed, so two of them
 * above the fold pushed the whole timeline down on first paint.
 *
 * The three sizes are pinned in rem rather than left to `text-*` defaults so the
 * arithmetic is exact — a one-line title reserving 2.375rem and a two-line title
 * at 2 x 1.1875rem are the same number, not the same number give or take a
 * subpixel.
 */
const EYEBROW_ROW = "flex h-4 min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground"
const TITLE_BLOCK = "mt-0.5 line-clamp-2 min-h-[2.375rem] font-medium leading-[1.1875rem]"
/** Wide enough for the widest terse relative time ("yesterday", "Jan 15, 25"). */
const DATE_SLOT = "mt-0.5 w-14 shrink-0 text-right text-[10px] leading-4 tabular-nums text-muted-foreground/70"

const ICON_TONE: Record<MemoEmbedSource["status"], string> = {
  resolved: "text-primary",
  pending: "text-primary/60",
  missing: "text-muted-foreground",
}

export function MemoEmbedCardBody({
  source,
  fallbackTitle,
  trailing,
}: {
  source: MemoEmbedSource
  /** Label parsed from the reference — what the card shows until the memo resolves. */
  fallbackTitle: string
  trailing?: ReactNode
}) {
  const resolved = source.status === "resolved" ? source : null
  const Icon = resolved ? getKnowledgeConfig(resolved.knowledgeType).icon : Hash

  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", ICON_TONE[source.status])} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className={EYEBROW_ROW}>
          <Eyebrow source={source} />
        </div>
        <p className={cn(TITLE_BLOCK, source.status === "missing" ? "text-foreground/80" : "text-foreground")}>
          {resolved?.title || fallbackTitle || "Memo"}
        </p>
      </div>
      {trailing}
    </div>
  )
}

/**
 * Contents of the eyebrow line. A pending card leaves it empty rather than
 * showing a loader: the row already holds its height, so a skeleton would only
 * add a flash to a card that is not moving.
 */
function Eyebrow({ source }: { source: MemoEmbedSource }) {
  if (source.status === "missing") {
    return <span className="truncate italic">Memo no longer available</span>
  }
  if (source.status === "pending") return null

  const config = getKnowledgeConfig(source.knowledgeType)
  return (
    <>
      <span className="font-medium lowercase text-primary/90">{config.label}</span>
      {source.tags.slice(0, 2).map((tag) => (
        <span key={tag} className="inline-flex min-w-0 items-center gap-0.5 text-muted-foreground/70">
          <Hash className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate lowercase">{tag}</span>
        </span>
      ))}
    </>
  )
}

/**
 * The memo's date for the display-block trailing slot. The slot is always
 * rendered at a fixed width, empty until the memo resolves — otherwise the
 * title's available width changes when the date arrives and the text reflows
 * under the reader.
 */
export function MemoEmbedDate({ source }: { source: MemoEmbedSource }) {
  return (
    <div className={DATE_SLOT}>
      {source.status === "resolved" ? <RelativeTime date={source.updatedAt} terse /> : null}
    </div>
  )
}
