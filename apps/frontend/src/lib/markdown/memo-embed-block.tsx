import { useState } from "react"
import { useParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoEmbedCardBody, MemoEmbedDate } from "@/components/memo-embed/card-body"
import { MemoPreviewDialog } from "@/components/memo/memo-preview-dialog"

interface MemoEmbedBlockProps {
  memoId: string
  /** Title parsed from the markdown link text; used as a pre-hydration fallback. */
  title: string
}

/**
 * Renders a memo-embed preview card below a message (`MemoPreviewList`), one
 * per memo referenced in the body — mirroring how link previews surface. The
 * inline reference itself renders as a `MemoChip`. The card body routes through
 * the shared resolver hook + `MemoEmbedCardBody` so cache + render behavior
 * match the composer chip. Clicking the card opens an in-stream preview
 * (`MemoPreviewDialog`) — a modal on desktop, a drawer on mobile — which links
 * through to the full memo in the memory explorer.
 */
export function MemoEmbedBlock({ memoId, title }: MemoEmbedBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const source = useMemoEmbedSource(memoId)
  const [open, setOpen] = useState(false)

  const card = (
    <div
      className={cn(
        "rounded-md border border-border border-l-2 border-l-primary/70 bg-card px-3 py-2 text-sm",
        "transition-colors group-hover:border-l-primary group-hover:bg-primary/[0.04]"
      )}
      data-type="memo-embed"
    >
      <MemoEmbedCardBody source={source} fallbackTitle={title} trailing={<MemoEmbedDate source={source} />} />
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
        fallbackTitle={title}
      />
    </>
  )
}
