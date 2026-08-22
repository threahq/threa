import {
  sharedMessageSlotKey,
  type ContentRange,
  type SharedMessageRef,
  type SharedMessageSlot,
  type SlotMap,
} from "@threa/types"

/**
 * A stream-response carrier that may carry the canonical `slots` map and/or the
 * temporary legacy bare-key `sharedMessages` map (deploy-skew window: old
 * servers and old `sync_log` rows emit legacy-only). The slot store is the only
 * consumer — see D8 for the removal criterion.
 */
export interface SlotCarrier {
  slots?: SlotMap
  /** TEMPORARY legacy carrier keyed by bare source message id (D8 removal). */
  sharedMessages?: Record<string, SharedMessageSlot>
}

/**
 * Rekey a legacy bare-key `sharedMessages` map onto canonical slot keys. The key
 * for each entry is derived from the slot's own `messageId` — never from the
 * legacy key — so a malformed or stale legacy key cannot inject a wrong
 * canonical entry.
 */
export function rekeyLegacySharedMessages(sharedMessages: Record<string, SharedMessageSlot>): SlotMap {
  const slots: SlotMap = {}
  for (const slot of Object.values(sharedMessages)) {
    slots[sharedMessageSlotKey(slot.messageId)] = slot
  }
  return slots
}

/**
 * Normalize a carrier to its canonical slot map — the single merge authority,
 * called only at the slot-store write boundary. Canonical `slots` wins whenever
 * present, including an empty map (an empty canonical map does NOT fall through
 * to legacy, so a server that has caught up to "no slots here" is not overridden
 * by stale legacy data). A legacy-only carrier is rekeyed. Returns `null` when
 * neither field is present so the store performs no mutation (old-server /
 * map-less tolerance) — distinct from an empty map, which a replace writes as a
 * reset.
 */
export function normalizeSlotCarrier(carrier: SlotCarrier): SlotMap | null {
  if (carrier.slots) return carrier.slots
  if (carrier.sharedMessages) return rekeyLegacySharedMessages(carrier.sharedMessages)
  return null
}

function readPin(attrs: { version?: unknown; range?: unknown } | undefined): {
  version: number | null
  range: ContentRange | null
} {
  const version = typeof attrs?.version === "number" ? attrs.version : null
  const range = attrs?.range as { from?: unknown; to?: unknown } | null | undefined
  const hasRange = typeof range?.from === "number" && typeof range?.to === "number"
  return { version, range: hasRange ? { from: range!.from as number, to: range!.to as number } : null }
}

function walkSharedMessageNodes(node: unknown, visit: (ref: SharedMessageRef) => void): void {
  if (!node || typeof node !== "object") return
  const doc = node as { type?: unknown; attrs?: unknown; content?: unknown }
  if (doc.type === "sharedMessage") {
    const attrs = doc.attrs as { messageId?: unknown; version?: unknown; range?: unknown } | undefined
    if (typeof attrs?.messageId === "string") visit({ messageId: attrs.messageId, ...readPin(attrs) })
  }
  if (Array.isArray(doc.content)) {
    for (const child of doc.content) walkSharedMessageNodes(child, visit)
  }
}

/**
 * The canonical slot keys referenced by a window of events — the delete scope
 * of a replace-mode write (B2). A replace carrier only covers the bootstrap
 * EVENT WINDOW, so only the keys its events reference may be deleted; keys
 * merged from out-of-window pages/jumps/live-tail events (which the event
 * store deliberately keeps) must survive.
 */
export function collectReferencedSlotKeys(events: Iterable<{ readonly payload?: unknown }>): Set<string> {
  const keys = new Set<string>()
  for (const event of events) {
    const contentJson = (event.payload as { contentJson?: unknown } | undefined)?.contentJson
    walkSharedMessageNodes(contentJson, (ref) => keys.add(sharedMessageSlotKey(ref.messageId, ref.version, ref.range)))
  }
  return keys
}
