import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { SavedMessageView } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { useUpdateSaved } from "@/hooks/use-saved"

interface SavedEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  saved: SavedMessageView
}

/**
 * Edit a saved item's own text: title (standalone items only — message-
 * anchored rows display the live message instead) and note (both variants).
 * Title and note save together as one content PATCH, so the row updates in a
 * single socket event.
 */
export function SavedEditDialog({ open, onOpenChange, workspaceId, saved }: SavedEditDialogProps) {
  const isStandalone = saved.messageId === null
  const updateMutation = useUpdateSaved(workspaceId)
  const [title, setTitle] = useState(saved.title ?? "")
  const [note, setNote] = useState(saved.note ?? "")

  // Re-seed from the row each time the dialog opens so stale edits from a
  // previously cancelled session don't leak in.
  useEffect(() => {
    if (open) {
      setTitle(saved.title ?? "")
      setNote(saved.note ?? "")
    }
  }, [open, saved.title, saved.note])

  const trimmedTitle = title.trim()
  const canSave = !isStandalone || trimmedTitle.length > 0

  const handleSave = () => {
    if (!canSave) return
    updateMutation.mutate(
      {
        savedId: saved.id,
        input: {
          ...(isStandalone && trimmedTitle !== (saved.title ?? "") ? { title: trimmedTitle } : {}),
          note: note.trim() === "" ? null : note.trim(),
        },
      },
      {
        onSuccess: () => {
          toast.success("Saved item updated")
          onOpenChange(false)
        },
        onError: () => toast.error("Could not update saved item"),
      }
    )
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent desktopClassName="max-w-md" aria-describedby={undefined}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{isStandalone ? "Edit to-do" : "Edit note"}</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="flex flex-col gap-3">
          {isStandalone && (
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              maxLength={300}
              aria-label="Title"
            />
          )}
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add context — why this matters, links, details…"
            maxLength={4000}
            rows={4}
            aria-label="Note"
          />
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || updateMutation.isPending}>
            Save
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
