import type { MessagesMovedEventPayload } from "@threa/types"

/**
 * Read-side contiguity over the viewer-visible broadcast chain (INV-61).
 *
 * Every stream member receives the broadcast timeline events (messages,
 * membership, agent sessions, move tombstones) with a dense per-stream
 * `broadcastSequence`. Because the chain is dense for every viewer, a missing
 * number inside the rendered window is ALWAYS a real gap — never another
 * user's author-scoped command event (those don't consume broadcast slots).
 *
 * The one legitimate way slots disappear is the message-move flow, which
 * relocates rows to a destination thread. The move's source-side tombstone
 * declares the vacated slots in its payload (`vacatedBroadcastSequences`),
 * and the tombstone's own broadcastSequence is always above every slot it
 * declares — so any window that can see the hole also contains the
 * declaration.
 *
 * This module is pure; `useEvents` renders detected holes as in-place
 * loading placeholders and asks the SyncEngine for a scoped backfill, so a
 * missed message resolves a visible placeholder where it belongs instead of
 * popping in above rows that are already on screen.
 */

/** Minimal shape the hole scan needs — satisfied by StreamEvent and CachedEvent. */
export interface ContiguityCheckEvent {
  id: string
  sequence: string
  broadcastSequence?: string | null
  eventType: string
  payload: unknown
  _status?: string | null
}

export interface TimelineHole {
  /** Event id of the row immediately below the hole — the placeholder renders right after it. */
  afterEventId: string
  /** Global sequence of that row — the `bootstrap?after=` cursor that closes the hole. */
  afterSequence: string
  /** Missing broadcast slots in the hole, net of declared vacated slots. */
  missingCount: number
}

function collectVacatedBroadcastSlots(events: ContiguityCheckEvent[]): Set<number> {
  const vacated = new Set<number>()
  for (const event of events) {
    if (event.eventType !== "messages:moved") continue
    const declared = (event.payload as Partial<MessagesMovedEventPayload> | undefined)?.vacatedBroadcastSequences
    if (!Array.isArray(declared)) continue
    for (const slot of declared) {
      const num = Number(slot)
      if (Number.isFinite(num)) vacated.add(num)
    }
  }
  return vacated
}

/**
 * Detect holes in the broadcast chain of a rendered timeline window.
 *
 * `events` must be in render order (ascending global sequence — the order
 * `useEvents` produces). Pending/failed optimistic rows and rows without a
 * `broadcastSequence` (non-broadcast types, pre-deploy cached rows) don't
 * participate in the chain; they can never create a phantom hole, only
 * reduce coverage. Contiguity is asserted strictly *between* adjacent chain
 * rows — history below the window floor is the server's (already
 * contiguous) pagination responses, and the area above the newest row is
 * covered by the write-path tail-gap check in stream-sync.
 */
export function computeTimelineHoles(events: ContiguityCheckEvent[]): TimelineHole[] {
  const chain: ContiguityCheckEvent[] = []
  for (const event of events) {
    if (event._status === "pending" || event._status === "failed") continue
    if (event.broadcastSequence == null) continue
    chain.push(event)
  }
  if (chain.length < 2) return []

  const vacated = collectVacatedBroadcastSlots(events)
  const holes: TimelineHole[] = []

  for (let i = 1; i < chain.length; i++) {
    const previous = chain[i - 1]
    const current = chain[i]
    const previousSlot = Number(previous.broadcastSequence)
    const currentSlot = Number(current.broadcastSequence)
    let missingCount = 0
    for (let slot = previousSlot + 1; slot < currentSlot; slot++) {
      if (!vacated.has(slot)) missingCount++
    }
    if (missingCount > 0) {
      holes.push({
        afterEventId: previous.id,
        afterSequence: previous.sequence,
        missingCount,
      })
    }
  }

  return holes
}

/**
 * Stable identity for a set of holes — used as an effect dependency so the
 * backfill request fires when the holes actually change, not on every
 * re-render of the same (still unfilled) window.
 */
export function holesSignature(holes: TimelineHole[]): string {
  return holes.map((hole) => `${hole.afterEventId}:${hole.missingCount}`).join("|")
}
