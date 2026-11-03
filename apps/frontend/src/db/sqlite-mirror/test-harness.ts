import type { Database } from "@sqlite.org/sqlite-wasm"
import type { MirrorCoordination } from "./client"
import { createMirrorHandler } from "./handler"
import { mirrorChannelName, type MirrorBroadcast } from "./marks"
import type { MirrorRequest, MirrorTransport } from "./protocol"

let tabs = 0

/** Tabs on one in-memory channel; the first to claim owns until it resigns. */
export function createBus() {
  const listeners = new Set<(message: MirrorBroadcast) => void>()
  const live = new Set<string>()
  const queue: Array<(owner: boolean) => void> = []
  let holder: ((owner: boolean) => void) | null = null
  let held: Array<() => void> | null = null
  const handOver = () => {
    holder = queue.shift() ?? null
    holder?.(true)
  }
  const channels: BroadcastChannel[] = []
  return {
    /** Also delivers what handles without a mirror announce on the database's channel. */
    hearAnnouncements(idbName: string) {
      const channel = new BroadcastChannel(mirrorChannelName(idbName))
      channel.onmessage = ({ data }: MessageEvent<MirrorBroadcast>) => {
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
    /** `tabId` is the database handle's writer id, as in the browser. */
    coordination(tabId = `tab-${++tabs}`): MirrorCoordination & { resigned: () => boolean; die: () => void } {
      let mine: ((owner: boolean) => void) | null = null
      let resigned = false
      const own = new Set<(message: MirrorBroadcast) => void>()
      live.add(tabId)
      const resign = () => {
        resigned = true
        if (holder === mine) handOver()
        else if (mine && queue.includes(mine)) queue.splice(queue.indexOf(mine), 1)
      }
      return {
        tabId,
        liveTabs: async () => new Set(live),
        resigned: () => resigned,
        /** The tab is killed: it hears nothing more and its lock is released. */
        die() {
          live.delete(tabId)
          for (const listener of own) listeners.delete(listener)
          resign()
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

export function inProcessTransport(sqlite: Database, log: MirrorRequest["type"][] = []): MirrorTransport {
  const handler = createMirrorHandler(async () => ({ db: sqlite, close: () => {}, destroy: async () => {} }))
  return {
    request: (request) => {
      log.push(request.type)
      return handler.handle(request)
    },
    close: () => {},
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}
