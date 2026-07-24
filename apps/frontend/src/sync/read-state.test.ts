import { describe, it, expect, beforeEach, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { commitCounterMutation } from "./catch-up-batch"
import { applyReadStateSnapshotsIdb, commitReadStateSnapshot, type ReadStateSnapshot } from "./read-state"

function snapshot(overrides: Partial<ReadStateSnapshot> = {}): ReadStateSnapshot {
  return {
    streamId: "stream_1",
    readMessageIds: ["msg_5", "msg_7"],
    lastReadEventId: "evt_4",
    lastReadSequence: "40",
    lastReadOrdinal: 4,
    ...overrides,
  }
}

async function seedUnreadState() {
  await db.unreadState.put({
    id: "ws_1",
    workspaceId: "ws_1",
    unreadCounts: { stream_1: 6 },
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    unreadActivities: [],
    latestOrdinals: { stream_1: 10 },
    mutedStreamIds: [],
    _cachedAt: Date.now(),
  })
}

function makeActivity(id: string, messageId: string) {
  return {
    id,
    workspaceId: "ws_1",
    userId: "usr_1",
    activityType: "mention",
    streamId: "stream_1",
    messageId,
    actorId: "usr_2",
    actorType: "user" as const,
    context: {},
    isSelf: false,
    readAt: null,
    emoji: null,
    createdAt: new Date().toISOString(),
  }
}

async function seedMembership() {
  await db.streamMemberships.put({
    id: "ws_1:stream_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    memberId: "member_1",
    notificationLevel: null,
    lastReadEventId: "evt_0",
    lastReadAt: null,
    joinedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
  })
}

describe("applyReadStateSnapshotsIdb", () => {
  beforeEach(async () => {
    await Promise.all([
      db.unreadState.clear(),
      db.streamMemberships.clear(),
      db.streams.clear(),
      db.streamReadState.clear(),
    ])
  })

  it("drops held activity for exactly the marked messages (message-granular badge coupling)", async () => {
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 6 },
      mentionCounts: { stream_1: 2 },
      activityCounts: { stream_1: 2 },
      unreadActivityCount: 2,
      unreadActivities: [makeActivity("act_1", "msg_5"), makeActivity("act_2", "msg_9")],
      latestOrdinals: { stream_1: 10 },
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })
    await seedMembership()

    // msg_5 was marked read; msg_9 belongs to another topic and keeps its badge.
    await applyReadStateSnapshotsIdb("ws_1", [snapshot({ markedMessageIds: ["msg_5"] })])

    const state = await db.unreadState.get("ws_1")
    expect(state?.unreadActivities?.map((a) => a.id)).toEqual(["act_2"])
    expect(state?.unreadActivityCount).toBe(1)
  })

  it("SETs the overlay, recomputes unread by the invariant, and mirrors the watermark", async () => {
    await seedUnreadState()
    await seedMembership()

    await applyReadStateSnapshotsIdb("ws_1", [snapshot()])

    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["msg_5", "msg_7"])
    expect(state?.unreadCounts.stream_1).toBe(4) // 10 - 4 - 2

    const membership = await db.streamMemberships.get("ws_1:stream_1")
    expect(membership?.lastReadEventId).toBe("evt_4")
    expect(membership?.lastReadSequence).toBe("40")

    // Standalone frontier dual-write (read cutover) — including the optimistic
    // path with no membership row: upserting read state is always safe.
    const readState = await db.streamReadState.get("ws_1:stream_1")
    expect(readState?.lastReadEventId).toBe("evt_4")
    expect(readState?.lastReadSequence).toBe("40")
  })

  it("is idempotent — a duplicate snapshot converges to the same state", async () => {
    await seedUnreadState()
    await applyReadStateSnapshotsIdb("ws_1", [snapshot()])
    await applyReadStateSnapshotsIdb("ws_1", [snapshot()])

    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["msg_5", "msg_7"])
    expect(state?.unreadCounts.stream_1).toBe(4)
  })

  it("no-ops when there are no snapshots", async () => {
    await seedUnreadState()
    await applyReadStateSnapshotsIdb("ws_1", [])
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds).toBeUndefined()
    expect(state?.unreadCounts.stream_1).toBe(6)
  })
})

describe("applyReadStateSnapshotsIdb — startedAt freshness guard", () => {
  // A conversation read/unread response begun at T0 applies per stream only to
  // legs NOT touched at/after T0 (the request's own socket echo, or a later
  // action). A delayed earlier read-through-M5 must not regress a later
  // read-through-M10, and a delayed read must not erase a later explicit
  // unread — operation order (touched-at), not sequence max, decides.

  beforeEach(async () => {
    await Promise.all([
      db.unreadState.clear(),
      db.streamMemberships.clear(),
      db.streams.clear(),
      db.streamReadState.clear(),
    ])
  })

  it("skips a stream touched after departure — a delayed earlier read cannot regress a later one", async () => {
    await seedUnreadState()
    await seedMembership()

    // A later read-through-M10 landed AFTER the delayed request departed: its
    // echo/optimistic apply SET the overlay + frontier and stamped the touch.
    const touchedAt = Date.now()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
      lastReadAt: "2026-01-01T00:00:10.000Z",
      _cachedAt: touchedAt,
    })
    const seeded = await db.unreadState.get("ws_1")
    await db.unreadState.put({
      ...seeded!,
      readMessageIds: { stream_1: ["m8", "m9", "m10"] },
      unreadCounts: { stream_1: 0 },
    })

    // The delayed earlier read-through-M5 response arrives.
    await applyReadStateSnapshotsIdb(
      "ws_1",
      [snapshot({ readMessageIds: ["m5"], lastReadEventId: "evt_5", lastReadSequence: "50", lastReadOrdinal: 5 })],
      touchedAt - 1000
    )

    // Frontier, overlay, and mirror survive EXACTLY — no regression.
    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
    })
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["m8", "m9", "m10"])
    expect(state?.unreadCounts.stream_1).toBe(0)
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "evt_0" })
  })

  it("applies normally when the frontier row predates the mutation departure", async () => {
    await seedUnreadState()
    await seedMembership()

    const startedAt = Date.now()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_2",
      lastReadSequence: "20",
      lastReadAt: "2026-01-01T00:00:02.000Z",
      _cachedAt: startedAt - 5000,
    })

    await applyReadStateSnapshotsIdb("ws_1", [snapshot()], startedAt)

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
    })
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["msg_5", "msg_7"])
  })

  it("applies normally when no frontier row exists yet", async () => {
    await seedUnreadState()
    await seedMembership()

    await applyReadStateSnapshotsIdb("ws_1", [snapshot()], Date.now())

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
    })
  })

  it("filters per stream — the untouched leg applies while the touched leg is skipped", async () => {
    // A conversation spans root + thread legs; ordering is per stream.
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 6, stream_2: 6 },
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: { stream_1: 10, stream_2: 10 },
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    const touchedAt = Date.now()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_later",
      lastReadSequence: "90",
      lastReadAt: "2026-01-01T00:00:09.000Z",
      _cachedAt: touchedAt,
    })

    await applyReadStateSnapshotsIdb(
      "ws_1",
      [
        snapshot({
          streamId: "stream_1",
          readMessageIds: ["m_old"],
          lastReadEventId: "evt_old",
          lastReadSequence: "30",
          lastReadOrdinal: 3,
        }),
        snapshot({
          streamId: "stream_2",
          readMessageIds: ["m_2"],
          lastReadEventId: "evt_2",
          lastReadSequence: "20",
          lastReadOrdinal: 2,
        }),
      ],
      touchedAt - 1000
    )

    // Touched leg skipped entirely; untouched leg applied.
    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_later",
      lastReadSequence: "90",
    })
    expect(await db.streamReadState.get("ws_1:stream_2")).toMatchObject({
      lastReadEventId: "evt_2",
      lastReadSequence: "20",
    })
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toBeUndefined()
    expect(state?.readMessageIds?.stream_2).toEqual(["m_2"])
    expect(state?.unreadCounts.stream_1).toBe(6)
    // stream_2: latest 10 − reconstructed read 4 − overlay 1.
    expect(state?.unreadCounts.stream_2).toBe(5)
  })
})

describe("commitReadStateSnapshot", () => {
  beforeEach(async () => {
    await Promise.all([
      db.unreadState.clear(),
      db.streamMemberships.clear(),
      db.streams.clear(),
      db.streamReadState.clear(),
    ])
  })

  it("mirrors the watermark into the workspace bootstrap cache and folds the counter", async () => {
    await seedUnreadState()
    await seedMembership()

    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: { stream_1: 6 },
      messageCounts: { stream_1: 10 },
      readMessageIds: {},
      unreadActivities: [],
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      streamMemberships: [{ streamId: "stream_1", lastReadEventId: "evt_0", lastReadSequence: "0" }],
    })

    commitReadStateSnapshot(queryClient, "ws_1", snapshot(), (m) => commitCounterMutation(queryClient, "ws_1", m))

    const cached = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      readMessageIds: Record<string, string[]>
      streamMemberships: Array<{ streamId: string; lastReadEventId: string | null; lastReadSequence?: string | null }>
    }>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.unreadCounts.stream_1).toBe(4)
    expect(cached?.readMessageIds.stream_1).toEqual(["msg_5", "msg_7"])
    expect(cached?.streamMemberships[0].lastReadEventId).toBe("evt_4")
    expect(cached?.streamMemberships[0].lastReadSequence).toBe("40")
    // The standalone frontier map mirrors the snapshot too (row presence is
    // what frontier readers prefer).
    const cachedWithReadState = cached as unknown as {
      streamReadState?: Record<string, { lastReadEventId: string | null; lastReadSequence: string | null }>
    }
    expect(cachedWithReadState.streamReadState?.stream_1?.lastReadEventId).toBe("evt_4")
    expect(cachedWithReadState.streamReadState?.stream_1?.lastReadSequence).toBe("40")

    await vi.waitFor(async () => {
      const readState = await db.streamReadState.get("ws_1:stream_1")
      expect(readState?.lastReadEventId).toBe("evt_4")
      expect(readState?.lastReadSequence).toBe("40")
    })
  })
})
