import { describe, expect, it } from "vitest"
import type { PrefetchPayload } from "@/db/prefetch-inbox"
import { storePrefetch, type PrefetchStore } from "./sw-bootstrap-prefetch"

const PAYLOAD: PrefetchPayload = {
  kind: "eventsAround",
  workspaceId: "ws_1",
  streamId: "stream_1",
  fetchedAt: 1,
  around: { events: [] },
}

function recordingStore(sqliteCapable: boolean) {
  const calls: string[] = []
  const store: PrefetchStore = {
    sqliteCapable,
    appendPrefetch: async () => void calls.push("append"),
    writeNative: async () => void calls.push("native"),
    announce: async () => void calls.push("announce"),
  }
  return { store, calls }
}

describe("storePrefetch", () => {
  it.each<[string, boolean, string[]]>([
    ["writes natively where no tab can run SQLite storage", false, ["native"]],
    ["queues for the tab to apply on whichever engine it runs, then tells it", true, ["append", "announce"]],
  ])("%s", async (_, sqliteCapable, expected) => {
    const { store, calls } = recordingStore(sqliteCapable)
    await storePrefetch("user_1", PAYLOAD, store)
    expect(calls).toEqual(expected)
  })
})
