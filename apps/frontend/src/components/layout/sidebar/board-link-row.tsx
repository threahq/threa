import { Link } from "react-router-dom"
import { ArrowRight, LayoutGrid } from "lucide-react"
import { useSidebar } from "@/contexts"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { buildBoardHref, getLastLocation } from "@/lib/last-location"

interface BoardLinkRowProps {
  workspaceId: string
  /** The viewer's auth id — keys the last-location record for the board target. */
  userId: string | null
}

/**
 * Chats-mode counterpart to BoardModeBlock's "← Chats" row: a first-class link
 * to the board, restoring the viewer's last board state. Same row styling as
 * "← Chats", and the href mirrors that block's `chatsHref` derivation.
 */
export function BoardLinkRow({ workspaceId, userId }: BoardLinkRowProps) {
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
      <Link
        to={boardHref}
        onClick={collapseOnMobile}
        className="flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors text-muted-foreground hover:bg-muted/50"
      >
        <LayoutGrid className="h-4 w-4" />
        Board
        <ArrowRight className="ml-auto h-4 w-4" />
      </Link>
    </div>
  )
}
