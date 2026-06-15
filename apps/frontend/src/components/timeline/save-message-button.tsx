import { useMemo } from "react"
import { Bookmark, BookmarkCheck, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"
import { useSavedForMessage, useSaveMessage, useUpdateSaved, useDeleteSaved } from "@/hooks/use-saved"
import { ReminderPopoverContent } from "./reminder-popover-content"

interface SaveMessageButtonProps {
  workspaceId: string
  messageId: string
}

/**
 * Hover-revealed bookmark button. Click toggles saved/unsaved immediately;
 * hovering opens a popover with reminder controls and status transitions
 * (matches the spec: "pressing the bookmark saves, hovering shows the
 * popover").
 */
export function SaveMessageButton({ workspaceId, messageId }: SaveMessageButtonProps) {
  const saved = useSavedForMessage(workspaceId, messageId)
  const saveMutation = useSaveMessage(workspaceId)
  const updateMutation = useUpdateSaved(workspaceId)
  const deleteMutation = useDeleteSaved(workspaceId)

  const isSaved = !!saved && saved.status === "saved"
  const isPending = saveMutation.isPending || updateMutation.isPending || deleteMutation.isPending

  const Icon = useMemo(() => {
    if (isPending) return Loader2
    if (isSaved) return BookmarkCheck
    return Bookmark
  }, [isPending, isSaved])

  const handleToggle = () => {
    if (isPending) return
    if (!saved) {
      saveMutation.mutate(
        { messageId },
        {
          onError: () => toast.error("Could not save message"),
        }
      )
      return
    }
    if (saved.status !== "saved") {
      // Re-saving a done/archived item brings it back to the Saved tab per spec.
      saveMutation.mutate(
        { messageId },
        {
          onError: () => toast.error("Could not restore saved item"),
        }
      )
      return
    }
    deleteMutation.mutate(saved.id, {
      onError: () => toast.error("Could not remove saved item"),
    })
  }

  return (
    <HoverCard openDelay={200} closeDelay={120}>
      <HoverCardTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn(
            "h-6 w-6 shadow-sm shrink-0",
            isSaved && "border-primary/30 bg-primary/5 text-primary",
            !isSaved && "hover:border-primary/30 text-muted-foreground"
          )}
          aria-label={isSaved ? "Saved" : "Save for later"}
          aria-pressed={isSaved}
          onClick={handleToggle}
        >
          <Icon className={cn("h-3.5 w-3.5", isPending && "animate-spin")} />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 p-0">
        <ReminderPopoverContent workspaceId={workspaceId} messageId={messageId} saved={saved ?? null} />
      </HoverCardContent>
    </HoverCard>
  )
}
