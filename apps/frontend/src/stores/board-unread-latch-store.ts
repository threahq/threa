import type {
  UnreadMarkerLatch,
  UnreadMarkerLatchStorage,
} from "@/components/conversations/use-conversation-unread-marker"

// Where a board card's "New" divider decision lives. virtua unmounts cards past
// its scroll buffer, so a component-local latch re-decides on remount against
// read state auto-read has since cleared — the divider vanishes mid-session.
// Board-scoped and keyed by conversation id, it survives that remount; the
// conversation panel keeps its own per-open ref and is unaffected.

const latches = new Map<string, UnreadMarkerLatch>()

export const boardUnreadLatchStorage: UnreadMarkerLatchStorage = {
  get(conversationId) {
    return latches.get(conversationId)
  },
  set(conversationId, latch) {
    latches.set(conversationId, latch)
  },
}

/** A fresh board visit (or workspace switch) is a fresh open: drop every latch. */
export function resetBoardUnreadLatches(): void {
  latches.clear()
}
