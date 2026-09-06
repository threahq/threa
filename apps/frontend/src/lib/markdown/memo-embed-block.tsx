import { useState } from "react"
import { useParams } from "react-router-dom"
import type { MemoEmbedSummary } from "@threahq/types"
import { cn } from "@/lib/utils"
import { MemoEmbedCardBody, MemoEmbedDate } from "@/components/memo-embed/card-body"
import { MemoPreviewDialog } from "@/components/memo/memo-preview-dialog"

interface MemoEmbedBlockProps {
  memoId: string
  /** Title parsed from the markdown link text; the card's whole content without a summary. */
  title: string
  /**
   * The memo's card content, delivered with the message. There is deliberately
   * no fetch here: the stream renders what it was given (INV-21 — content may
   * change only when the memo changed, never because it hadn't loaded yet).
   */
  summary: MemoEmbedSummary | null
}

/**
 * Renders a memo-embed preview card below a message (`MemoPreviewList`), one
 * per memo referenced in the body — mirroring how link previews surface. The
 * inline reference itself renders as a `MemoChip`. Clicking the card opens an
 * in-stream preview (`MemoPreviewDialog`) — a modal on desktop, a drawer on
 * mobile — which is where the memo's substance is fetched, access-checked, and
 * where the link through to the memory explorer lives.
 */
export function MemoEmbedBlock({ memoId, title, summary }: MemoEmbedBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [open, setOpen] = useState(false)

  const card = (
    <div
      className={cn(
        "rounded-md border border-border border-l-2 border-l-primary/70 bg-card px-3 py-2 text-sm",
        "transition-colors group-hover:border-l-primary group-hover:bg-primary/[0.04]"
      )}
      data-type="memo-embed"
    >
      <MemoEmbedCardBody summary={summary} fallbackTitle={title} trailing={<MemoEmbedDate summary={summary} />} />
    </div>
  )

  // No workspace context (shouldn't happen in-stream) — render a static card.
  if (!workspaceId) return <div className="my-1">{card}</div>

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cn(
          "group my-1 block w-full rounded-md text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        )}
      >
        {card}
      </button>
      <MemoPreviewDialog
        open={open}
        onOpenChange={setOpen}
        workspaceId={workspaceId}
        memoId={memoId}
        fallbackTitle={summary?.title || title}
      />
    </>
  )
}
