import { useEffect, useState } from "react"
import { CircleCheck, EllipsisVertical, Pencil, RotateCcw } from "lucide-react"
import { ConversationStatuses, MAX_CONVERSATION_TOPIC_LENGTH } from "@threa/types"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { cn } from "@/lib/utils"
import { useUpdateConversation } from "@/hooks/use-conversations"

interface ConversationActionsMenuProps {
  workspaceId: string
  conversationId: string
  /** Current topic — prefilled into the rename dialog; null renders as empty. */
  topicSummary: string | null
  /** Current status — selects the resolve vs. reopen item. */
  status: string
  /** Extra classes for the trigger, so each surface can size it to its icon cluster. */
  triggerClassName?: string
}

/**
 * The `⋯` overflow on a board card / conversation panel: rename the topic and
 * mark the conversation resolved (or reopen it). Both edits go through
 * {@link useUpdateConversation} — optimistic, silent on success (the title/label
 * change is the confirmation, INV-63). Rename opens a {@link RenameConversationDialog}
 * rather than editing inline, so the card never shifts layout mid-edit (INV-21).
 */
export function ConversationActionsMenu({
  workspaceId,
  conversationId,
  topicSummary,
  status,
  triggerClassName,
}: ConversationActionsMenuProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const update = useUpdateConversation(workspaceId)
  const resolved = status === ConversationStatuses.RESOLVED

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8 text-muted-foreground hover:text-foreground", triggerClassName)}
            aria-label="Conversation actions"
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              // Defer the dialog until the menu has closed so Radix returns focus
              // to the trigger before the dialog claims it.
              event.preventDefault()
              setRenameOpen(true)
            }}
          >
            <Pencil className="h-4 w-4" />
            Rename topic…
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              update.mutate({
                conversationId,
                status: resolved ? ConversationStatuses.ACTIVE : ConversationStatuses.RESOLVED,
              })
            }
          >
            {resolved ? <RotateCcw className="h-4 w-4" /> : <CircleCheck className="h-4 w-4" />}
            {resolved ? "Reopen" : "Mark resolved"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameConversationDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        initialTopic={topicSummary ?? ""}
        onSave={(next) => update.mutate({ conversationId, topicSummary: next })}
      />
    </>
  )
}

interface RenameConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTopic: string
  onSave: (topic: string) => void
}

function RenameConversationDialog({ open, onOpenChange, initialTopic, onSave }: RenameConversationDialogProps) {
  const [value, setValue] = useState(initialTopic)
  // Re-seed on each open (a different card, or a re-open after cancel).
  useEffect(() => {
    if (open) setValue(initialTopic)
  }, [open, initialTopic])

  const trimmed = value.trim()
  const canSave = trimmed.length > 0 && trimmed !== initialTopic.trim()

  const save = () => {
    if (!canSave) return
    onSave(trimmed)
    onOpenChange(false)
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Rename topic</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <Input
            autoFocus
            value={value}
            maxLength={MAX_CONVERSATION_TOPIC_LENGTH}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                save()
              }
            }}
            placeholder="Topic name"
          />
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Save
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
