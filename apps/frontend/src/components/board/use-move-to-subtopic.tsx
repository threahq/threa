import { useCallback, useMemo, useState, type ReactNode } from "react"
import { toast } from "sonner"
import { GitBranch, Layers } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { useReassignConversationMessage } from "@/hooks/use-conversations"
import type { BranchConversationView } from "@/lib/board/branch-grouping"

interface MoveTarget {
  conversationId: string
  title: string
  kind: "main" | "branch"
}

/**
 * The board's "Move to sub-topic" re-file gesture, shared by the card and the
 * conversation panel (INV-35): moves a message's primary membership between the
 * main conversation and its nested sub-topic conversations under one root —
 * `reassignMessage` on the server relaxes its guard to the same effective-root
 * rule, so the timeline itself never changes (re-file, not relocation).
 *
 * `moveHandlerFor` yields a row-action handler only when the row has somewhere
 * to go (≥1 other non-pending conversation under the root); the action hides
 * otherwise, the same field-one-side-sets gate as `onNewSubtopic`. Selecting a
 * target fires the move and closes — membership moves are reversible, so
 * there's no confirm step; a failure restores nothing and reports via toast.
 */
export function useMoveToSubtopic(params: {
  workspaceId: string
  conversation: { id: string; streamId: string; topicSummary: string | null }
  branchesByForkMessageId: Map<string, BranchConversationView[]>
}): {
  moveHandlerFor: (messageId: string, currentConversationId: string) => (() => void) | undefined
  moveDialog: ReactNode
} {
  const { workspaceId, conversation, branchesByForkMessageId } = params
  const [pendingMove, setPendingMove] = useState<{ messageId: string; currentConversationId: string } | null>(null)
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

  const targetsFor = useCallback(
    (currentConversationId: string): MoveTarget[] => [
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
    ],
    [conversation.id, conversation.topicSummary, branches]
  )

  // Ignore opens and picks while a move is already in flight (mirrors the
  // conversation overlay's per-message pending guard): the re-file lands on the
  // mutation response, but a rapid re-tap before it settles must not enqueue a
  // second correction.
  const moveHandlerFor = useCallback(
    (messageId: string, currentConversationId: string): (() => void) | undefined => {
      if (targetsFor(currentConversationId).length === 0) return undefined
      return () => {
        if (reassign.isPending) return
        setPendingMove({ messageId, currentConversationId })
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

  const targets = pendingMove ? targetsFor(pendingMove.currentConversationId) : []

  const moveDialog = (
    <Dialog open={pendingMove !== null} onOpenChange={(open) => !open && setPendingMove(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move to sub-topic</DialogTitle>
          <DialogDescription>
            Re-file this message into another topic of this conversation. The message stays where it was posted.
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
