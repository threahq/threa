import { Link } from "react-router-dom"
import { Check, Sparkles, X } from "lucide-react"
import type { SavedSuggestionView } from "@threahq/types"
import { Button } from "@/components/ui/button"
import { useStreamName } from "@/hooks/use-stream-name"
import { RelativeTime } from "@/components/relative-time"

interface SavedSuggestionItemProps {
  suggestion: SavedSuggestionView
  workspaceId: string
  onAccept: () => void
  onDismiss: () => void
  pending?: boolean
}

/**
 * A passively-collected to-do candidate. Accept turns it into a saved item;
 * Dismiss removes it (and teaches the collector). The eyebrow links to the
 * source conversation so the suggestion is verifiable, never a black box.
 */
export function SavedSuggestionItem({
  suggestion,
  workspaceId,
  onAccept,
  onDismiss,
  pending,
}: SavedSuggestionItemProps) {
  const streamLabel = useStreamName(workspaceId, suggestion.streamId) ?? "a conversation"
  const sourceHref =
    suggestion.sourceMessageIds.length > 0
      ? `/w/${workspaceId}/s/${suggestion.streamId}?m=${suggestion.sourceMessageIds[0]}`
      : `/w/${workspaceId}/s/${suggestion.streamId}`

  return (
    <div className="group reveal-host flex items-start gap-3 px-4 py-3 hover:bg-muted/40 border-b border-border/50">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-amber-500/10 text-amber-500">
        <Sparkles className="h-4 w-4" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5 text-sm">
          <span className="font-medium truncate">{suggestion.title}</span>
        </div>

        {suggestion.context && (
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{suggestion.context}</p>
        )}

        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground/60">
          <span className="inline-flex items-baseline gap-1">
            Suggested from
            <Link to={sourceHref} className="font-medium text-muted-foreground hover:underline">
              {streamLabel}
            </Link>
          </span>
          <span aria-hidden>·</span>
          <RelativeTime date={suggestion.createdAt} />
          {suggestion.dueAt && (
            <>
              <span aria-hidden>·</span>
              <span className="text-amber-600/80">
                due <RelativeTime date={suggestion.dueAt} />
              </span>
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 reveal-actions">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={onAccept}
          disabled={pending}
          title="Add to Saved"
        >
          <Check className="h-3.5 w-3.5" />
          Add
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onDismiss}
          disabled={pending}
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
