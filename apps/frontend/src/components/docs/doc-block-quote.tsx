import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { DocErrorCodes, StreamTypes } from "@threahq/types"
import { ApiError } from "@/api/client"
import { docKeys, docsApi } from "@/api/docs"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { Skeleton } from "@/components/ui/skeleton"
import { ThreadAnchorFrame } from "@/components/thread/thread-parent-event"
import { usePanel } from "@/contexts"
import { useStreamName } from "@/hooks/use-stream-name"
import { STREAM_ICONS } from "@/lib/streams"

const DocGlyph = STREAM_ICONS[StreamTypes.DOC]

interface DocBlockQuoteProps {
  workspaceId: string
  docId: string
  blockId: string
  replyCount: number
}

/** The doc block a section thread hangs on, as it reads now. */
export function DocBlockQuote({ workspaceId, docId, blockId, replyCount }: DocBlockQuoteProps) {
  const { getPanelUrl } = usePanel()
  const docName = useStreamName(workspaceId, docId) ?? "Doc"
  const { data, error, isPending } = useQuery({
    queryKey: docKeys.section(workspaceId, docId, blockId),
    queryFn: () => docsApi.getSection(workspaceId, docId, blockId),
  })
  const removed = ApiError.isApiError(error) && error.code === DocErrorCodes.SECTION_NOT_FOUND
  let quote: ReactNode
  if (data) quote = <MarkdownContent content={data.section.markdown} />
  else if (isPending) quote = <Skeleton className="h-4 w-2/3" />
  else
    quote = (
      <p className="text-muted-foreground">{removed ? "This block was removed" : "This block couldn't be loaded"}</p>
    )

  return (
    <ThreadAnchorFrame replyCount={replyCount}>
      <div className="flex flex-col gap-2 px-3 sm:px-6">
        <Link
          to={getPanelUrl(docId)}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <DocGlyph className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{docName}</span>
        </Link>
        <div className="border-l-2 pl-3 text-sm">{quote}</div>
      </div>
    </ThreadAnchorFrame>
  )
}
