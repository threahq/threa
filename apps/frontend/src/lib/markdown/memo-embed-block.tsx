import { Link, useParams } from "react-router-dom"
import { cn } from "@/lib/utils"
import { useMemoEmbedSource } from "@/hooks/use-memo-embed-source"
import { MemoEmbedCardBody, MemoEmbedDate } from "@/components/memo-embed/card-body"

interface MemoEmbedBlockProps {
  memoId: string
  /** Title parsed from the markdown link text; used as a pre-hydration fallback. */
  title: string
}

/**
 * Renders the inline memo-embed card when a message body passes through
 * markdown rendering (timeline, thread panel, activity feed, and any surface
 * that consumes `contentMarkdown`). The in-composer card lives in
 * `MemoEmbedView` (a TipTap NodeView); both route through the shared resolver
 * hook + `MemoEmbedCardBody` so cache + render behavior match. The card links
 * to the memo in the memory explorer.
 */
export function MemoEmbedBlock({ memoId, title }: MemoEmbedBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const source = useMemoEmbedSource(memoId)

  const card = (
    <div
      className={cn(
        "my-1 rounded-md border border-border border-l-2 border-l-primary/70 bg-card px-3 py-2 text-sm",
        "transition-colors hover:border-l-primary hover:bg-primary/[0.04]"
      )}
      data-type="memo-embed"
    >
      <MemoEmbedCardBody source={source} fallbackTitle={title} trailing={<MemoEmbedDate source={source} />} />
    </div>
  )

  if (!workspaceId) return card

  return (
    <Link to={`/w/${workspaceId}/memory?memo=${memoId}`} className="block no-underline">
      {card}
    </Link>
  )
}
