/**
 * The banner a composer surface renders in place of its editor when writing is
 * closed (archived stream/root, system stream). Shared so the timeline and the
 * conversation surfaces can't drift in copy or shape; each caller keeps its own
 * shell (floating, docked, in-card).
 */
export const CONVERSATION_ARCHIVED_REASON = "This conversation has been archived. It can be read but not extended."
export const CONVERSATION_ROOT_ARCHIVED_REASON =
  "The stream this conversation belongs to has been archived. It can be read but not extended."

/** Read-only copy for a conversation surface, by where the archive lives. */
export function conversationArchivedReason(archived: {
  ownArchived: boolean
  rootArchived: boolean
}): string | undefined {
  if (archived.ownArchived) return CONVERSATION_ARCHIVED_REASON
  if (archived.rootArchived) return CONVERSATION_ROOT_ARCHIVED_REASON
  return undefined
}

export function ComposerDisabledNotice({ reason }: { reason: string }) {
  return (
    <div className="flex items-center justify-center py-3 px-4 rounded-md bg-muted/50">
      <p className="text-sm text-muted-foreground text-center">{reason}</p>
    </div>
  )
}
