import { useEffect, useState } from "react"
import { Loader2, ListTodo, StickyNote } from "lucide-react"
import { toast } from "sonner"
import type { SavedMessageView } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { cn } from "@/lib/utils"
import { useUpdateSaved } from "@/hooks/use-saved"
import { useActors } from "@/hooks/use-actors"
import { useStreamName } from "@/hooks/use-stream-name"
import { RelativeTime } from "@/components/relative-time"
import { resolveSavedPreview } from "./saved-item"

const TITLE_MAX = 300
const NOTE_MAX = 4000

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
  const HeaderIcon = isStandalone ? ListTodo : StickyNote

  const handleSave = () => {
    if (!canSave || updateMutation.isPending) return
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
          onOpenChange(false)
        },
        onError: () => toast.error("Could not update saved item"),
      }
    )
  }

  return (
    // disableSnapPoints: the snap-point drawer is forced to h-[100dvh], so the
    // on-screen keyboard pushes the header and first field off-screen. A
    // content-height, bottom-anchored drawer rides above the keyboard instead.
    <ResponsiveDialog open={open} onOpenChange={onOpenChange} disableSnapPoints>
      <ResponsiveDialogContent
        desktopClassName="max-w-[480px] gap-0 p-0 overflow-hidden"
        drawerClassName="flex max-h-[92dvh] flex-col gap-0 p-0 overflow-hidden"
        aria-describedby={undefined}
      >
        <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-4">
          <ResponsiveDialogHeader>
            <div className="flex items-center gap-2.5">
              <div className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10">
                <HeaderIcon className="h-4.5 w-4.5 text-primary" />
              </div>
              <div>
                <ResponsiveDialogTitle className="text-base">
                  {isStandalone ? "Edit to-do" : "Edit note"}
                </ResponsiveDialogTitle>
                <ResponsiveDialogDescription className="text-xs mt-0.5">
                  {isStandalone
                    ? "Rename the to-do or add the context you'll need later"
                    : "Capture why you saved this — future-you will thank you"}
                </ResponsiveDialogDescription>
              </div>
            </div>
          </ResponsiveDialogHeader>
        </div>

        <div className="border-t border-border" />

        {/* Scrollable so a shrunken visual viewport (keyboard) can never trap
            fields off-screen — the body scrolls within whatever height the
            drawer has left. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
          {!isStandalone && <SourceMessagePreview workspaceId={workspaceId} saved={saved} />}
          {isStandalone && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="saved-edit-title" className="text-sm font-medium">
                  Title
                </Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {title.length}/{TITLE_MAX}
                </span>
              </div>
              <Input
                id="saved-edit-title"
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
                placeholder="What needs doing?"
                className="text-sm"
              />
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="saved-edit-note" className="text-sm font-medium">
                Note
              </Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {note.length}/{NOTE_MAX}
              </span>
            </div>
            <Textarea
              id="saved-edit-note"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
              placeholder="Why this matters, links, details…"
              rows={4}
              className="resize-none text-sm"
            />
          </div>
        </div>

        {/* pb-[max(...)] keeps the buttons above the home indicator on mobile;
            resolves to the same 16px as py-4 on desktop. */}
        <div className="border-t border-border px-4 sm:px-6 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] flex items-center justify-end gap-2 bg-muted/30">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!canSave || updateMutation.isPending} className="min-w-20">
            {updateMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

interface SourceMessagePreviewProps {
  workspaceId: string
  saved: SavedMessageView
}

/**
 * Quoted preview of the message this saved item is anchored to, so the note
 * is written with its subject in view. Read-only context — the row itself is
 * the navigation surface. Preview text goes through `resolveSavedPreview`
 * (markdown stripped per INV-60; deleted/access-lost/encrypted fallbacks
 * shared with the saved row).
 */
function SourceMessagePreview({ workspaceId, saved }: SourceMessagePreviewProps) {
  const { getActorName } = useActors(workspaceId)
  const streamLabel = useStreamName(workspaceId, saved.streamId ?? "") ?? saved.message?.streamName ?? "Unknown"
  const isUnavailable = saved.unavailableReason !== null
  const authorName = saved.message ? getActorName(saved.message.authorId, saved.message.authorType) : null

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 border-l-2 border-l-primary/40">
      <div className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
        {authorName && <span className="font-medium text-foreground/80">{authorName}</span>}
        <span className="truncate">in {streamLabel}</span>
        {saved.message && <RelativeTime date={saved.message.createdAt} className="shrink-0 text-muted-foreground/60" />}
      </div>
      <p
        className={cn("mt-1 text-sm text-foreground/80 line-clamp-3", isUnavailable && "italic text-muted-foreground")}
      >
        {resolveSavedPreview(saved)}
      </p>
    </div>
  )
}
