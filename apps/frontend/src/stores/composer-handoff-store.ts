import type { JSONContent } from "@threa/types"
import type { SharedMessageAttrs } from "@/components/editor/shared-message-extension"
import type { DraftAttachment } from "@/db"

/**
 * Ephemeral per-stream "hand-off" of content into a target stream's composer:
 * the Share action's pointer/plaintext nodes, and an aside's send-to-composer.
 * One queue for all of them, so they share the one stash-then-insert path the
 * composer runs (INV-43) — a non-empty destination is always preserved as a
 * stash row, never replaced. Scoped to a single navigation hop with a short TTL
 * so stale entries never resurface if the user bails mid-flow.
 */
export interface ShareHandoffEntry {
  attrs: SharedMessageAttrs
  /** Epoch ms expiration; entries past this are ignored + evicted on read */
  expiresAt: number
}

/**
 * Hand-off for a message shared OUT of an E2E scratchpad. A sealed source can't
 * be a pointer (recipients hold no key), so the share is the decrypted plaintext
 * itself — made public as a quote in the target — captured at share time behind
 * an explicit confirmation. `attrs` is carried for author attribution.
 */
export interface PlaintextShareHandoffEntry {
  markdown: string
  attrs: SharedMessageAttrs
  expiresAt: number
}

/**
 * Blocks handed straight to the composer — the aside's send-to-composer, which
 * carries `contentJson` end to end (INV-58) rather than re-parsing markdown.
 */
export interface ContentHandoffEntry {
  content: JSONContent[]
  /** Uploaded attachments that move with the blocks; the destination adopts them as its own. */
  attachments: DraftAttachment[]
  expiresAt: number
}

export type PendingShareHandoff =
  | { kind: "pointer"; attrs: SharedMessageAttrs }
  | { kind: "plaintext"; markdown: string; attrs: SharedMessageAttrs }
  | { kind: "content"; content: JSONContent[]; attachments: DraftAttachment[] }

export interface ShareHandoffBatch {
  ids: readonly number[]
  handoffs: readonly PendingShareHandoff[]
}

type QueuedShareHandoff =
  | ({ queueId: number; kind: "pointer" } & ShareHandoffEntry)
  | ({ queueId: number; kind: "plaintext" } & PlaintextShareHandoffEntry)
  | ({ queueId: number; kind: "content" } & ContentHandoffEntry)

const HANDOFF_TTL_MS = 5 * 60 * 1000

let nextQueueId = 0
const cache = new Map<string, QueuedShareHandoff[]>()
const listeners = new Map<string, Set<() => void>>()

function liveQueue(streamId: string): QueuedShareHandoff[] {
  const queued = cache.get(streamId)
  if (!queued) return []
  const now = Date.now()
  for (let index = queued.length - 1; index >= 0; index--) {
    if (queued[index].expiresAt < now) queued.splice(index, 1)
  }
  if (queued.length === 0) cache.delete(streamId)
  return queued
}

function consumeKind(streamId: string, kind: QueuedShareHandoff["kind"]): QueuedShareHandoff | null {
  const queued = liveQueue(streamId)
  const index = queued.findIndex((entry) => entry.kind === kind)
  if (index < 0) return null
  const [entry] = queued.splice(index, 1)
  if (queued.length === 0) cache.delete(streamId)
  return entry
}

function peekKind(streamId: string, kind: QueuedShareHandoff["kind"]): QueuedShareHandoff | null {
  return liveQueue(streamId).find((entry) => entry.kind === kind) ?? null
}

/**
 * Queue a share node for the target stream's composer. A composer already
 * mounted for the stream is notified via {@link subscribeShareHandoff} so it
 * picks the share up without remounting (e.g. sharing back into the stream the
 * user is already viewing).
 */
export function queueShareHandoff(targetStreamId: string, attrs: SharedMessageAttrs): void {
  const queued = cache.get(targetStreamId) ?? []
  queued.push({ queueId: ++nextQueueId, kind: "pointer", attrs, expiresAt: Date.now() + HANDOFF_TTL_MS })
  cache.set(targetStreamId, queued)
  const subs = listeners.get(targetStreamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/**
 * Queue a decrypted E2E message to be shared as a public plaintext quote in the
 * target stream's composer. Same hop + TTL + subscriber notification as the
 * pointer hand-off; consumed via {@link consumePlaintextShareHandoff}.
 */
export function queuePlaintextShareHandoff(targetStreamId: string, markdown: string, attrs: SharedMessageAttrs): void {
  const queued = cache.get(targetStreamId) ?? []
  queued.push({
    queueId: ++nextQueueId,
    kind: "plaintext",
    markdown,
    attrs,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  })
  cache.set(targetStreamId, queued)
  const subs = listeners.get(targetStreamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/**
 * Queue composer blocks for the target stream. Same hop + TTL + subscriber
 * notification as a share; the composer inserts it through the same path, so a
 * draft already in the destination is stashed rather than overwritten.
 */
export function queueContentHandoff(
  targetStreamId: string,
  content: JSONContent[],
  attachments: DraftAttachment[] = []
): void {
  const queued = cache.get(targetStreamId) ?? []
  queued.push({
    queueId: ++nextQueueId,
    kind: "content",
    content,
    attachments,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  })
  cache.set(targetStreamId, queued)
  const subs = listeners.get(targetStreamId)
  if (subs) {
    for (const listener of subs) listener()
  }
}

/** Read + clear the oldest pending plaintext (decrypted E2E) share for the stream. */
export function consumePlaintextShareHandoff(targetStreamId: string): PlaintextShareHandoffEntry | null {
  const entry = consumeKind(targetStreamId, "plaintext")
  if (!entry || entry.kind !== "plaintext") return null
  return { markdown: entry.markdown, attrs: entry.attrs, expiresAt: entry.expiresAt }
}

/** Non-consuming read of the oldest pending plaintext share. */
export function peekPlaintextShareHandoff(targetStreamId: string): PlaintextShareHandoffEntry | null {
  const entry = peekKind(targetStreamId, "plaintext")
  if (!entry || entry.kind !== "plaintext") return null
  return { markdown: entry.markdown, attrs: entry.attrs, expiresAt: entry.expiresAt }
}

/** Snapshot every pending handoff in queue order without consuming it. */
export function peekShareHandoffBatch(targetStreamId: string): ShareHandoffBatch | null {
  const queued = liveQueue(targetStreamId)
  if (queued.length === 0) return null
  return {
    ids: queued.map((entry) => entry.queueId),
    handoffs: queued.map((entry) => {
      if (entry.kind === "pointer") return { kind: "pointer", attrs: entry.attrs }
      if (entry.kind === "content") return { kind: "content", content: entry.content, attachments: entry.attachments }
      return { kind: "plaintext", markdown: entry.markdown, attrs: entry.attrs }
    }),
  }
}

/** Remove only the entries represented by a previously-read batch. */
export function acknowledgeShareHandoffBatch(targetStreamId: string, batch: ShareHandoffBatch): void {
  const queued = cache.get(targetStreamId)
  if (!queued) return
  const acknowledged = new Set(batch.ids)
  const remaining = queued.filter((entry) => !acknowledged.has(entry.queueId))
  if (remaining.length > 0) cache.set(targetStreamId, remaining)
  else cache.delete(targetStreamId)
}

/**
 * Subscribe to share-handoff events for a given stream. Composers already
 * mounted call this in addition to the on-mount {@link consumeShareHandoff}
 * read so they pick up shares queued while they were live. Returns an
 * unsubscribe function.
 */
export function subscribeShareHandoff(targetStreamId: string, listener: () => void): () => void {
  let subs = listeners.get(targetStreamId)
  if (!subs) {
    subs = new Set()
    listeners.set(targetStreamId, subs)
  }
  subs.add(listener)
  return () => {
    const set = listeners.get(targetStreamId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(targetStreamId)
  }
}

/**
 * Read + clear the pending share for the given stream. Returns null when
 * nothing is queued or the entry has expired (and evicts it).
 */
export function consumeShareHandoff(targetStreamId: string): SharedMessageAttrs | null {
  const entry = consumeKind(targetStreamId, "pointer")
  return entry?.kind === "pointer" ? entry.attrs : null
}

/**
 * Non-consuming peek. Returns whether a share is currently queued for the
 * stream. Mostly for tests and debug panels.
 */
export function peekShareHandoff(targetStreamId: string): SharedMessageAttrs | null {
  const entry = peekKind(targetStreamId, "pointer")
  return entry?.kind === "pointer" ? entry.attrs : null
}

/**
 * Clears every queued handoff and subscriber. The cache is module-level so it
 * survives an account-switch React remount; AccountScope calls this on switch
 * so a share queued under one account never surfaces in another.
 */
export function resetShareHandoffStoreCache(): void {
  cache.clear()
  listeners.clear()
}

/** Clears every queued handoff. Test helper. */
export function __resetShareHandoffStoreForTesting(): void {
  resetShareHandoffStoreCache()
}
