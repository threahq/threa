import { beforeEach, describe, expect, it } from "vitest"
import type { StreamEvent } from "@threa/types"
import { db } from "@/db"
import { resetEventWriteFlags } from "@/db/event-writes"
import { loadStreamPrefix, loadStreamTail, unionStreamRanges } from "@/stores/stream-store"
import {
  computeTimelineLoadState,
  filterEventsForDisplay,
  getCachedWindowFloor,
  getDisplayFloor,
  getEffectiveEvents,
  getMinimumSequence,
  getNextBootstrapFloorState,
  getOldestSequence,
  getRenderableEvents,
  cacheToIndexedDB,
} from "./use-events"

describe("useEvents helpers", () => {
  it("uses the lower older-page floor when scrollback extends past bootstrap", () => {
    const bootstrapFloor = getMinimumSequence([{ sequence: "100" }, { sequence: "120" }, { sequence: "150" }])
    const olderFloor = getMinimumSequence([{ sequence: "50" }, { sequence: "75" }])

    expect(getDisplayFloor(bootstrapFloor, olderFloor)).toBe(50n)
  })

  it("widens the visible window when older pages have been fetched", () => {
    const displayFloor = getDisplayFloor(100n, 50n)
    const displayed = filterEventsForDisplay(
      [{ sequence: "10" }, { sequence: "50" }, { sequence: "75" }, { sequence: "100" }, { sequence: "150" }],
      displayFloor
    )

    expect(displayed.map((event) => event.sequence)).toEqual(["50", "75", "100", "150"])
  })

  it("limits pre-bootstrap cached history to a bootstrap-sized window", () => {
    const cachedWindowFloor = getCachedWindowFloor(
      [{ sequence: "10" }, { sequence: "20" }, { sequence: "30" }, { sequence: "40" }, { sequence: "50" }],
      3
    )

    const displayed = filterEventsForDisplay(
      [{ sequence: "10" }, { sequence: "20" }, { sequence: "30" }, { sequence: "40" }, { sequence: "50" }],
      cachedWindowFloor
    )

    expect(cachedWindowFloor).toBe(30n)
    expect(displayed.map((event) => event.sequence)).toEqual(["30", "40", "50"])
  })

  it("shows the full cached timeline when it already fits within one bootstrap-sized page", () => {
    expect(getCachedWindowFloor([{ sequence: "10" }, { sequence: "20" }, { sequence: "30" }], 3)).toBeNull()
  })

  it("keeps optimistic events visible regardless of floor", () => {
    const displayed = filterEventsForDisplay(
      [
        { sequence: "10" },
        { sequence: "20", _status: "pending" },
        { sequence: "30", _status: "failed" },
        { sequence: "100" },
      ],
      100n
    )

    expect(displayed.map((event) => [event.sequence, event._status ?? null])).toEqual([
      ["20", "pending"],
      ["30", "failed"],
      ["100", null],
    ])
  })

  it("anchors older-page fetches from the visible window, not hidden stale cache", () => {
    expect(getOldestSequence([{ sequence: "100" }, { sequence: "120" }, { sequence: "150" }])).toBe("100")
  })

  it("resets the bootstrap floor when reconnect replace increments windowVersion", () => {
    const initial = getNextBootstrapFloorState(null, "stream_1", 100n, 0)
    const appendRefetch = getNextBootstrapFloorState(initial.state, "stream_1", 140n, 0)
    const replaceRefetch = getNextBootstrapFloorState(appendRefetch.state, "stream_1", 200n, 1)

    expect(initial.floor).toBe(100n)
    expect(appendRefetch.floor).toBe(100n)
    expect(replaceRefetch.floor).toBe(200n)
  })
})

describe("computeTimelineLoadState", () => {
  it("stays blank while IDB is resolving within the grace window", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: false,
        hasAnyEvents: false,
        bootstrapSettled: false,
        idbResolveTimedOut: false,
      })
    ).toEqual({ isLoading: false, isConfirmedEmpty: false })
  })

  it("flips to skeleton once IDB resolution exceeds the grace window", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: false,
        hasAnyEvents: false,
        bootstrapSettled: false,
        idbResolveTimedOut: true,
      })
    ).toEqual({ isLoading: true, isConfirmedEmpty: false })
  })

  it("shows skeleton when IDB resolves empty and bootstrap is still fetching", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: true,
        hasAnyEvents: false,
        bootstrapSettled: false,
        idbResolveTimedOut: false,
      })
    ).toEqual({ isLoading: true, isConfirmedEmpty: false })
  })

  it("keeps a skeleton (never 'No messages yet') when IDB is empty and the socket-gated bootstrap has not answered", () => {
    // The reported bug: open a stream from a push notification on a cold PWA.
    // The bootstrap query is `enabled: false` until the socket connects, so it
    // reports not-loading. The old contract read that as "bootstrap not
    // loading => stream confirmed empty" and rendered "No messages yet" for a
    // stream with thousands of messages, stuck until a hard refresh.
    // bootstrapSettled stays false until the bootstrap actually answers.
    expect(
      computeTimelineLoadState({
        idbResolved: true,
        hasAnyEvents: false,
        bootstrapSettled: false,
        idbResolveTimedOut: true,
      })
    ).toEqual({ isLoading: true, isConfirmedEmpty: false })
  })

  it("shows confirmed-empty only once the bootstrap has produced a definitive answer", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: true,
        hasAnyEvents: false,
        bootstrapSettled: true,
        idbResolveTimedOut: false,
      })
    ).toEqual({ isLoading: false, isConfirmedEmpty: true })
  })

  it("renders neither skeleton nor empty state when events are available", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: true,
        hasAnyEvents: true,
        bootstrapSettled: false,
        idbResolveTimedOut: false,
      })
    ).toEqual({ isLoading: false, isConfirmedEmpty: false })
  })

  it("does not claim confirmed-empty once events are present after bootstrap settles", () => {
    expect(
      computeTimelineLoadState({
        idbResolved: true,
        hasAnyEvents: true,
        bootstrapSettled: true,
        idbResolveTimedOut: false,
      })
    ).toEqual({ isLoading: false, isConfirmedEmpty: false })
  })
})

describe("getRenderableEvents", () => {
  it("applies the display floor normally when events remain in-window", () => {
    const rendered = getRenderableEvents(
      [{ sequence: "10" }, { sequence: "50" }, { sequence: "100" }, { sequence: "150" }],
      100n
    )

    expect(rendered.map((event) => event.sequence)).toEqual(["100", "150"])
  })

  it("renders the full cached set rather than nothing when the floor would hide every event", () => {
    // Offline-first invariant: IDB has the stream's events and useLiveQuery
    // delivered them, but a freshly-fetched bootstrap floor landed above the
    // entire stale cached window before useLiveQuery re-emitted the bootstrap
    // writes. filterEventsForDisplay alone strips everything and the timeline
    // commits to a permanent blank scroll area. getRenderableEvents must keep
    // the cached events visible until the background refresh widens the window.
    const cached = [{ sequence: "10" }, { sequence: "20" }, { sequence: "30" }]
    expect(getRenderableEvents(cached, 100n)).toBe(cached)
  })

  it("returns empty when there genuinely are no cached events", () => {
    expect(getRenderableEvents([], 100n)).toEqual([])
  })

  it("keeps optimistic events visible even when persisted events are all below the floor", () => {
    const rendered = getRenderableEvents([{ sequence: "10" }, { sequence: "20", _status: "pending" }], 100n)

    expect(rendered.map((event) => [event.sequence, event._status ?? null])).toEqual([["20", "pending"]])
  })
})

describe("getEffectiveEvents", () => {
  it("returns nothing while IDB is unresolved", () => {
    expect(getEffectiveEvents(false, [], [{ sequence: "100" }])).toEqual([])
  })

  it("prefers IDB events once IDB has resolved with content", () => {
    const idbEvents = [{ sequence: "200", _status: "pending" as const }]
    const bootstrapEvents = [{ sequence: "100" }]
    expect(getEffectiveEvents(true, idbEvents, bootstrapEvents)).toBe(idbEvents)
  })

  it("falls back to bootstrap events when IDB resolved empty but bootstrap has events", () => {
    // The blank-render bug: bootstrap query has finished, applyStreamBootstrap
    // has written events, but useLiveQuery hasn't re-emitted yet (typical on
    // cold load with empty IDB and on the rekey transient when the bootstrap
    // floor flips). Without the fallback, the timeline goes blank with no
    // skeleton and no empty state — neither isLoading nor isConfirmedEmpty
    // fires because the (now-stale) hasAnyEvents check trusts bootstrap.
    const bootstrapEvents = [{ sequence: "100" }, { sequence: "120" }]
    expect(getEffectiveEvents(true, [], bootstrapEvents)).toBe(bootstrapEvents)
  })

  it("returns empty when IDB resolved empty and bootstrap has no events", () => {
    expect(getEffectiveEvents(true, [], [])).toEqual([])
  })
})

describe("cacheToIndexedDB with eventWriteChunking on", () => {
  beforeEach(async () => {
    resetEventWriteFlags()
    await db.events.clear()
    await db.workspaceMetadata.clear()
    await db.workspaceMetadata.put({
      id: "ws_1",
      workspaceId: "ws_1",
      emojis: [],
      emojiWeights: {},
      commands: [],
      featureFlags: { workspace: { eventWriteChunking: "on" }, user: {} },
      _cachedAt: 1,
    } as unknown as Parameters<typeof db.workspaceMetadata.put>[0])
  })

  function page(count: number, from: number): StreamEvent[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `evt_${from + i}`,
      streamId: "stream_1",
      sequence: String(from + i),
      eventType: "message_created" as const,
      payload: { messageId: `evt_${from + i}`, contentMarkdown: "hi" },
      actorId: "usr_1",
      actorType: "user" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    })) as StreamEvent[]
  }

  it("an older page still lands in the timeline window after chunked writing", async () => {
    await cacheToIndexedDB("ws_1", "stream_1", page(50, 100))
    await cacheToIndexedDB("ws_1", "stream_1", page(50, 50))

    const cached = await db.events.where("streamId").equals("stream_1").toArray()
    expect(cached).toHaveLength(100)

    const displayFloor = getDisplayFloor(getMinimumSequence(page(50, 100)), getMinimumSequence(page(50, 50)))
    expect(getRenderableEvents(cached, displayFloor)).toHaveLength(100)
  })

  it("a page that heals thread stats still heals them when chunked", async () => {
    await cacheToIndexedDB("ws_1", "stream_1", page(50, 100))
    await db.events.update("evt_120", {
      payload: { messageId: "evt_120", contentMarkdown: "hi", threadId: "str_t", replyCount: 3 },
    })

    await cacheToIndexedDB("ws_1", "stream_1", page(50, 100))

    const healed = await db.events.get("evt_120")
    expect(healed?.payload).toMatchObject({ threadId: "str_t", replyCount: 3 })
  })
})

describe("bounded timeline read from the events hook's window", () => {
  const STREAM = "stream_bounded_events"

  function cachedEvent(sequence: number, streamId = STREAM) {
    return {
      id: `evt_${streamId}_${sequence}`,
      workspaceId: "ws_1",
      streamId,
      sequence: String(sequence),
      _sequenceNum: sequence,
      eventType: "message_created",
      payload: { messageId: `evt_${streamId}_${sequence}`, contentMarkdown: String(sequence) },
      actorId: "usr_1",
      actorType: "user",
      createdAt: new Date(2026, 0, 1, 0, 0, sequence).toISOString(),
      _cachedAt: 1,
    }
  }

  async function seed(count: number, streamId = STREAM) {
    await db.events.bulkPut(
      Array.from({ length: count }, (_, i) => cachedEvent(i + 1, streamId)) as unknown as Parameters<
        typeof db.events.bulkPut
      >[0]
    )
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("paginating older widens the prefix and leaves the tail untouched", async () => {
    await seed(400)
    const tailFloor = 301

    // The window floor drops one 50-event page: only the prefix range moves.
    const prefixBefore = await loadStreamPrefix(STREAM, 200, tailFloor)
    const tailBefore = await loadStreamTail(STREAM, tailFloor, null)
    const prefixAfter = await loadStreamPrefix(STREAM, 150, tailFloor)
    const tailAfter = await loadStreamTail(STREAM, tailFloor, null)

    expect(prefixAfter).toHaveLength(prefixBefore.length + 50)
    expect(tailAfter.map((e) => e.id)).toEqual(tailBefore.map((e) => e.id))
    expect(unionStreamRanges(prefixAfter, tailAfter).map((e) => e._sequenceNum)).toEqual(
      Array.from({ length: 251 }, (_, i) => i + 150)
    )
  })

  it("a thread with two thousand replies renders every reply", async () => {
    await seed(2000)

    const union = unionStreamRanges(await loadStreamPrefix(STREAM, 1, 1801), await loadStreamTail(STREAM, 1801, null))

    expect(union).toHaveLength(2000)
    expect(union.map((e) => e._sequenceNum)).toEqual(Array.from({ length: 2000 }, (_, i) => i + 1))
  })
})
