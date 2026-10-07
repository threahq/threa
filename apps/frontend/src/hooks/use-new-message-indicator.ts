import { useState, useEffect, useRef, useSyncExternalStore } from "react"
import type { StreamEvent } from "@threahq/types"

/**
 * The flashing event ids, held outside React state so a flash re-renders only
 * the row it marks, never the timeline that owns it.
 */
export interface NewMessageFlash {
  has(eventId: string): boolean
  readonly size: number
  subscribe(listener: () => void): () => void
}

function createNewMessageFlash() {
  let ids: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const flash: NewMessageFlash & { ids(): ReadonlySet<string>; set(next: ReadonlySet<string>): void } = {
    has: (eventId) => ids.has(eventId),
    ids: () => ids,
    get size() {
      return ids.size
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      ids = next
      for (const listener of listeners) listener()
    },
  }
  return flash
}

/** Whether `eventId` is flashing right now; re-renders the caller only when that flips. */
export function useIsNewMessage(flash: NewMessageFlash | undefined, eventId: string | undefined): boolean {
  return useSyncExternalStore(flash?.subscribe ?? noopSubscribe, () =>
    flash && eventId !== undefined ? flash.has(eventId) : false
  )
}

const noopSubscribe = () => () => {}

/**
 * Tracks messages that arrive via socket while the stream is open,
 * from users other than the current user. Returns a stable store of the
 * event IDs that should briefly display a "new message" visual indicator.
 *
 * Each ID auto-expires after the CSS animation completes (~2s).
 *
 * Derives its boundary from `lastReadEventId` — the same server-tracked
 * read state that drives the sidebar unread indicator and the "--- New ---"
 * divider. Events at or before this boundary are read and never flash.
 * Events after it that were already present when the stream opened get the
 * divider instead (handled by useUnreadDivider). Only events that arrive
 * via socket while viewing AND are after the read boundary flash here.
 *
 * `isAttentive` (the shared auto-read attention signal) splits live arrivals
 * between the two signals: attentive arrivals flash here, away arrivals are
 * recorded as known without flashing — they get the persistent unread divider
 * (blur re-latch in useUnreadDivider) instead, never both.
 */
export function useNewMessageIndicator(
  events: StreamEvent[],
  currentUserId: string | undefined,
  streamId: string,
  lastReadEventId?: string | null,
  overlayReadIds?: ReadonlySet<string>,
  isAttentive: boolean = true
): NewMessageFlash {
  const [flash] = useState(createNewMessageFlash)
  /** Event IDs present when the stream was opened. With the eventCache removed,
   *  useLiveQuery returns undefined until IDB resolves, then the complete event
   *  set. The first defined render IS the full IDB state — no settling needed. */
  const knownEventIdsRef = useRef<Set<string> | null>(null)
  const trackedIdsRef = useRef<Set<string>>(new Set())
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Reset on stream change + cleanup on unmount
  useEffect(() => {
    knownEventIdsRef.current = null
    trackedIdsRef.current = new Set()
    flash.set(new Set())
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = new Set()

    return () => {
      for (const t of timersRef.current) clearTimeout(t)
    }
  }, [streamId, flash])

  useEffect(() => {
    if (events.length === 0) return
    if (currentUserId === undefined) return

    // First render with events: snapshot all IDs as "known". Nothing flashes.
    if (knownEventIdsRef.current === null) {
      knownEventIdsRef.current = new Set(events.map((e) => e.id))
      return
    }

    // Read boundary: events at or before lastReadEventId are read.
    const lastReadIndex = lastReadEventId ? events.findIndex((e) => e.id === lastReadEventId) : -1

    // Walk backwards from newest to find genuinely new socket events.
    const freshIds: string[] = []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (lastReadIndex >= 0 && i <= lastReadIndex) break
      if (knownEventIdsRef.current.has(event.id)) break
      const messageId = (event.payload as { messageId?: string } | null)?.messageId
      if (
        isAttentive &&
        !trackedIdsRef.current.has(event.id) &&
        event.actorId !== currentUserId &&
        event.actorType === "user" &&
        (event.eventType === "message_created" || event.eventType === "companion_response") &&
        !(messageId && overlayReadIds?.has(messageId))
      ) {
        freshIds.push(event.id)
      }
      knownEventIdsRef.current.add(event.id)
    }

    if (freshIds.length === 0) return

    for (const id of freshIds) trackedIdsRef.current.add(id)

    flash.set(new Set([...flash.ids(), ...freshIds]))

    // Auto-expire after the animation completes
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      for (const id of freshIds) trackedIdsRef.current.delete(id)
      const expired = new Set(freshIds)
      flash.set(new Set([...flash.ids()].filter((id) => !expired.has(id))))
    }, 2000)
    timersRef.current.add(timer)
  }, [events, currentUserId, lastReadEventId, overlayReadIds, isAttentive, flash])

  return flash
}
