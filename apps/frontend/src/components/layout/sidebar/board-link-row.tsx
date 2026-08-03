import { Link, useLocation } from "react-router-dom"
import { ArrowLeft, ArrowRight, CircleDot, LayoutGrid } from "lucide-react"
import { useSidebar, usePreferencesOptional } from "@/contexts"
import { useWorkspaceStreams } from "@/stores/workspace-store"
import { useBoardViews } from "@/hooks/use-board-views"
import { boardHomeHref } from "@/components/board/board-saved-views"
import {
  BOARD_UNREAD_ON,
  BOARD_UNREAD_PARAM,
  clearUnreadSearch,
  parseLensParam,
  unreadFocusSearch,
} from "@/components/board/board-filter-params"
import { UnreadBadge } from "@/components/unread-badge"
import { cn } from "@/lib/utils"
import { buildBoardHref, getLastLocation } from "@/lib/last-location"
import { isBoardPath } from "./board-sidebar-mode"

const ROW_BASE_CLASS = "flex items-center gap-2.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
const ROW_CLASS = `${ROW_BASE_CLASS} text-muted-foreground hover:bg-muted/50`

interface ModeLinkRowProps {
  workspaceId: string
  /** The viewer's auth id — keys the last-location record for the link target. */
  userId: string | null
}

/**
 * One-click unreads: navigates to the board narrowed to unread conversations
 * (`?unread=true`), and off again when it's already on. Rendered in both modes —
 * from the board it edits the live URL surgically (every other axis, the lens and
 * an open `?panel=` survive); from anywhere else it lands on the viewer's board
 * home with the narrowing applied. A navigation, so a `<Link>` (INV-40), and the
 * active state is read from the URL, never held (INV-59).
 */
export function BoardUnreadRow({
  workspaceId,
  unreadStreamCount,
}: {
  workspaceId: string
  /** Streams the viewer has unread (muted excluded), derived once by the
   *  sidebar for its Unread section. A WORKSPACE-wide signal: the board view it
   *  lands on still applies the active lens/scope/saved-view filters, so a
   *  narrowed view can show fewer conversations than the badge counts. */
  unreadStreamCount: number
}) {
  const { collapseOnMobile } = useSidebar()
  const location = useLocation()
  const prefs = usePreferencesOptional()
  const { data: views } = useBoardViews(workspaceId)

  const onBoard = isBoardPath(location.pathname)
  const active = onBoard && new URLSearchParams(location.search).get(BOARD_UNREAD_PARAM) === BOARD_UNREAD_ON

  let to: string
  if (onBoard) {
    to = `${location.pathname}${active ? clearUnreadSearch(location.search) : unreadFocusSearch(location.search)}`
  } else {
    const home = boardHomeHref(
      workspaceId,
      prefs?.preferences?.boardDefaultViewId ?? null,
      views,
      parseLensParam(prefs?.preferences?.boardDefaultLens ?? null)
    )
    const [path, search] = home.split("?")
    to = `${path}${unreadFocusSearch(search ?? "")}`
  }

  return (
    <Link
      to={to}
      // On-board flips rewrite the URL in place — the FilterToggleRow this row
      // replaced used `replace`, and Back walking through unread on/off flips is
      // history spam. From elsewhere it is a real navigation and keeps its entry.
      replace={onBoard}
      onClick={collapseOnMobile}
      aria-current={active ? "true" : undefined}
      className={cn(ROW_BASE_CLASS, active ? "bg-primary/10" : "text-muted-foreground hover:bg-muted/50")}
    >
      <CircleDot className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Unread</span>
      {unreadStreamCount > 0 && <UnreadBadge count={unreadStreamCount} className="ml-auto" />}
    </Link>
  )
}

/**
 * Chats-mode link to the board, restoring the viewer's last board state. Pairs
 * with `ChatsLinkRow`: both sit at the same spot (above the quick links) so the
 * cross-surface entry point doesn't move between modes.
 */
export function BoardLinkRow({
  workspaceId,
  userId,
  unreadStreamCount,
}: ModeLinkRowProps & { unreadStreamCount: number }) {
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
      <BoardUnreadRow workspaceId={workspaceId} unreadStreamCount={unreadStreamCount} />
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
