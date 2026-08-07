import { Layers, X } from "lucide-react"

const CONVERSATION_REPLY_STRIP_CLASS_NAME =
  "mb-1.5 flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-xs text-muted-foreground"

interface ConversationReplyStripProps {
  /** The sub-conversation the armed composer files into (its topic summary). */
  title: string
  /** Optional disarm action for surfaces that support moving the draft back to their root scope. */
  onCancel?: () => void
}

/**
 * "Replying in <topic>" strip shown above a composer armed to a
 * sub-conversation. Shared by the timeline and board conversation panel so the
 * filing signal cannot drift between surfaces.
 */
export function ConversationReplyStrip({ title, onCancel }: ConversationReplyStripProps) {
  return (
    <div data-testid="conversation-reply-strip" className={CONVERSATION_REPLY_STRIP_CLASS_NAME}>
      <Layers className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        Replying in <span className="font-medium">{title}</span>
      </span>
      {onCancel ? (
        <button
          type="button"
          aria-label="Cancel reply in conversation"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
          className="ml-auto shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  )
}
