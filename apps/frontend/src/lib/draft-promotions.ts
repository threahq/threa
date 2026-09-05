/**
 * Lightweight in-memory event bus for draft-to-real stream promotions.
 *
 * When the background message queue successfully creates a stream from a draft
 * (scratchpad or thread), it emits a promotion event. UI components listen for
 * these events to navigate from the draft view to the real stream.
 *
 * INV-9 exception: module-level singleton is intentional here. This is a
 * transient in-memory pub/sub scoped to the current tab — listeners are
 * added/removed via React effect cleanup, so no leak risk. A context-based
 * alternative would require threading the emitter through the component tree
 * from the message queue (hook layer) to unrelated UI consumers, adding
 * coupling for no practical benefit.
 */

import type { CachedEvent } from "@/db"
import type { Stream } from "@threa/types"

export interface DraftPromotion {
  draftId: string
  realStreamId: string
  workspaceId: string
  /**
   * The optimistic rows moved onto the real stream. Read by `useStreamEvents`
   * under both ids so the handoff paints them before the real id's live query
   * resolves; released once it has.
   */
  events?: CachedEvent[]
  /**
   * The created stream row. The real view reads it while the workspace store's
   * live query catches up with the queue's `db.streams.put`, so the header
   * never falls back to the unnamed-scratchpad placeholder mid-promotion.
   */
  stream?: Stream
}

type Listener = (promotion: DraftPromotion) => void

const listeners = new Set<Listener>()
const promotionsByDraftId = new Map<string, DraftPromotion>()
const promotionsByRealStreamId = new Map<string, DraftPromotion>()

export function onDraftPromoted(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPromotedStreamId(draftId: string): string | null {
  return promotionsByDraftId.get(draftId)?.realStreamId ?? null
}

export function getDraftPromotionSource(realStreamId: string): string | null {
  return promotionsByRealStreamId.get(realStreamId)?.draftId ?? null
}

/** Handoff rows for a promotion the given draft or real stream id belongs to. */
export function getDraftPromotionEvents(streamId: string): CachedEvent[] | null {
  const promotion = promotionsByRealStreamId.get(streamId) ?? promotionsByDraftId.get(streamId)
  return promotion?.events && promotion.events.length > 0 ? promotion.events : null
}

/** The created stream row for a promotion, by its real stream id. */
export function getDraftPromotionStream(realStreamId: string): Stream | null {
  return promotionsByRealStreamId.get(realStreamId)?.stream ?? null
}

/**
 * Drop the handoff rows once the real stream's own window carries them. Keyed
 * by the real id only: the draft id's window resolves from the pre-move
 * snapshot, so releasing there would strip the rows the real view still needs.
 */
export function releaseDraftPromotionEvents(realStreamId: string): void {
  const promotion = promotionsByRealStreamId.get(realStreamId)
  if (promotion) delete promotion.events
}

export function waitForDraftPromotion(
  workspaceId: string,
  draftId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  const existing = promotionsByDraftId.get(draftId)
  if (existing?.workspaceId === workspaceId) return Promise.resolve(existing.realStreamId)

  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error("Timed out waiting for draft promotion"))
    }, options.timeoutMs ?? 30_000)
    const abort = () => {
      cleanup()
      const error = new Error("Draft promotion wait aborted")
      error.name = "AbortError"
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      unsubscribe()
    }

    unsubscribe = onDraftPromoted((promotion) => {
      if (promotion.workspaceId !== workspaceId || promotion.draftId !== draftId) return
      cleanup()
      resolve(promotion.realStreamId)
    })
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener("abort", abort, { once: true })
  })
}

export function emitDraftPromoted(promotion: DraftPromotion): void {
  promotionsByDraftId.set(promotion.draftId, promotion)
  promotionsByRealStreamId.set(promotion.realStreamId, promotion)
  for (const listener of listeners) {
    listener(promotion)
  }
}
