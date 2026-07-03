import { describe, it, expect, beforeEach } from "vitest"
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
    await Promise.all([db.unreadState.clear(), db.streamMemberships.clear(), db.streams.clear()])
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

describe("commitReadStateSnapshot", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.streamMemberships.clear(), db.streams.clear()])
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
  })
})
