import type { JSONContent } from "@threahq/types"
import type { SharedMessageAttrs } from "@/components/editor/shared-message-extension"
import type { DraftAttachment } from "@/db"
import { workspaceScopedKey } from "@/lib/workspace-scoped-key"

/**
 * Ephemeral "hand-off" of content into a composer: the Share action's
 * pointer/plaintext nodes, and an aside's send-to-composer. A hand-off is
 * queued under its `target`: a stream id for that stream's own composer, or the
 * draft scope of a composer that is not a stream's (a conversation's reply).
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
const openers = new Map<string, Set<() => void>>()
const draining = new Set<string>()
// Content hand-offs move files, so their source waits to hear that the
// destination persisted them before letting go: one resolver per queued entry,
// settled true by the destination, false on expiry/reset/rejection.
const deliveryResolvers = new Map<number, (delivered: boolean) => void>()

function settleDelivery(queueId: number, delivered: boolean): void {
  const resolve = deliveryResolvers.get(queueId)
  if (!resolve) return
  deliveryResolvers.delete(queueId)
  resolve(delivered)
}

function notify(key: string): void {
  const subs = listeners.get(key)
  if (subs) {
    for (const listener of subs) listener()
    return
  }
  const [open] = openers.get(key) ?? []
  open?.()
}

function subscribeIn(subscribers: Map<string, Set<() => void>>, key: string, listener: () => void): () => void {
  let subs = subscribers.get(key)
  if (!subs) {
    subs = new Set()
    subscribers.set(key, subs)
  }
  subs.add(listener)
  return () => {
    const set = subscribers.get(key)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) subscribers.delete(key)
  }
}

function liveQueue(key: string): QueuedShareHandoff[] {
  const queued = cache.get(key)
  if (!queued) return []
  const now = Date.now()
  for (let index = queued.length - 1; index >= 0; index--) {
    if (queued[index].expiresAt < now) {
      settleDelivery(queued[index].queueId, false)
      queued.splice(index, 1)
    }
  }
  if (queued.length === 0) cache.delete(key)
  return queued
}

function consumeKind(key: string, kind: QueuedShareHandoff["kind"]): QueuedShareHandoff | null {
  const queued = liveQueue(key)
  const index = queued.findIndex((entry) => entry.kind === kind)
  if (index < 0) return null
  const [entry] = queued.splice(index, 1)
  if (queued.length === 0) cache.delete(key)
  return entry
}

function peekKind(key: string, kind: QueuedShareHandoff["kind"]): QueuedShareHandoff | null {
  return liveQueue(key).find((entry) => entry.kind === kind) ?? null
}

/**
 * Queue a share node for the target stream's composer. A composer already
 * mounted for the stream is notified via {@link subscribeShareHandoff} so it
 * picks the share up without remounting (e.g. sharing back into the stream the
 * user is already viewing).
 */
export function queueShareHandoff(workspaceId: string, targetStreamId: string, attrs: SharedMessageAttrs): void {
  const key = workspaceScopedKey(workspaceId, targetStreamId)
  const queued = cache.get(key) ?? []
  queued.push({ queueId: ++nextQueueId, kind: "pointer", attrs, expiresAt: Date.now() + HANDOFF_TTL_MS })
  cache.set(key, queued)
  notify(key)
}

/**
 * Queue a decrypted E2E message to be shared as a public plaintext quote in the
 * target stream's composer. Same hop + TTL + subscriber notification as the
 * pointer hand-off; consumed via {@link consumePlaintextShareHandoff}.
 */
export function queuePlaintextShareHandoff(
  workspaceId: string,
  targetStreamId: string,
  markdown: string,
  attrs: SharedMessageAttrs
): void {
  const key = workspaceScopedKey(workspaceId, targetStreamId)
  const queued = cache.get(key) ?? []
  queued.push({
    queueId: ++nextQueueId,
    kind: "plaintext",
    markdown,
    attrs,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  })
  cache.set(key, queued)
  notify(key)
}

/**
 * Queue composer blocks for the target. Same hop + TTL + subscriber
 * notification as a share; the composer inserts it through the same path, so a
 * draft already in the destination is stashed rather than overwritten.
 */
export function queueContentHandoff(
  workspaceId: string,
  target: string,
  content: JSONContent[],
  attachments: DraftAttachment[] = []
): { delivered: Promise<boolean> } {
  const key = workspaceScopedKey(workspaceId, target)
  const queued = cache.get(key) ?? []
  const queueId = ++nextQueueId
  const delivered = new Promise<boolean>((resolve) => deliveryResolvers.set(queueId, resolve))
  queued.push({ queueId, kind: "content", content, attachments, expiresAt: Date.now() + HANDOFF_TTL_MS })
  cache.set(key, queued)
  notify(key)
  return { delivered }
}

/**
 * The destination's verdict on a drained batch: true once its blocks and
 * files are persisted on the destination draft, false when it could not keep
 * them (the source then keeps its files). Called after
 * {@link acknowledgeShareHandoffBatch}, which only takes the batch off the queue.
 */
export function settleShareHandoffBatch(batch: ShareHandoffBatch, delivered: boolean): void {
  for (const queueId of batch.ids) settleDelivery(queueId, delivered)
}

/** Read + clear the oldest pending plaintext (decrypted E2E) share for the stream. */
export function consumePlaintextShareHandoff(
  workspaceId: string,
  targetStreamId: string
): PlaintextShareHandoffEntry | null {
  const entry = consumeKind(workspaceScopedKey(workspaceId, targetStreamId), "plaintext")
  if (!entry || entry.kind !== "plaintext") return null
  return { markdown: entry.markdown, attrs: entry.attrs, expiresAt: entry.expiresAt }
}

/** Non-consuming read of the oldest pending plaintext share. */
export function peekPlaintextShareHandoff(
  workspaceId: string,
  targetStreamId: string
): PlaintextShareHandoffEntry | null {
  const entry = peekKind(workspaceScopedKey(workspaceId, targetStreamId), "plaintext")
  if (!entry || entry.kind !== "plaintext") return null
  return { markdown: entry.markdown, attrs: entry.attrs, expiresAt: entry.expiresAt }
}

/** Snapshot every pending handoff in queue order without consuming it. */
export function peekShareHandoffBatch(workspaceId: string, target: string): ShareHandoffBatch | null {
  const queued = liveQueue(workspaceScopedKey(workspaceId, target))
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
export function acknowledgeShareHandoffBatch(workspaceId: string, target: string, batch: ShareHandoffBatch): void {
  const key = workspaceScopedKey(workspaceId, target)
  const queued = cache.get(key)
  if (!queued) return
  const acknowledged = new Set(batch.ids)
  const remaining = queued.filter((entry) => !acknowledged.has(entry.queueId))
  if (remaining.length > 0) cache.set(key, remaining)
  else cache.delete(key)
}

/**
 * Subscribe to the hand-offs queued for a target. An open composer drains what
 * is queued as it mounts, and subscribes here for what is queued while it is
 * live. Returns an unsubscribe function.
 */
export function subscribeShareHandoff(workspaceId: string, target: string, listener: () => void): () => void {
  return subscribeIn(listeners, workspaceScopedKey(workspaceId, target), listener)
}

/**
 * A composer that has to be opened before it can take a hand-off (a card's
 * collapsed reply field) subscribes here. `open` runs only while no open
 * composer listens for the target, and for one resting composer at a time, so
 * a hand-off never opens a second composer beside the one taking it.
 */
export function subscribeShareHandoffOpener(workspaceId: string, target: string, open: () => void): () => void {
  return subscribeIn(openers, workspaceScopedKey(workspaceId, target), open)
}

/** Whether a composer on the page takes hand-offs for the target, open or waiting to be opened. */
export function hasShareHandoffTaker(workspaceId: string, target: string): boolean {
  const key = workspaceScopedKey(workspaceId, target)
  return listeners.has(key) || openers.has(key)
}

/**
 * Two composers can be open on one target (a card's reply and its conversation
 * pane's). The one that starts a drain holds the target until it is done, so
 * the destination draft is stashed once. Returns null while another composer
 * holds it, else the release. A composer that goes away mid-drain releases with
 * `passOn`, which hands what is still queued to the composers left.
 */
export function claimShareHandoffDrain(workspaceId: string, target: string): ((passOn?: boolean) => void) | null {
  const key = workspaceScopedKey(workspaceId, target)
  if (draining.has(key)) return null
  draining.add(key)
  let held = true
  return (passOn = false) => {
    if (!held) return
    held = false
    draining.delete(key)
    if (passOn && liveQueue(key).length > 0) notify(key)
  }
}

/**
 * Read + clear the pending share for the given stream. Returns null when
 * nothing is queued or the entry has expired (and evicts it).
 */
export function consumeShareHandoff(workspaceId: string, targetStreamId: string): SharedMessageAttrs | null {
  const entry = consumeKind(workspaceScopedKey(workspaceId, targetStreamId), "pointer")
  return entry?.kind === "pointer" ? entry.attrs : null
}

/**
 * Non-consuming peek. Returns whether a share is currently queued for the
 * stream. Mostly for tests and debug panels.
 */
export function peekShareHandoff(workspaceId: string, targetStreamId: string): SharedMessageAttrs | null {
  const entry = peekKind(workspaceScopedKey(workspaceId, targetStreamId), "pointer")
  return entry?.kind === "pointer" ? entry.attrs : null
}

/**
 * Clears every queued handoff and subscriber. The cache is module-level so it
 * survives an account-switch React remount; AccountScope calls this on switch
 * so a share queued under one account never surfaces in another.
 */
export function resetShareHandoffStoreCache(): void {
  for (const queueId of [...deliveryResolvers.keys()]) settleDelivery(queueId, false)
  cache.clear()
  listeners.clear()
  openers.clear()
  draining.clear()
}

/** Clears every queued handoff. Test helper. */
export function __resetShareHandoffStoreForTesting(): void {
  resetShareHandoffStoreCache()
}
