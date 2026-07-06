const START_BATCH_SELECT_EVENT = "threa:start-batch-select"

/**
 * What the batch selection is for:
 * - `moveToThread` — the default: physically relocate the selected messages into
 *   a thread (drag the selection onto a target message, confirm).
 * - `splitConversation` — reassign the selected messages' conversation membership
 *   to another conversation or a freshly minted one. Only meaningful while the
 *   conversation overlay is on; tap to select, then pick a target.
 */
export type BatchSelectIntent = "moveToThread" | "splitConversation"

interface BatchSelectEventDetail {
  streamId: string
  intent: BatchSelectIntent
  /**
   * When the flow is launched from a per-message context menu, the single
   * message acts as the initial selection so the user can either confirm
   * immediately or extend the selection. Absent for the stream-level entry,
   * which starts with nothing selected.
   */
  preselectedMessageId?: string
}

export function dispatchStartBatchSelect(
  streamId: string,
  intent: BatchSelectIntent,
  preselectedMessageId?: string
): void {
  document.dispatchEvent(
    new CustomEvent<BatchSelectEventDetail>(START_BATCH_SELECT_EVENT, {
      detail: { streamId, intent, preselectedMessageId },
    })
  )
}

export function addStartBatchSelectListener(listener: (detail: BatchSelectEventDetail) => void): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<BatchSelectEventDetail>).detail)
  }

  document.addEventListener(START_BATCH_SELECT_EVENT, handleEvent)
  return () => document.removeEventListener(START_BATCH_SELECT_EVENT, handleEvent)
}
