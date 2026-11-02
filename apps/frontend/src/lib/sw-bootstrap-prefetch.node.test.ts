import { describe, expect, it } from "vitest"
import type { PrefetchPayload } from "@/db/prefetch-inbox"
import type { SqliteStorageMode } from "@/db/sqlite-mirror/storage-mode"
import { storePrefetch, type PrefetchStore } from "./sw-bootstrap-prefetch"

const PAYLOAD: PrefetchPayload = {
  kind: "eventsAround",
  workspaceId: "ws_1",
  streamId: "stream_1",
  fetchedAt: 1,
  around: { events: [] },
}

interface World {
  /** `null`: no Web Locks; otherwise whether the shared mode lock is free. */
  lock: boolean | null
  mode: SqliteStorageMode
  queued: boolean
}

/** Every call the worker makes, tagged with whether it ran holding the shared mode lock. */
function recordingStore(world: World) {
  const calls: string[] = []
  let holding = false
  const log = (call: string) => calls.push(holding ? `${call} (locked)` : call)
  const store: PrefetchStore = {
    modeLock: () =>
      world.lock === null
        ? null
        : {
            ifShared: async (run) => {
              holding = world.lock === true
              try {
                return await run(holding)
              } finally {
                holding = false
              }
            },
          },
    readMode: async () => {
      log("readMode")
      return world.mode
    },
    hasPrefetches: async () => {
      log("hasPrefetches")
      return world.queued
    },
    appendPrefetch: async () => void log("append"),
    writeNative: async () => void log("native"),
    announce: async () => void log("announce"),
  }
  return { store, calls }
}

describe("storePrefetch", () => {
  it.each<[string, World, string[]]>([
    [
      "writes natively without Web Locks, as no tab can then run a mirror",
      { lock: null, mode: "off", queued: false },
      ["native"],
    ],
    [
      "writes natively under the shared lock while IndexedDB is primary and the inbox is empty",
      { lock: true, mode: "off", queued: false },
      ["readMode (locked)", "hasPrefetches (locked)", "native (locked)"],
    ],
    [
      "writes natively under shadow storage, whose marks cover the write",
      { lock: true, mode: "shadow", queued: false },
      ["readMode (locked)", "hasPrefetches (locked)", "native (locked)"],
    ],
    [
      "writes natively under read-only storage",
      { lock: true, mode: "read-only", queued: false },
      ["readMode (locked)", "hasPrefetches (locked)", "native (locked)"],
    ],
    [
      "queues under read-write storage, where SQLite is primary",
      { lock: true, mode: "read-write", queued: false },
      ["readMode (locked)", "append (locked)", "announce"],
    ],
    [
      "queues behind earlier prefetches so none lands after a later one",
      { lock: true, mode: "off", queued: true },
      ["readMode (locked)", "hasPrefetches (locked)", "append (locked)", "announce"],
    ],
    [
      "queues without reading the mode while a boot holds or awaits the exclusive lock",
      { lock: false, mode: "off", queued: false },
      ["append", "announce"],
    ],
  ])("%s", async (_, world, expected) => {
    const { store, calls } = recordingStore(world)
    await storePrefetch("user_1", PAYLOAD, store)
    expect(calls).toEqual(expected)
  })
})
