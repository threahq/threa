const MARK_READ_UP_TO_HERE_EVENT = "threa:mark-read-up-to-here"

interface MarkReadUpToHereDetail {
  streamId: string
  /** The stream event to advance the read pointer to (inclusive). */
  eventId: string
}

/**
 * Manually advance the read pointer to a chosen message. Dispatched from a
 * per-message action; the owning stream's `stream-content` listens and runs
 * `markAsRead`, where it alone can decide partial-vs-full (it holds the last
 * loaded event id). A row can't make that call — it doesn't know whether
 * anything sits below it (INV-15: rows stay UI-focused).
 */
export function dispatchMarkReadUpToHere(streamId: string, eventId: string): void {
  document.dispatchEvent(
    new CustomEvent<MarkReadUpToHereDetail>(MARK_READ_UP_TO_HERE_EVENT, {
      detail: { streamId, eventId },
    })
  )
}

export function addMarkReadUpToHereListener(listener: (detail: MarkReadUpToHereDetail) => void): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<MarkReadUpToHereDetail>).detail)
  }

  document.addEventListener(MARK_READ_UP_TO_HERE_EVENT, handleEvent)
  return () => document.removeEventListener(MARK_READ_UP_TO_HERE_EVENT, handleEvent)
}

const ESCAPE_UNREAD_EVENT = "threa:escape-unread"

interface EscapeUnreadDetail {
  streamId: string
}

/**
 * Touch-friendly equivalent of the desktop Escape shortcut: mark every loaded
 * message read, dismiss the unread divider, and resume tailing the live bottom.
 * Dispatched from the unread divider / jump-bar ✕; the owning stream's
 * `stream-content` listens and runs the shared escape behavior. A DOM event
 * (not prop threading) keeps the divider — rendered deep inside the virtualized
 * list — from having to carry a callback through the whole render context.
 */
export function dispatchEscapeUnread(streamId: string): void {
  document.dispatchEvent(new CustomEvent<EscapeUnreadDetail>(ESCAPE_UNREAD_EVENT, { detail: { streamId } }))
}

export function addEscapeUnreadListener(listener: (detail: EscapeUnreadDetail) => void): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<EscapeUnreadDetail>).detail)
  }

  document.addEventListener(ESCAPE_UNREAD_EVENT, handleEvent)
  return () => document.removeEventListener(ESCAPE_UNREAD_EVENT, handleEvent)
}
