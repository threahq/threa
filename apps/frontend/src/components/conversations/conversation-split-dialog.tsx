import { useEffect, type ReactNode } from "react"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@/components/ui/responsive-dialog"
import { useProposeSplit, useApplySplit } from "@/hooks/use-conversations"

/**
 * "Split with AI": ask the clustering model how a conversation should be broken
 * into smaller topics, show the proposed groups, and apply them on confirmation.
 * Read-only until the user confirms — {@link useProposeSplit} writes nothing; the
 * confirm calls {@link useApplySplit}, which keeps the first (largest) group in
 * this conversation and mints the rest. Success is silent (INV-63): the overlay
 * and board recolor from the mutation's cache write, so the dialog just closes.
 */
export function ConversationSplitDialog({
  workspaceId,
  streamId,
  conversationId,
  open,
  onOpenChange,
}: {
  workspaceId: string
  streamId: string
  conversationId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const propose = useProposeSplit(workspaceId)
  const apply = useApplySplit(workspaceId, streamId)
  const { mutate: mutatePropose, reset: resetPropose } = propose
  const { reset: resetApply } = apply

  // Fetch a fresh proposal each time the dialog opens for a conversation; clear
  // both mutations when it closes so a reopen never flashes the prior result.
  useEffect(() => {
    if (open && conversationId) {
      mutatePropose(conversationId)
    } else if (!open) {
      resetPropose()
      resetApply()
    }
  }, [open, conversationId, mutatePropose, resetPropose, resetApply])

  const proposal = propose.data
  const canSplit = !!proposal && proposal.groups.length >= 2

  // Don't let Escape / backdrop / the close button dismiss the dialog while the
  // split is being written — success is silent (INV-63), so a mid-apply dismissal
  // would leave the user with no correlation between their action and the board
  // rearranging. The confirm's own onSuccess closes it directly once settled.
  const handleOpenChange = (next: boolean) => {
    if (!next && apply.isPending) return
    onOpenChange(next)
  }

  const onConfirm = () => {
    if (!proposal || !conversationId || !canSplit) return
    apply.mutate(
      {
        conversationId,
        groups: proposal.groups.map((g) => ({
          title: g.title,
          summary: g.summary ?? undefined,
          messageIds: g.messageIds,
        })),
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: () => toast.error("Couldn't split the conversation"),
      }
    )
  }

  let body: ReactNode
  if (propose.isPending) {
    body = (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Analyzing the conversation…
      </div>
    )
  } else if (propose.isError) {
    body = (
      <div className="flex flex-col items-start gap-3 py-6 text-sm">
        <p className="text-muted-foreground">Couldn&apos;t analyze this conversation.</p>
        <Button variant="outline" size="sm" onClick={() => conversationId && mutatePropose(conversationId)}>
          Try again
        </Button>
      </div>
    )
  } else if (!canSplit) {
    body = <p className="py-8 text-sm text-muted-foreground">This conversation looks focused — no split suggested.</p>
  } else {
    body = (
      <div className="flex flex-col gap-2 py-1">
        <p className="text-xs text-muted-foreground">
          The first group stays in this conversation — it takes on that title. The rest become new conversations.
        </p>
        <ul className="flex flex-col gap-2">
          {proposal!.groups.map((group, index) => (
            <li key={index} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{group.title}</span>
                <span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                  {index === 0 ? "This conversation" : "New conversation"}
                </span>
              </div>
              {group.summary ? (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{group.summary}</p>
              ) : null}
              <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                {group.messageIds.length} {group.messageIds.length === 1 ? "message" : "messages"}
              </p>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange} disableSnapPoints>
      <ResponsiveDialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg" desktopClassName="pt-6">
        <ResponsiveDialogHeader className="px-4 pb-3 sm:px-6">
          <ResponsiveDialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
            Split with AI
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Let the model regroup this conversation into smaller topics. Nothing changes until you confirm.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="min-h-24 py-2">{body}</ResponsiveDialogBody>

        <ResponsiveDialogFooter className="gap-2 px-4 pb-4 pt-3 sm:px-6">
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={apply.isPending}>
            {canSplit ? "Cancel" : "Close"}
          </Button>
          {canSplit ? (
            <Button onClick={onConfirm} disabled={apply.isPending}>
              {apply.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> : null}
              Split into {proposal!.groups.length} conversations
            </Button>
          ) : null}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
