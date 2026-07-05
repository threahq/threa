import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { CornerDownRight, GitBranch, ArrowRight, MoveRight } from "lucide-react"
import { useStreamName } from "@/hooks/use-stream-name"
import { usePanel, createConversationPanelId } from "@/contexts"
import { BoardEventRowItem, type BoardRow } from "@/components/board/board-row-item"
import type { RenderableMessage } from "@/components/message/message-item"

/** Indent per thread boundary (spanning), applied on a wrapper so the shared
 *  `MessageItem` stays untouched. A left rail reads the nesting Reddit-style. */
const INDENT_CLASS: Record<number, string> = {
  1: "ml-3 border-l-2 border-border pl-2 sm:pl-3",
  2: "ml-6 border-l-2 border-border pl-2 sm:pl-3",
}

/**
 * The "continued in …" divider for a soft thread (convert-to-thread, or the
 * thread→root Slack case). Subtle and non-interactive: the thread is transport,
 * not a branch, so it names where the conversation moved without pulling the
 * reader out of the card.
 */
export function ThreadSeamRow({
  workspaceId,
  streamId,
  direction,
}: {
  workspaceId: string
  streamId: string
  direction: "down" | "up"
}) {
  const label = useStreamName(workspaceId, streamId, "generic") ?? "thread"
  const Icon = direction === "up" ? MoveRight : CornerDownRight
  return (
    <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">continued in {label}</span>
    </div>
  )
}

/**
 * A true-thread branch stub on the parent card — "↳ <child topic>" at the fork
 * point, linking to the child conversation panel (INV-40). The nesting survives
 * *between* cards instead of inside one.
 */
export function BranchStubRow({ conversationId, title }: { conversationId: string; title: string }) {
  const { getPanelUrl } = usePanel()
  return (
    <Link
      to={getPanelUrl(createConversationPanelId(conversationId))}
      className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{title}</span>
    </Link>
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
    <Link
      to={getPanelUrl(createConversationPanelId(conversationId))}
      className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
}

function renderRowContent(
  row: BoardRow,
  { workspaceId, renderMessage, continueThreadTo }: BranchedBoardRowsProps
): ReactNode {
  switch (row.kind) {
    case "message":
      return renderMessage(row.message, row.continuation)
    case "event":
      return <BoardEventRowItem key={row.key} row={row.row} workspaceId={workspaceId} />
    case "seam":
      return <ThreadSeamRow key={row.key} workspaceId={workspaceId} streamId={row.streamId} direction={row.direction} />
    case "branch-stub":
      return <BranchStubRow key={row.key} conversationId={row.childConversationId} title={row.title} />
    case "continue-thread":
      return <ContinueThreadRow key={row.key} to={continueThreadTo(row.streamId)} hiddenCount={row.hiddenCount} />
  }
}

/**
 * Render a branch-grouped row list: message rows through the surface's own
 * renderer, event/branch chrome through the components above, each indented by
 * its `displayDepth` via a wrapper element (indent never touches `MessageItem`).
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
