import { useState } from "react"
import { Link } from "react-router-dom"
import { Archive, Bell, Check, CircleAlert, Trash2, Undo2 } from "lucide-react"
import type { SavedMessageView, SavedStatus } from "@threa/types"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { stripMarkdownToInline } from "@/lib/markdown"
import { useStreamName } from "@/hooks/use-stream-name"
import { useIsMobile } from "@/hooks/use-mobile"
import { RelativeTime } from "@/components/relative-time"
import { ReminderPopoverContent } from "@/components/timeline/reminder-popover-content"
import { ReminderPickerSheet } from "@/components/timeline/reminder-picker-sheet"
import { ReminderBadge } from "./reminder-badge"

interface SavedItemProps {
  saved: SavedMessageView
  workspaceId: string
  onMarkDone?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
}

export function SavedItem({ saved, workspaceId, onMarkDone, onArchive, onRestore, onDelete }: SavedItemProps) {
  const isUnavailable = saved.unavailableReason !== null
  const linkable = !isUnavailable && saved.message !== null
  const href = `/w/${workspaceId}/s/${saved.streamId}?m=${saved.messageId}`
  const previewText = resolvePreview(saved)
  // The backend snapshot's `streamName` is null for DMs (viewer-specific names
  // aren't persisted on the stream row), so resolve from the workspace caches.
  // The persisted snapshot is the last-resort fallback for rows whose stream
  // is no longer cached (lost access).
  const streamLabel = useStreamName(workspaceId, saved.streamId) ?? saved.message?.streamName ?? "Unknown"

  // Row-as-link: the content area navigates to the message when clicked.
  // Action buttons are siblings (not nested inside the Link) so their clicks
  // don't bubble into navigation.
  const Content = (
    <>
      <div className="flex items-baseline gap-1.5 text-sm">
        <span className="text-muted-foreground">Saved from</span>
        <span className="font-medium truncate">{streamLabel}</span>
        {isUnavailable && (
          <span
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide bg-muted text-muted-foreground"
            title={saved.unavailableReason === "deleted" ? "Original message was deleted" : "Access lost"}
          >
            <CircleAlert className="h-3 w-3" />
            {saved.unavailableReason === "deleted" ? "deleted" : "no access"}
          </span>
        )}
      </div>

      <p className={cn("mt-0.5 text-xs text-muted-foreground truncate", isUnavailable && "italic")}>{previewText}</p>

      <div className="mt-1 flex items-center gap-3">
        <RelativeTime
          date={saved.status === "saved" ? saved.savedAt : saved.statusChangedAt}
          className="text-xs text-muted-foreground/60"
        />
        <ReminderBadge remindAt={saved.remindAt} reminderSentAt={saved.reminderSentAt} />
      </div>
    </>
  )

  return (
    <div
      className={cn(
        "group flex items-start gap-3 px-4 py-3 hover:bg-muted/40 border-b border-border/50",
        isUnavailable && "opacity-75"
      )}
    >
      {linkable ? (
        <Link to={href} className="flex-1 min-w-0">
          {Content}
        </Link>
      ) : (
        <div className="flex-1 min-w-0" aria-disabled>
          {Content}
        </div>
      )}

      <SavedRowActions
        workspaceId={workspaceId}
        saved={saved}
        onMarkDone={onMarkDone}
        onArchive={onArchive}
        onRestore={onRestore}
        onDelete={onDelete}
      />
    </div>
  )
}

interface SavedRowActionsProps {
  workspaceId: string
  saved: SavedMessageView
  onMarkDone?: () => void
  onArchive?: () => void
  onRestore?: () => void
  onDelete?: () => void
}

/**
 * Actions are always visible on mobile (no hover affordance) and hover-reveal
 * on desktop. Reminder changes are routed through the shared
 * `ReminderPopoverContent` so behaviour matches the message-level bookmark
 * button.
 */
function SavedRowActions({ workspaceId, saved, onMarkDone, onArchive, onRestore, onDelete }: SavedRowActionsProps) {
  const status = saved.status as SavedStatus
  const isMobile = useIsMobile()
  const [sheetOpen, setSheetOpen] = useState(false)

  return (
    <div
      className={cn(
        // Mobile: always visible. Desktop: hover-reveal. `has-[[data-state=open]]` keeps
        // the bar visible while the reminder popover is open so it doesn't disappear
        // out from under the user's pointer.
        "flex items-center gap-1 shrink-0",
        "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 sm:transition-opacity",
        "has-[[data-state=open]]:opacity-100"
      )}
    >
      {status === "saved" &&
        // Mobile gets the same bottom-sheet picker as the message-level "Set
        // reminder" flow; desktop keeps the hover/click popover. Either way
        // the underlying mutation hooks and presets are shared.
        (isMobile ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              title="Set reminder"
              onClick={() => setSheetOpen(true)}
            >
              <Bell className="h-3.5 w-3.5" />
            </Button>
            <ReminderPickerSheet
              open={sheetOpen}
              onOpenChange={setSheetOpen}
              workspaceId={workspaceId}
              messageId={saved.messageId}
              saved={saved}
            />
          </>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" title="Set reminder">
                <Bell className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <ReminderPopoverContent workspaceId={workspaceId} messageId={saved.messageId} saved={saved} />
            </PopoverContent>
          </Popover>
        ))}
      {status === "saved" && onMarkDone && (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onMarkDone} title="Mark done">
          <Check className="h-3.5 w-3.5" />
        </Button>
      )}
      {status === "saved" && onArchive && (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onArchive} title="Archive">
          <Archive className="h-3.5 w-3.5" />
        </Button>
      )}
      {status !== "saved" && onRestore && (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onRestore} title="Restore to saved">
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          title="Remove saved item"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  )
}

function resolvePreview(saved: SavedMessageView): string {
  if (saved.message) return stripMarkdownToInline(saved.message.contentMarkdown)
  if (saved.unavailableReason === "deleted") return "Original message was deleted"
  return "You no longer have access to this message"
}
