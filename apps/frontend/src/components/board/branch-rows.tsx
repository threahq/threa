import { Fragment, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { CornerDownRight, GitBranch, ArrowRight, MoveRight, ChevronDown, Scissors } from "lucide-react"
import { useStreamName } from "@/hooks/use-stream-name"
import { usePanel, createConversationPanelId } from "@/contexts"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { BoardEventRowItem, type BoardRow } from "@/components/board/board-row-item"
import { DayDivider } from "@/components/timeline/day-divider"
import { UnreadDivider } from "@/components/timeline/unread-divider"
import { isContinuation, type RenderableMessage } from "@/components/message/message-item"
import type { BranchConversationView } from "@/lib/board/branch-grouping"

/** Indent per thread boundary (spanning), applied on a wrapper so the shared
 *  `MessageItem` stays untouched. A left rail reads the nesting Reddit-style. */
const INDENT_CLASS: Record<number, string> = {
  1: "ml-3 border-l-2 border-muted-foreground/20 pl-2 sm:pl-3",
  2: "ml-6 border-l-2 border-muted-foreground/20 pl-2 sm:pl-3",
}

/**
 * The "continued in …" divider for a soft thread (convert-to-thread, or the
 * thread→root Slack case). Names where the conversation moved without pulling
 * the reader out of the card. A "down" seam (the conversation continued INTO a
 * thread) also carries the "split into its own topic" heal — an "up" seam names
 * the root, which can't become a sub-topic, so it stays label-only.
 */
export function ThreadSeamRow({
  workspaceId,
  streamId,
  direction,
  onSplit,
}: {
  workspaceId: string
  streamId: string
  direction: "down" | "up"
  /** Promote this thread into its own conversation. Absent ⇒ no split affordance. */
  onSplit?: () => void
}) {
  const label = useStreamName(workspaceId, streamId, "generic") ?? "thread"
  const Icon = direction === "up" ? MoveRight : CornerDownRight
  return (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">continued in {label}</span>
      {direction === "down" && onSplit && <SplitThreadAction label={label} onConfirm={onSplit} />}
    </div>
  )
}

/**
 * The seam's "split into its own topic" affordance: an action button (INV-40) that
 * confirms through a plain AlertDialog before promoting the thread — the move is
 * a correction the user should mean, and the card visibly re-forms afterward
 * (no success toast, INV-63).
 */
function SplitThreadAction({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          <Scissors className="h-3 w-3 shrink-0" />
          Split into its own topic
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Split this thread into its own topic?</AlertDialogTitle>
          <AlertDialogDescription>
            {label} and its replies move out of this conversation into a new topic anchored to the thread. It stays on
            the card as a nested branch.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Split</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

interface BranchGroupProps {
  branch: BranchConversationView
  /** Render one of the branch's own messages — render-only (its read state belongs
   *  to the child conversation, not the parent card). Omitted ⇒ header only. */
  renderBranchMessage?: (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => ReactNode
  /** The inline reply affordance / composer at the branch's tail. */
  renderBranchTail?: (branch: BranchConversationView) => ReactNode
  /** The inline "new sub-topic" composer slot under a message row (parent or branch). */
  renderAfterMessage?: (messageId: string) => ReactNode
}

/**
 * A branch conversation nested inside a parent card (Kris dogfood ruling
 * 2026-07-05, board-view-design.md): a "↳ <child topic>" header linking to the
 * child conversation panel (INV-40), with the child's own messages rendered
 * indented under it and grandchildren nested one level deeper (each adds a
 * left rail). Reddit/Facebook-style nested comments — the nesting lives INSIDE
 * one card, not between two. Beyond the depth cap the subtree collapses to a
 * "Continue this thread" link into the branch's own panel.
 */
/**
 * Where a nested branch row draws its settling rail. A branch row has no left
 * padding of its own (the group above carries `pl-2 sm:pl-3` plus its 2px
 * spine), so the default `left-0` would paint over the avatar. These offsets put
 * the dashed rail exactly on the group's spine for a plain (user) row, and at
 * the same physical spot for a colored row, which is already broken out onto the
 * spine by `-mx-2.5 sm:-mx-3.5`. Absolute overlay either way — no box change.
 */
export const BRANCH_SETTLING_RAIL_CLASS = "-left-2.5 sm:-left-3.5"
export const BRANCH_ACCENTED_SETTLING_RAIL_CLASS = "left-0"

export function BranchGroup({ branch, renderBranchMessage, renderBranchTail, renderAfterMessage }: BranchGroupProps) {
  const { getPanelUrl } = usePanel()
  const panelUrl = getPanelUrl(createConversationPanelId(branch.conversationId))
  // A pending branch (sub-topic sent, conversation echo not landed) has no real
  // conversation to open yet — its header is inert until the graph takes over.
  const header = (
    <>
      <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate font-medium text-foreground/75">{branch.title}</span>
    </>
  )
  return (
    <div className="mt-3">
      {branch.pending ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{header}</div>
      ) : (
        <Link
          to={panelUrl}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {header}
        </Link>
      )}
      <div className="mt-1 border-l-2 border-muted-foreground/25 pl-2 sm:pl-3 [&>*:first-child]:mt-0">
        {renderBranchMessage &&
          branch.messages.map((message, index) => {
            const prev = index > 0 ? branch.messages[index - 1] : null
            const continuation = prev != null && isContinuation(prev, message)
            return (
              <Fragment key={message.id}>
                {renderBranchMessage(branch, message, continuation)}
                {renderAfterMessage?.(message.id)}
              </Fragment>
            )
          })}
        {branch.hiddenCount > 0 && (
          <Link
            to={panelUrl}
            className="mt-3 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            {branch.hiddenCount} more {branch.hiddenCount === 1 ? "reply" : "replies"}
          </Link>
        )}
        {branch.children.map((child) => (
          <BranchGroup
            key={child.conversationId}
            branch={child}
            renderBranchMessage={renderBranchMessage}
            renderBranchTail={renderBranchTail}
            renderAfterMessage={renderAfterMessage}
          />
        ))}
        {branch.overflow && (
          <Link
            to={panelUrl}
            className="mt-3 flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowRight className="h-3.5 w-3.5 shrink-0" />
            Continue this thread
          </Link>
        )}
        {renderBranchTail?.(branch)}
      </div>
    </div>
  )
}

/**
 * "Branched from <parent topic>" provenance at the top of a child card, linking
 * to the parent conversation panel (INV-40) — the conversation-grain mirror of
 * the message-grain provenance chip.
 */
export function BranchProvenanceRow({ conversationId, title }: { conversationId: string; title: string }) {
  const { getPanelUrl } = usePanel()
  return (
    // Leads the card/panel message list; carries its own top gap (like the
    // sibling ContinueThreadRow) since the rows below self-space via their
    // internal padding and the container no longer adds a leading margin.
    <Link
      to={getPanelUrl(createConversationPanelId(conversationId))}
      className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <GitBranch className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Branched from {title}</span>
    </Link>
  )
}

/**
 * The spanning depth cap: a thread nested past two boundaries collapses to one
 * link — into the conversation panel from a card, or into the thread's own panel
 * from the conversation panel (`to` resolved by the surface, INV-40).
 */
export function ContinueThreadRow({ to, hiddenCount }: { to: string; hiddenCount: number }) {
  return (
    <Link
      to={to}
      aria-label={`Continue this thread (${hiddenCount} more)`}
      className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowRight className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">Continue this thread</span>
    </Link>
  )
}

interface BranchedBoardRowsProps {
  rows: BoardRow[]
  workspaceId: string
  renderMessage: (message: RenderableMessage, continuation: boolean) => ReactNode
  /** Where a spanning-overflow row links, given the deep thread's stream. */
  continueThreadTo: (streamId: string) => string
  /** Split a soft-thread seam into its own conversation. Absent ⇒ no seam split
   *  affordance (a read-only surface). */
  onSplitThread?: (threadStreamId: string) => void
  /** Render a nested branch conversation's own message (render-only). Passed by the
   *  card/panel so a branch group can draw the child's rows; omit ⇒ header only. */
  renderBranchMessage?: (branch: BranchConversationView, message: RenderableMessage, continuation: boolean) => ReactNode
  /** The inline reply affordance / composer at a branch group's tail. */
  renderBranchTail?: (branch: BranchConversationView) => ReactNode
  /** The inline "new sub-topic" composer slot rendered under a message row. */
  renderAfterMessage?: (messageId: string) => ReactNode
  /** Open + focus the surface's reply composer for a running session's Redirect. */
  onRedirectSession?: () => void
}

function renderRowContent(row: BoardRow, props: BranchedBoardRowsProps): ReactNode {
  const {
    workspaceId,
    renderMessage,
    continueThreadTo,
    renderBranchMessage,
    renderBranchTail,
    renderAfterMessage,
    onSplitThread,
    onRedirectSession,
  } = props
  switch (row.kind) {
    case "message":
      return (
        <Fragment key={row.key}>
          {renderMessage(row.message, row.continuation)}
          {renderAfterMessage?.(row.message.id)}
        </Fragment>
      )
    case "event":
      return (
        <BoardEventRowItem
          key={row.key}
          row={row.row}
          workspaceId={workspaceId}
          onRedirectSession={onRedirectSession}
        />
      )
    case "seam":
      return (
        <ThreadSeamRow
          key={row.key}
          workspaceId={workspaceId}
          streamId={row.streamId}
          direction={row.direction}
          onSplit={onSplitThread ? () => onSplitThread(row.streamId) : undefined}
        />
      )
    case "branch-group":
      return (
        <BranchGroup
          key={row.key}
          branch={row.branch}
          renderBranchMessage={renderBranchMessage}
          renderBranchTail={renderBranchTail}
          renderAfterMessage={renderAfterMessage}
        />
      )
    case "continue-thread":
      return <ContinueThreadRow key={row.key} to={continueThreadTo(row.streamId)} hiddenCount={row.hiddenCount} />
    case "day":
      return <DayDivider key={row.key} dayStartMs={row.dayStartMs} />
    case "unread":
      // UnreadDivider is absolute and overlays the gap above its row; the panel
      // is not virtualized, so an in-flow spacer that reserves the gap is all it
      // needs. It dims by colour, so nothing shifts when it settles (INV-21).
      return (
        <div key={row.key} className="relative h-6">
          <UnreadDivider isDimmed={row.isDimmed} />
        </div>
      )
    // A new BoardRow kind with no case here would return undefined and render an
    // invisible gap that still counts toward the row list — tsconfig sets no
    // `noImplicitReturns` and ReactNode admits undefined, so only this makes it
    // a compile error.
    default: {
      const exhaustive: never = row
      return exhaustive
    }
  }
}

/**
 * Render a branch-grouped row list: message rows through the surface's own
 * renderer, event/branch chrome through the components above, each indented by
 * its `displayDepth` via a wrapper element (indent never touches `MessageItem`).
 * A branch group adds its own nested left rail INSIDE the row indent, so a
 * branch off an already-indented spanning row nests one level deeper.
 */
export function BranchedBoardRows(props: BranchedBoardRowsProps) {
  return (
    <>
      {props.rows.map((row) => {
        const depth = row.displayDepth ?? 0
        const content = renderRowContent(row, props)
        if (depth === 0) return content
        return (
          <div key={row.key} className={INDENT_CLASS[depth]}>
            {content}
          </div>
        )
      })}
    </>
  )
}
