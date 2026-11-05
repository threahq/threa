import type { Database } from "@sqlite.org/sqlite-wasm"
import type { MirrorCoordination, ReadWriteMessage } from "./client"
import { createMirrorHandler } from "./handler"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"
import type { ModeLock } from "./storage-mode"

let tabs = 0

/** Tabs on one in-memory channel; the first to claim owns until it resigns. */
export function createBus() {
  const listeners = new Set<(message: ReadWriteMessage) => void>()
  const watchers = new Map<string, Set<() => void>>()
  const queue: Array<(owner: boolean) => void> = []
  let holder: ((owner: boolean) => void) | null = null
  let held: Array<() => void> | null = null
  const sharing = new Set<object>()
  let exclusive: object | null = null
  const waitingForLock: Array<() => void> = []
  const wakeLockWaiters = () => {
    for (const wake of waitingForLock.splice(0)) wake()
  }
  const handOver = () => {
    holder = queue.shift() ?? null
    holder?.(true)
  }
  return {
    /** Delays every broadcast until `release`, as a busy channel would. */
    hold() {
      held = []
    },
    release() {
      const deliveries = held ?? []
      held = null
      for (const deliver of deliveries) deliver()
    },
    /** One tab's side of the mode lock, as Web Locks grant it; `close` stands for the tab's end. */
    modeLock(): ModeLock & { close(): void } {
      const tab = {}
      return {
        async exclusive() {
          if (exclusive || sharing.size > 0) return null
          exclusive = tab
          return () => {
            if (exclusive !== tab) return
            exclusive = null
            wakeLockWaiters()
          }
        },
        async shared() {
          while (exclusive) await new Promise<void>((wake) => waitingForLock.push(wake))
          sharing.add(tab)
        },
        close() {
          sharing.delete(tab)
          if (exclusive === tab) exclusive = null
          wakeLockWaiters()
        },
      }
    },
    /** `tabId` is the database handle's writer id, as in the browser; the tab's death also releases `lock`. */
    coordination(
      tabId = `tab-${++tabs}`,
      lock?: { close(): void }
    ): MirrorCoordination & { resigned: () => boolean; die: () => void; dispose: () => void } {
      let mine: ((owner: boolean) => void) | null = null
      let resigned = false
      const own = new Set<(message: ReadWriteMessage) => void>()
      const resign = () => {
        resigned = true
        if (holder === mine) handOver()
        else if (mine && queue.includes(mine)) queue.splice(queue.indexOf(mine), 1)
      }
      return {
        tabId,
        watchTab(tab, onGone) {
          const watching = watchers.get(tab) ?? new Set()
          watchers.set(tab, watching)
          watching.add(onGone)
          return () => watching.delete(onGone)
        },
        resigned: () => resigned,
        /** The tab is killed: it hears nothing more and its locks are released. */
        die() {
          lock?.close()
          for (const listener of own) listeners.delete(listener)
          resign()
          const watching = watchers.get(tabId)
          watchers.delete(tabId)
          for (const onGone of watching ?? []) queueMicrotask(onGone)
        },
        claim(onChange) {
          mine = onChange
          if (!holder) {
            holder = onChange
            onChange(true)
          } else {
            onChange(false)
            queue.push(onChange)
          }
        },
        resign,
        /** The tab's mirror is gone, the page not: it resigns and hears nothing more. */
        dispose() {
          resign()
          for (const listener of own) listeners.delete(listener)
        },
        broadcast(message) {
          for (const listener of listeners) {
            if (own.has(listener)) continue
            const deliver = () => listener(message)
            if (held) held.push(deliver)
            else queueMicrotask(deliver)
          }
        },
        onBroadcast(listener) {
          own.add(listener)
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    },
  }
}

/**
 * Settles in a task of its own, as a worker's reply arrives: a chain of
 * microtasks instead would starve the zone echoes Dexie keeps a transaction's
 * scope alive across native awaits with. The task is the one fake-indexeddb
 * answers in, so suites see the timing they see without the mirror.
 */
function asWorkerReply(reply: MirrorReply): Promise<MirrorReply> {
  return new Promise((resolve) => setImmediate(() => resolve(reply)))
}

export function inProcessTransport(sqlite: Database, log: MirrorRequest["type"][] = []): MirrorTransport {
  const handler = createMirrorHandler(async () => ({ db: sqlite, close: () => {} }))
  let heardAt = 0
  return {
    request: (request) => {
      log.push(request.type)
      return handler.handle(request, () => (heardAt = performance.now())).then(asWorkerReply)
    },
    heardAt: () => heardAt,
    close: () => {},
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}
