import { Share2 } from "lucide-react"
import { Link, useParams } from "react-router-dom"
import type { ContentRange } from "@threahq/types"
import { cn } from "@/lib/utils"
import { useSharedMessageSource } from "@/hooks/use-shared-message-source"
import { SharedMessageCardBody } from "@/components/shared-messages/card-body"
import { buildConversationPanelPath } from "@/lib/stream-links"

interface SharedMessagePointerBlockProps {
  streamId: string
  messageId: string
  /** Author name parsed from the markdown link text; used as a pre-hydration fallback. */
  authorName: string
  /**
   * The conversation the message was shared from, when the pointer carries one
   * (share originated on a board card / conversation panel). Reopens the source
   * in that conversation's side panel; absent pointers link to the home-stream
   * permalink as before.
   */
  conversationId?: string
  /** Source revision the pointer pins, parsed off the href; null = unpinned. */
  version: number | null
  /** Span of the pinned revision the pointer renders; null = the whole message. */
  range: ContentRange | null
}

/**
 * Renders the inline pointer card for a sharedMessage node when a message body
 * passes through markdown rendering (i.e. the timeline, thread panel, and any
 * other surface that consumes `contentMarkdown`). The in-composer card lives
 * in `SharedMessageView` (a TipTap NodeView); both route through the shared
 * resolver hook + `SharedMessageCardBody` so cache + render behavior matches.
 */
export function SharedMessagePointerBlock({
  streamId,
  messageId,
  authorName,
  conversationId,
  version,
  range,
}: SharedMessagePointerBlockProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const source = useSharedMessageSource({ messageId, streamId, version, range })

  const card = (
    <div
      className={cn(
        "my-1 flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm",
        "hover:bg-accent/30 transition-colors"
      )}
      data-type="shared-message"
    >
      <Share2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <SharedMessageCardBody source={source} fallbackAuthor={authorName} />
      </div>
    </div>
  )

  if (!workspaceId) return card

  // A conversation-origin pointer reopens the source in its conversation panel
  // (resolved under the clicking viewer's own access — the panel self-guards);
  // otherwise the card links to the message's home-stream permalink as before.
  const target = conversationId
    ? buildConversationPanelPath(workspaceId, conversationId, messageId)
    : `/w/${workspaceId}/s/${streamId}?m=${messageId}`

  return (
    <Link to={target} className="block no-underline">
      {card}
    </Link>
  )
}
