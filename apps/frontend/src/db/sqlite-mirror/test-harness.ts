import type { Database } from "@sqlite.org/sqlite-wasm"
import type { CoordinationMessage, MirrorCoordination } from "./client"
import { createMirrorHandler } from "./handler"
import { markPrimary, primaryMarked, type IdbGuard } from "./idb-guard"
import { mirrorChannelName } from "./marks"
import type { MirrorReply, MirrorRequest, MirrorTransport } from "./protocol"

let tabs = 0

/** Tabs on one in-memory channel; the first to claim owns until it resigns. */
export function createBus() {
  const listeners = new Set<(message: CoordinationMessage) => void>()
  const live = new Set<string>()
  const watchers = new Map<string, Set<() => void>>()
  const queue: Array<(owner: boolean) => void> = []
  let holder: ((owner: boolean) => void) | null = null
  let held: Array<() => void> | null = null
  const writingIdb = new Set<object>()
  let primary: object | null = null
  const waitingToWrite: Array<() => void> = []
  const handOver = () => {
    holder = queue.shift() ?? null
    holder?.(true)
  }
  const channels: BroadcastChannel[] = []
  return {
    /** Also delivers what handles without a mirror announce on the database's channel. */
    hearAnnouncements(idbName: string) {
      const channel = new BroadcastChannel(mirrorChannelName(idbName))
      channel.onmessage = ({ data }: MessageEvent<CoordinationMessage>) => {
        for (const listener of listeners) listener(data)
      }
      channels.push(channel)
    },
    close() {
      for (const channel of channels.splice(0)) channel.close()
    },
    /** Delays every broadcast until `release`, as a busy channel would. */
    hold() {
      held = []
    },
    release() {
      const deliveries = held ?? []
      held = null
      for (const deliver of deliveries) deliver()
    },
    /** A tab that runs no mirror but is alive, as one still booting would be. */
    liveTab(tabId: string) {
      live.add(tabId)
    },
    /** One tab's side of the IndexedDB lock, as Web Locks grant it; `close` stands for the tab's end. */
    guard(idbName: string): IdbGuard & { close(): void } {
      const tab = {}
      const releasePrimary = () => {
        if (primary !== tab) return
        primary = null
        for (const wake of waitingToWrite.splice(0)) wake()
      }
      return {
        async holdNative(wait) {
          while (!writingIdb.has(tab) && primary) {
            if (!wait) return false
            await new Promise<void>((wake) => waitingToWrite.push(wake))
          }
          writingIdb.add(tab)
          return true
        },
        async claimPrimary() {
          if (primary || writingIdb.size > 0) return false
          primary = tab
          return true
        },
        releasePrimary,
        primaryMarked: () => primaryMarked(idbName),
        markPrimary: (marked) => markPrimary(idbName, marked),
        close() {
          writingIdb.delete(tab)
          releasePrimary()
        },
      }
    },
    /** `tabId` is the database handle's writer id, as in the browser; the tab's death also releases `guard`. */
    coordination(
      tabId = `tab-${++tabs}`,
      guard?: { close(): void }
    ): MirrorCoordination & { resigned: () => boolean; die: () => void } {
      let mine: ((owner: boolean) => void) | null = null
      let resigned = false
      const own = new Set<(message: CoordinationMessage) => void>()
      live.add(tabId)
      const resign = () => {
        resigned = true
        if (holder === mine) handOver()
        else if (mine && queue.includes(mine)) queue.splice(queue.indexOf(mine), 1)
      }
      return {
        tabId,
        liveTabs: async () => new Set(live),
        watchTab(tab, onGone) {
          const watching = watchers.get(tab) ?? new Set()
          watchers.set(tab, watching)
          watching.add(onGone)
          return () => watching.delete(onGone)
        },
        resigned: () => resigned,
        /** The tab is killed: it hears nothing more and its locks are released. */
        die() {
          live.delete(tabId)
          guard?.close()
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
        close() {
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
  const handler = createMirrorHandler(async () => ({ db: sqlite, close: () => {}, destroy: async () => {} }))
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
