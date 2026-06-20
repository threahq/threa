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

const MARK_UNREAD_EVENT = "threa:mark-unread"

interface MarkUnreadDetail {
  streamId: string
  /** The message to mark unread — it and everything after it become unread. */
  messageId: string
}

/**
 * Move the read pointer back so the chosen message (and everything after it) is
 * unread. Dispatched from a per-message action; the owning stream's
 * `stream-content` listens and runs `markUnread`, keeping a single
 * `useUnreadCounts` per stream instead of one per row.
 */
export function dispatchMarkUnread(streamId: string, messageId: string): void {
  document.dispatchEvent(new CustomEvent<MarkUnreadDetail>(MARK_UNREAD_EVENT, { detail: { streamId, messageId } }))
}

export function addMarkUnreadListener(listener: (detail: MarkUnreadDetail) => void): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<MarkUnreadDetail>).detail)
  }

  document.addEventListener(MARK_UNREAD_EVENT, handleEvent)
  return () => document.removeEventListener(MARK_UNREAD_EVENT, handleEvent)
}
