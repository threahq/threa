import { useEffect, useRef, useState } from "react"
import { CircleCheck, Eye, EyeOff, EllipsisVertical, Pencil, RotateCcw, Sparkles } from "lucide-react"
import { ConversationStatuses, MAX_CONVERSATION_TOPIC_LENGTH } from "@threa/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { useUpdateConversation, useHideConversation, useUnhideConversation } from "@/hooks/use-conversations"
import { ConversationSplitDialog } from "./conversation-split-dialog"

interface ConversationActionsMenuProps {
  workspaceId: string
  conversationId: string
  /** The conversation's stream — the anchor for the AI-split mint. Omit to hide
   *  the "Split with AI" item (surfaces without a resolved stream id). */
  streamId?: string
  /** Current topic — prefilled into the rename dialog; null renders as empty. */
  topicSummary: string | null
  /** Current status — selects the resolve vs. reopen item. */
  status: string
  /** Whether this conversation is currently hidden from the viewer's board —
   *  selects "Unhide" vs "Hide from board". */
  isHidden?: boolean
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
  streamId,
  topicSummary,
  status,
  isHidden = false,
  triggerClassName,
}: ConversationActionsMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [splitOpen, setSplitOpen] = useState(false)
  const update = useUpdateConversation(workspaceId)
  const hide = useHideConversation(workspaceId)
  const unhide = useUnhideConversation(workspaceId)
  const resolved = status === ConversationStatuses.RESOLVED

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
              // Close the menu explicitly and open the dialog. `preventDefault`
              // stops Radix's own select-close (which returns focus to the
              // trigger and can race the dialog); we drive the close via state so
              // the menu can't linger open behind a dialog that doesn't steal focus.
              event.preventDefault()
              setMenuOpen(false)
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
          {streamId && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                setMenuOpen(false)
                setSplitOpen(true)
              }}
            >
              <Sparkles className="h-4 w-4" />
              Split with AI…
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => (isHidden ? unhide.mutate(conversationId) : hide.mutate(conversationId))}>
            {isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            {isHidden ? "Unhide from board" : "Hide from board"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameConversationDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        initialTopic={topicSummary ?? ""}
        onSave={(next) => update.mutate({ conversationId, topicSummary: next })}
      />
      {streamId && (
        <ConversationSplitDialog
          workspaceId={workspaceId}
          streamId={streamId}
          conversationId={splitOpen ? conversationId : null}
          open={splitOpen}
          onOpenChange={setSplitOpen}
        />
      )}
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
  // Re-seed only on an open transition (a different card, or a re-open after
  // cancel) — NOT whenever `initialTopic` changes, so a concurrent rename landing
  // via the live query while you're typing doesn't wipe your in-progress input.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) setValue(initialTopic)
    wasOpen.current = open
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
