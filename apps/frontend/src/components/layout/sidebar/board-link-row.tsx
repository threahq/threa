import { Link } from "react-router-dom"
import { ArrowLeft, ArrowRight, LayoutGrid } from "lucide-react"
import { useSidebar } from "@/contexts"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { buildBoardHref, getLastLocation } from "@/lib/last-location"

const ROW_CLASS =
  "flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors text-muted-foreground hover:bg-muted/50"

interface ModeLinkRowProps {
  workspaceId: string
  /** The viewer's auth id — keys the last-location record for the link target. */
  userId: string | null
}

/**
 * Chats-mode link to the board, restoring the viewer's last board state. Pairs
 * with `ChatsLinkRow`: both sit at the same spot (above the quick links) so the
 * cross-surface entry point doesn't move between modes.
 */
export function BoardLinkRow({ workspaceId, userId }: ModeLinkRowProps) {
  const { collapseOnMobile } = useSidebar()
  const streams = useWorkspaceStreams(workspaceId)

  const record = userId ? getLastLocation(userId, workspaceId) : null
  const boardHref = record?.board
    ? buildBoardHref(
        workspaceId,
        record.board,
        streams.map((s) => s.id)
      )
    : `/w/${workspaceId}/board`

  return (
    <div className="mb-2 space-y-1">
      <Link to={boardHref} onClick={collapseOnMobile} className={ROW_CLASS}>
        <LayoutGrid className="h-4 w-4" />
        Board
        <ArrowRight className="ml-auto h-4 w-4" />
      </Link>
    </div>
  )
}

/** Board-mode counterpart: back to the viewer's last stream (or the workspace
 *  home when none was retained). */
export function ChatsLinkRow({ workspaceId, userId }: ModeLinkRowProps) {
  const { collapseOnMobile } = useSidebar()

  const record = userId ? getLastLocation(userId, workspaceId) : null
  const chatsHref = record?.streamId ? `/w/${workspaceId}/s/${record.streamId}` : `/w/${workspaceId}`

  return (
    <div className="mb-2 space-y-1">
      <Link to={chatsHref} onClick={collapseOnMobile} className={ROW_CLASS}>
        <ArrowLeft className="h-4 w-4" />
        Chats
      </Link>
    </div>
  )
}
