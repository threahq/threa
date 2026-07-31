import { type ReactNode } from "react"
import { Hash } from "lucide-react"
import type { MemoEmbedSummary } from "@threa/types"
import { RelativeTime } from "@/components/relative-time"
import { getKnowledgeConfig } from "@/lib/memo-display"
import { cn } from "@/lib/utils"

/**
 * Body renderer for the memo-embed preview card (`MemoEmbedBlock`), rendered
 * below a message for each referenced memo.
 *
 * The card has two states and both are FINAL on first paint: with the memo's
 * card content, or with just the label parsed from the reference. Nothing here
 * loads, so nothing here changes — a card is only ever redrawn because the memo
 * itself changed. That is why the reserved height this file used to carry is
 * gone: it existed to survive a pending state, and there is no longer one. Each
 * card is sized by its own content and stays that size.
 *
 * A card lands in the label-only state when the summary could not ride the
 * message: a sealed stream whose body the server cannot read and whose composer
 * did not stamp the node, a message written before this shipped, or a memo the
 * citing room cannot uniformly open.
 */
export function MemoEmbedCardBody({
  summary,
  fallbackTitle,
  trailing,
}: {
  summary: MemoEmbedSummary | null
  /** Label parsed from the reference — the whole card when there is no summary. */
  fallbackTitle: string
  trailing?: ReactNode
}) {
  const config = summary ? getKnowledgeConfig(summary.knowledgeType) : null
  const Icon = config?.icon ?? Hash

  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", summary ? "text-primary" : "text-primary/60")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {summary && config && (
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium lowercase text-primary/90">{config.label}</span>
            {summary.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="inline-flex min-w-0 items-center gap-0.5 text-muted-foreground/70">
                <Hash className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate lowercase">{tag}</span>
              </span>
            ))}
          </div>
        )}
        <p className={cn("line-clamp-2 font-medium leading-snug text-foreground", summary && "mt-0.5")}>
          {summary?.title || fallbackTitle || "Memo"}
        </p>
      </div>
      {trailing}
    </div>
  )
}

/** The memo's date for the display-block trailing slot. */
export function MemoEmbedDate({ summary }: { summary: MemoEmbedSummary | null }) {
  if (!summary) return null
  return (
    <RelativeTime
      date={summary.updatedAt}
      terse
      className="mt-0.5 shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
    />
  )
}
