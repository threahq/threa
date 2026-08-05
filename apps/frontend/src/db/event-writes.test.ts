import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { liveQuery } from "dexie"
import { db, sequenceToNum, type CachedEvent } from "@/db"
import {
  EVENT_BULK_PUT_LIMIT,
  isEventWriteChunkingEnabled,
  isSharedStreamRegistrationEnabledSync,
  readEventWriteFlagsFresh,
  primeEventWriteFlags,
  primeEventWriteFlagsIfAbsent,
  putEventsBounded,
  resetEventWriteFlags,
  skipNoOpEventRewrites,
} from "./event-writes"

function makeRow(streamId: string, index: number, overrides: Partial<CachedEvent> = {}): CachedEvent {
  const sequence = String(1000 + index)
  return {
    id: `evt_${streamId}_${index}`,
    workspaceId: "ws_1",
    streamId,
    sequence,
    _sequenceNum: sequenceToNum(sequence),
    eventType: "message_created",
    payload: { messageId: `evt_${streamId}_${index}`, contentMarkdown: "hi" },
    actorId: "usr_1",
    actorType: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    _cachedAt: 1,
    ...overrides,
  } as CachedEvent
}

function makePage(streamId: string, count: number): CachedEvent[] {
  return Array.from({ length: count }, (_, i) => makeRow(streamId, i))
}

beforeEach(async () => {
  resetEventWriteFlags()
  await db.events.clear()
  await db.workspaceMetadata.clear()
})

async function putMetadata(featureFlags: unknown): Promise<void> {
  await db.workspaceMetadata.put({
    id: "ws_1",
    workspaceId: "ws_1",
    emojis: [],
    emojiWeights: {},
    commands: [],
    featureFlags,
    _cachedAt: 1,
  } as unknown as Parameters<typeof db.workspaceMetadata.put>[0])
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("putEventsBounded", () => {
  it("a 50-row page is written as two sub-50 batches", async () => {
    const rows = makePage("stream_a", 50)
    const bulkPut = vi.spyOn(db.events, "bulkPut")

    await putEventsBounded(db.events, rows, true)

    expect(bulkPut).toHaveBeenCalledTimes(2)
    expect(bulkPut.mock.calls.map((call) => (call[0] as CachedEvent[]).length)).toEqual([EVENT_BULK_PUT_LIMIT, 1])
    expect(await db.events.where("streamId").equals("stream_a").count()).toBe(50)
  })

  it("writes a single bulkPut when chunking is off", async () => {
    const bulkPut = vi.spyOn(db.events, "bulkPut")

    await putEventsBounded(db.events, makePage("stream_a", 50), false)

    expect(bulkPut).toHaveBeenCalledTimes(1)
    expect(await db.events.where("streamId").equals("stream_a").count()).toBe(50)
  })
})

describe("skipNoOpEventRewrites", () => {
  it("re-writing an identical page writes nothing", async () => {
    const rows = makePage("stream_a", 50)
    await putEventsBounded(db.events, rows, true)

    const existingRows = await db.events.bulkGet(rows.map((row) => row.id))
    const existingById = new Map(
      existingRows.filter((row): row is CachedEvent => row != null).map((row) => [row.id, row] as const)
    )
    const candidates = rows.map((row) => ({ ...row, _cachedAt: 999 }))
    const bulkPut = vi.spyOn(db.events, "bulkPut")

    await putEventsBounded(db.events, skipNoOpEventRewrites(existingById, candidates), true)

    expect(bulkPut).toHaveBeenCalledTimes(0)
    const after = await db.events.where("streamId").equals("stream_a").toArray()
    expect(after.every((row) => row._cachedAt === 1)).toBe(true)
  })

  it("a row carrying optimistic _status is never skipped", async () => {
    const optimistic = makeRow("stream_a", 0, { _status: "pending" })
    await db.events.put(optimistic)

    const candidate = { ...optimistic, _status: undefined } as CachedEvent
    const kept = skipNoOpEventRewrites(new Map([[optimistic.id, optimistic]]), [candidate])

    expect(kept).toEqual([candidate])
  })

  it("keeps a row whose payload changed and drops the unchanged neighbour", () => {
    const unchanged = makeRow("stream_a", 0)
    const changedBefore = makeRow("stream_a", 1)
    const changedAfter = {
      ...changedBefore,
      payload: { ...(changedBefore.payload as Record<string, unknown>), contentMarkdown: "edited" },
    }

    const kept = skipNoOpEventRewrites(
      new Map([
        [unchanged.id, unchanged],
        [changedBefore.id, changedBefore],
      ]),
      [{ ...unchanged, _cachedAt: 999 }, changedAfter]
    )

    expect(kept).toEqual([changedAfter])
  })
})

describe("live-query wake set (D1)", () => {
  async function countEmissions(run: () => Promise<void>): Promise<number> {
    let emissions = 0
    let firstEmission: (() => void) | undefined
    const firstEmitted = new Promise<void>((resolve) => {
      firstEmission = resolve
    })
    const subscription = liveQuery(() =>
      db.events
        .where("[streamId+_sequenceNum]")
        .between(["stream_a", 0], ["stream_a", Number.MAX_SAFE_INTEGER])
        .toArray()
    ).subscribe(() => {
      emissions += 1
      firstEmission?.()
    })
    await firstEmitted
    const baseline = emissions

    await run()
    await new Promise((resolve) => setTimeout(resolve, 50))
    subscription.unsubscribe()
    return emissions - baseline
  }

  it("a 50-row page does not wake a live query ranged on another stream", async () => {
    const chunkedEmissions = await countEmissions(async () => {
      await putEventsBounded(db.events, makePage("stream_b", 50), true)
    })
    expect(chunkedEmissions).toBe(0)

    await db.events.clear()

    const unchunkedEmissions = await countEmissions(async () => {
      await putEventsBounded(db.events, makePage("stream_b", 50), false)
    })
    expect(unchunkedEmissions).toBeGreaterThan(0)
  })

  it("a page written inside one wrapping transaction still does not wake another stream's query", async () => {
    const emissions = await countEmissions(async () => {
      await db.transaction("rw", [db.events], async () => {
        await putEventsBounded(db.events, makePage("stream_b", 50), true)
      })
    })

    expect(emissions).toBe(0)
    expect(await db.events.where("streamId").equals("stream_b").count()).toBe(50)
  })

  it("a patch to a row the query returned still wakes it", async () => {
    await db.events.put(makeRow("stream_a", 0))

    const emissions = await countEmissions(async () => {
      await putEventsBounded(
        db.events,
        [makeRow("stream_a", 0, { payload: { messageId: "evt_stream_a_0", contentMarkdown: "edited" } })],
        true
      )
    })

    expect(emissions).toBeGreaterThan(0)
  })
})

describe("isEventWriteChunkingEnabled", () => {
  it("resolves a persisted layered row and caches it", async () => {
    await putMetadata({ workspace: { eventWriteChunking: "on" }, user: {} })
    const get = vi.spyOn(db.workspaceMetadata, "get")

    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("a pre-#1455 flat row neither throws nor overrides the registry default", async () => {
    // A flat legacy row is IGNORED (coerced away), so the resolved value is the
    // registry default — "on" since the go-live flip — never the flat row's own
    // field, and never a crash.
    await putMetadata({ eventWriteChunking: "off" })

    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
  })

  it("a primed value wins without reading the row", async () => {
    await putMetadata({ workspace: { eventWriteChunking: "off" }, user: {} })
    const get = vi.spyOn(db.workspaceMetadata, "get")
    primeEventWriteFlags("ws_1", { workspace: {}, user: { eventWriteChunking: "on" } })

    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it("resetEventWriteFlags clears the primed value", async () => {
    // Primed "off" (an explicit override), then reset: with no persisted row
    // the resolve falls back to the registry default "on" — proving the primed
    // override was dropped, not retained.
    primeEventWriteFlags("ws_1", { workspace: { eventWriteChunking: "off" }, user: {} })
    resetEventWriteFlags()

    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
  })

  it("a prime landing mid-read wins over the older persisted row", async () => {
    await putMetadata({ workspace: { eventWriteChunking: "off" }, user: {} })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const real = db.workspaceMetadata.get.bind(db.workspaceMetadata)
    vi.spyOn(db.workspaceMetadata, "get").mockImplementation(((key: string) =>
      gate.then(() => real(key))) as unknown as typeof db.workspaceMetadata.get)

    const inFlight = isEventWriteChunkingEnabled(db, "ws_1")
    primeEventWriteFlags("ws_1", { workspace: { eventWriteChunking: "on" }, user: {} })
    release()

    expect(await inFlight).toBe(true)
    expect(await isEventWriteChunkingEnabled(db, "ws_1")).toBe(true)
  })

  it("readEventWriteFlagsFresh ignores the cache and re-reads the row every call", async () => {
    await putMetadata({ workspace: { eventWriteChunking: "on", indexedMessagePatch: "on" }, user: {} })
    primeEventWriteFlags("ws_1", { workspace: { eventWriteChunking: "off", indexedMessagePatch: "off" }, user: {} })

    const first = await readEventWriteFlagsFresh(db, "ws_1")
    await putMetadata({ workspace: { eventWriteChunking: "off", indexedMessagePatch: "on" }, user: {} })
    const second = await readEventWriteFlagsFresh(db, "ws_1")

    expect({ first, second }).toEqual({
      first: { chunking: true, indexedMessagePatch: true, sharedStreamRegistration: false },
      second: { chunking: false, indexedMessagePatch: true, sharedStreamRegistration: false },
    })
  })
})

describe("primeEventWriteFlagsIfAbsent", () => {
  it("primeEventWriteFlagsIfAbsent fills an empty cache", () => {
    primeEventWriteFlagsIfAbsent("ws_1", { workspace: { sharedStreamRegistration: "on" }, user: {} })

    expect(isSharedStreamRegistrationEnabledSync("ws_1")).toBe(true)
  })

  it("primeEventWriteFlagsIfAbsent never overwrites a value already primed", () => {
    primeEventWriteFlags("ws_1", { workspace: { sharedStreamRegistration: "on" }, user: {} })
    primeEventWriteFlagsIfAbsent("ws_1", { workspace: { sharedStreamRegistration: "off" }, user: {} })

    expect(isSharedStreamRegistrationEnabledSync("ws_1")).toBe(true)
  })
})
