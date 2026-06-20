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
