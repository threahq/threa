import { Link } from "react-router-dom"
import { X } from "lucide-react"
import type { StreamEvent, MessagesMovedEventPayload, MovedMessagePreview } from "@threahq/types"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogClose,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog"
import { ActorAvatar } from "@/components/actor-avatar"
import { RelativeTime } from "@/components/relative-time"
import { useActors, type ActorLookup } from "@/hooks"
import { stripMarkdownToInline } from "@/lib/markdown/strip"

interface MovedMessagesDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The `messages:moved` tombstone backing this drawer. */
  event: StreamEvent
  workspaceId: string
}

function formatStreamName(displayName: string | null, slug: string | null, fallback: string): string {
  if (displayName) return displayName
  if (slug) return `#${slug}`
  return fallback
}

/**
 * Drill-in drawer for a `messages:moved` event. Used from two surfaces:
 *
 * - **Source-stream tombstone** — clicking the inline "Actor moved N
 *   messages" row opens this drawer with the source-side tombstone.
 * - **Destination per-message indicator + context menu** — the
 *   destination doesn't render an inline tombstone, so each moved
 *   message exposes both a hover-clickable origin badge and a
 *   "Show move details" menu entry that open this drawer with the
 *   destination tombstone (looked up by `movedFrom.moveTombstoneId`).
 *
 * Both callers mount conditionally (`{open && <Drawer .../>}`) so the
 * internal `useActors` subscription only runs when the drawer is
 * actually visible.
 */
export function MovedMessagesDrawer({ open, onOpenChange, event, workspaceId }: MovedMessagesDrawerProps) {
  const actors = useActors(workspaceId)
  const payload = event.payload as MessagesMovedEventPayload
  const moverName = actors.getActorName(event.actorId, event.actorType)
  // Source can be any stream type; destination is always a thread (the
  // move flow only creates child threads). Fallbacks reflect that.
  const sourceLabel = formatStreamName(payload.sourceStreamDisplayName, payload.sourceStreamSlug, "Untitled stream")
  const destinationLabel = formatStreamName(
    payload.destinationStreamDisplayName,
    payload.destinationStreamSlug,
    "Untitled thread"
  )
  const count = payload.messages.length
  const noun = count === 1 ? "message" : "messages"

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        desktopClassName="max-w-2xl max-h-[85vh] sm:flex flex-col p-0 gap-0 [&>button:last-child]:hidden"
        drawerClassName="flex flex-col p-0"
        hideCloseButton
      >
        <div className="px-4 sm:px-6 py-4 border-b shrink-0 flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <ResponsiveDialogTitle className="text-base font-semibold flex items-center gap-2">
              <ActorAvatar
                actorId={event.actorId}
                actorType={event.actorType}
                workspaceId={workspaceId}
                size="sm"
                alt={moverName}
                className="shrink-0"
              />
              <span className="truncate">
                {moverName} moved {count} {noun}
              </span>
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription className="mt-1 text-xs text-muted-foreground inline-flex items-center gap-1.5 flex-wrap">
              <RelativeTime date={event.createdAt} className="text-xs text-muted-foreground" />
              <span aria-hidden="true">•</span>
              <Link
                to={`/w/${workspaceId}/s/${payload.sourceStreamId}`}
                className="font-medium text-foreground hover:underline underline-offset-2"
              >
                {sourceLabel}
              </Link>
              <span aria-hidden="true">→</span>
              <Link
                to={`/w/${workspaceId}/s/${payload.destinationStreamId}`}
                className="font-medium text-foreground hover:underline underline-offset-2"
              >
                {destinationLabel}
              </Link>
            </ResponsiveDialogDescription>
          </div>
          <ResponsiveDialogClose className="w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0">
            <X className="w-5 h-5" />
            <span className="sr-only">Close</span>
          </ResponsiveDialogClose>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 sm:px-3 py-2">
          <ul className="flex flex-col gap-1">
            {payload.messages.map((message) => (
              <MovedMessageRow
                key={message.id}
                message={message}
                workspaceId={workspaceId}
                destinationStreamId={payload.destinationStreamId}
                actors={actors}
                onNavigate={() => onOpenChange(false)}
              />
            ))}
          </ul>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

interface MovedMessageRowProps {
  message: MovedMessagePreview
  workspaceId: string
  destinationStreamId: string
  actors: ActorLookup
  onNavigate: () => void
}

function MovedMessageRow({ message, workspaceId, destinationStreamId, actors, onNavigate }: MovedMessageRowProps) {
  const authorName = actors.getActorName(message.authorId, message.authorType)
  // Preview field is markdown by design — INV-60 carve-out for preview
  // surfaces. Strip + truncate at render so display stays plain text.
  const stripped = stripMarkdownToInline(message.contentMarkdown).trim()
  const hasContent = stripped.length > 0

  return (
    <li>
      <Link
        to={`/w/${workspaceId}/s/${destinationStreamId}?m=${message.id}`}
        onClick={onNavigate}
        className="block px-3 py-2 rounded-md hover:bg-muted/60 transition-colors group"
      >
        <div className="flex items-start gap-3 min-w-0">
          <ActorAvatar
            actorId={message.authorId}
            actorType={message.authorType}
            workspaceId={workspaceId}
            size="sm"
            alt={authorName}
            className="shrink-0 mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-medium text-sm truncate">{authorName}</span>
              <RelativeTime date={message.createdAt} className="text-xs text-muted-foreground shrink-0" />
            </div>
            {hasContent ? (
              <p className="text-sm text-muted-foreground line-clamp-2 group-hover:text-foreground transition-colors">
                {stripped}
              </p>
            ) : (
              <p className="text-sm italic text-muted-foreground/70">no text content</p>
            )}
          </div>
        </div>
      </Link>
    </li>
  )
}
