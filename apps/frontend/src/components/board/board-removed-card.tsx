import { Link } from "react-router-dom"
import { BoardCard } from "@/components/board/board-card"
import { usePanel, createConversationPanelId } from "@/contexts"
import type { BoardViewPost, RemovedSuccessor } from "@/hooks/use-stable-board-view"
import { useConversationTitle } from "@/hooks/use-conversation-title"

interface BoardRemovedCardProps {
  workspaceId: string
  /** The last retained copy of the conversation whose row is gone. */
  post: BoardViewPost
  /** Where the post lived — the same header locator the live card renders. */
  contextLabel: string
  streamType: string | undefined
  dmPeerUserId?: string | null
  /** The conversation that now holds the opening message, or null when none does. */
  successor: RemovedSuccessor | null
  /** Overlay copy when there is no successor. Defaults to the left-the-board wording. */
  emptyLabel?: string
}

/**
 * A committed card whose conversation left the store — merged into another
 * conversation or emptied. The retained card still renders underneath at its
 * exact height, so the swap shifts nothing below it (INV-21); it is inert
 * (`removed`), so no reply composer opens and no read POST goes to a
 * conversation that no longer exists. The overlay is the only live surface:
 * it names where the content went. Pruned by the next commit.
 */
export function BoardRemovedCard({
  workspaceId,
  post,
  contextLabel,
  streamType,
  dmPeerUserId,
  successor,
  emptyLabel = "No longer on your board.",
}: BoardRemovedCardProps) {
  const { getPanelUrl } = usePanel()
  const successorTitle = useConversationTitle(workspaceId, successor ?? { streamId: "", topicSummary: null })

  return (
    <div className="relative">
      <BoardCard
        workspaceId={workspaceId}
        post={post}
        contextLabel={contextLabel}
        streamType={streamType}
        dmPeerUserId={dmPeerUserId}
        removed
      />
      {/* Top-pinned + sticky: tall cards pin their own header to the viewport, so a
          centered line — and the only successor link — could sit off-screen. */}
      <div className="absolute inset-0 flex items-start justify-center rounded-xl bg-background/60 text-xs text-muted-foreground">
        <div className="sticky top-2 py-2">
          {successor ? (
            <span>
              Merged into{" "}
              <Link
                to={getPanelUrl(createConversationPanelId(successor.conversationId))}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                {successorTitle ?? "another conversation"}
              </Link>
            </span>
          ) : (
            <span>{emptyLabel}</span>
          )}
        </div>
      </div>
    </div>
  )
}
