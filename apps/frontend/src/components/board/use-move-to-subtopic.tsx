import { useCallback, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { GitBranch, Layers } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useReassignConversationMessage } from "@/hooks/use-conversations"
import { useBoardPosts } from "@/stores/board-store"
import type { BranchConversationView } from "@/lib/board/branch-grouping"

interface MoveTarget {
  conversationId: string
  title: string
  kind: "main" | "branch"
}

/**
 * How many sibling same-stream conversations a settling row offers. This is a
 * picker, not an index: the board store holds only the paginated head, so the
 * cache may not contain every conversation of the stream — offering the eight
 * most recently active is the intended ceiling, not a truncation bug.
 */
const SETTLING_SIBLING_TARGET_CAP = 8

/**
 * The board's "Move to sub-topic" re-file gesture, shared by the card and the
 * conversation panel (INV-35): moves a message's primary membership between the
 * main conversation and its nested sub-topic conversations under one root —
 * `reassignMessage` on the server relaxes its guard to the same effective-root
 * rule, so the timeline itself never changes (re-file, not relocation).
 *
 * `moveHandlerFor` yields a row-action handler only when the row has somewhere
 * to go (≥1 other non-pending conversation under the root); the action hides
 * otherwise, the same field-one-side-sets gate as `onNewSubtopic`. Passing
 * `settling` widens that list with the stream's other cached conversations —
 * see {@link SETTLING_SIBLING_TARGET_CAP}. Selecting a
 * target fires the move and closes — membership moves are reversible, so
 * there's no confirm step; a failure restores nothing and reports via toast.
 */
export function useMoveToSubtopic(params: {
  workspaceId: string
  conversation: { id: string; streamId: string; topicSummary: string | null }
  branchesByForkMessageId: Map<string, BranchConversationView[]>
  /** Whether this surface currently renders any settling row. Gates the sibling
   *  feed subscription: only settling rows read siblings, and a full-feed
   *  liveQuery per card re-fires on every board write (#1640's cost class). */
  hasSettlingRows?: boolean
}): {
  moveHandlerFor: (messageId: string, currentConversationId: string, settling?: boolean) => (() => void) | undefined
  moveDialog: ReactNode
} {
  const { workspaceId, conversation, branchesByForkMessageId, hasSettlingRows = false } = params
  const [pendingMove, setPendingMove] = useState<{
    messageId: string
    currentConversationId: string
    settling: boolean
  } | null>(null)
  const reassign = useReassignConversationMessage(workspaceId, conversation.streamId)

  // Every branch at any depth (sub-topics nest to depth 2 — a grandchild is as
  // valid a target as its parent; the server's one-root rule resolves any depth
  // to the same root). A pending branch's conversation doesn't exist server-side
  // yet (its id is the draft panel id), so it can be neither source nor target.
  const branches = useMemo(() => {
    const out: BranchConversationView[] = []
    const walk = (list: BranchConversationView[]) => {
      for (const branch of list) {
        if (!branch.pending) out.push(branch)
        walk(branch.children)
      }
    }
    walk([...branchesByForkMessageId.values()].flat())
    return out
  }, [branchesByForkMessageId])

  // A still-settling row is the one asking "does this belong here?", and in the
  // common case — a channel's main conversation with no sub-topics — the branch
  // list is empty, so the correction would have nowhere to go. Widen it to the
  // OTHER conversations of the same stream held by the board store: the server's
  // same-effective-root guard passes trivially for a same-stream target, so
  // these are legal re-file destinations. Settled rows never see them.
  // Gated on the card actually rendering a settling row: only those read
  // siblings, and an ungated full-feed liveQuery per card re-fires on every
  // board write (#1640's cost class).
  const boardPosts = useBoardPosts(workspaceId, { enabled: hasSettlingRows })
  const siblings = useMemo(() => {
    if (!boardPosts) return []
    return boardPosts
      .filter(
        (post) =>
          post.conversation.streamId === conversation.streamId &&
          post.conversation.id !== conversation.id &&
          post._status !== "pending" &&
          post.conversation.messageIds.length > 0
      )
      .sort((a, b) => b._lastActivityMs - a._lastActivityMs)
      .slice(0, SETTLING_SIBLING_TARGET_CAP)
      .map((post) => ({
        conversationId: post.conversation.id,
        title: post.conversation.topicSummary ?? "Untitled topic",
        kind: "main" as const,
      }))
  }, [boardPosts, conversation.streamId, conversation.id])

  const targetsFor = useCallback(
    (currentConversationId: string, settling = false): MoveTarget[] => {
      const targets: MoveTarget[] = [
        ...(currentConversationId !== conversation.id
          ? [
              {
                conversationId: conversation.id,
                title: conversation.topicSummary ?? "Main topic",
                kind: "main" as const,
              },
            ]
          : []),
        ...branches
          .filter((b) => b.conversationId !== currentConversationId)
          .map((b) => ({ conversationId: b.conversationId, title: b.title, kind: "branch" as const })),
      ]
      if (!settling) return targets
      const seen = new Set([currentConversationId, ...targets.map((t) => t.conversationId)])
      return [...targets, ...siblings.filter((s) => !seen.has(s.conversationId))]
    },
    [conversation.id, conversation.topicSummary, branches, siblings]
  )

  // Ignore opens and picks while a move is already in flight (mirrors the
  // conversation overlay's per-message pending guard): the re-file lands on the
  // mutation response, but a rapid re-tap before it settles must not enqueue a
  // second correction.
  const moveHandlerFor = useCallback(
    (messageId: string, currentConversationId: string, settling = false): (() => void) | undefined => {
      if (targetsFor(currentConversationId, settling).length === 0) return undefined
      return () => {
        if (reassign.isPending) return
        setPendingMove({ messageId, currentConversationId, settling })
      }
    },
    [targetsFor, reassign.isPending]
  )

  const selectTarget = useCallback(
    (target: MoveTarget) => {
      if (!pendingMove || reassign.isPending) return
      reassign.mutate(
        { messageId: pendingMove.messageId, toConversationId: target.conversationId },
        { onError: () => toast.error("Couldn't move the message. Please try again.") }
      )
      setPendingMove(null)
    },
    [pendingMove, reassign]
  )

  const targets = pendingMove ? targetsFor(pendingMove.currentConversationId, pendingMove.settling) : []

  const moveDialog = (
    <Dialog open={pendingMove !== null} onOpenChange={(open) => !open && setPendingMove(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{pendingMove?.settling ? "Move to another topic" : "Move to sub-topic"}</DialogTitle>
          <DialogDescription>
            {pendingMove?.settling
              ? "Re-file this message into the topic it belongs to. The message stays where it was posted."
              : "Re-file this message into another topic of this conversation. The message stays where it was posted."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
          {targets.map((target) => (
            <button
              key={target.conversationId}
              type="button"
              onClick={() => selectTarget(target)}
              className="flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
            >
              {target.kind === "main" ? (
                <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{target.title}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )

  return { moveHandlerFor, moveDialog }
}
