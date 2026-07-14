import { Layers, X } from "lucide-react"

interface ConversationReplyStripProps {
  /** The sub-conversation the armed composer files into (its topic summary). */
  title: string
  /** Disarm — the timeline nulls in-memory state; the panel flushes + rescopes the draft to root. */
  onCancel: () => void
}

/**
 * Dismissible "Replying in <topic>" strip shown above a composer armed to a
 * sub-conversation. The send's only signal that it files into a conversation, so
 * it renders wherever the composer does. Shared by the timeline (`MessageInput`)
 * and the board conversation panel (`InlineComposerForm`) so the two can't drift.
 */
export function ConversationReplyStrip({ title, onCancel }: ConversationReplyStripProps) {
  return (
    <div
      data-testid="conversation-reply-strip"
      className="mb-1.5 flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-1 text-xs text-muted-foreground"
    >
      <Layers className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        Replying in <span className="font-medium">{title}</span>
      </span>
      <button
        type="button"
        aria-label="Cancel reply in conversation"
        onClick={onCancel}
        className="ml-auto shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
