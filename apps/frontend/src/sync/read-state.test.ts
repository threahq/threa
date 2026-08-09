import { describe, it, expect, beforeEach, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import type { Socket } from "socket.io-client"
import { CatchUpBatch, commitCounterMutation } from "./catch-up-batch"
import { registerStreamSocketHandlers } from "./stream-sync"
import { registerWorkspaceSocketHandlers } from "./workspace-sync"
import { applyStreamsReadAllOrdinals } from "./unread-counters"
import {
  applyReadStateSnapshotsIdb,
  commitReadAll,
  commitReadStateSnapshot,
  resolveReadAllFrontiers,
  type ReadStateSnapshot,
} from "./read-state"
import { recordRowConfirmation, resetRowConfirmations } from "./bootstrap-diff"

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
    joinedAt: new Date().toISOString(),
    _cachedAt: Date.now(),
  })
}

describe("applyReadStateSnapshotsIdb", () => {
  beforeEach(async () => {
    resetRowConfirmations()
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

  it("SETs the overlay, recomputes unread by the invariant, and writes the frontier", async () => {
    await seedUnreadState()
    await seedMembership()

    await applyReadStateSnapshotsIdb("ws_1", [snapshot()])

    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["msg_5", "msg_7"])
    expect(state?.unreadCounts.stream_1).toBe(4) // 10 - 4 - 2

    // The frontier lands in stream_read_state — including with no membership row:
    // upserting read state is always safe. Membership is never touched on a read.
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
    resetRowConfirmations()
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

    // Frontier and overlay survive EXACTLY — no regression. Membership is
    // participation only and is never touched on a read.
    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
    })
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toEqual(["m8", "m9", "m10"])
    expect(state?.unreadCounts.stream_1).toBe(0)
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

  it("counts a diff-confirmed row as touched even though its _cachedAt was never rewritten", async () => {
    await seedUnreadState()
    await seedMembership()

    const startedAt = Date.now()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
      lastReadAt: "2026-01-01T00:00:10.000Z",
      _cachedAt: startedAt - 5000,
    })
    recordRowConfirmation("ws_1", "streamReadState", "ws_1:stream_1", startedAt + 1000)

    await applyReadStateSnapshotsIdb("ws_1", [snapshot()], startedAt)

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
    })
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

describe("resolveReadAllFrontiers (canonical max across memory + IDB)", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.streamReadState.clear()])
  })

  it("seeds from the incoming snapshot when no surface has a frontier (absence)", async () => {
    const queryClient = new QueryClient()
    const resolved = await resolveReadAllFrontiers(queryClient, "ws_1", [
      {
        streamId: "stream_9",
        lastReadEventId: "evt_1",
        lastReadSequence: "1",
        lastReadOrdinal: 1,
        lastReadAt: "2024-01-01T00:00:00.000Z",
      },
    ])
    expect(resolved).toEqual([
      {
        streamId: "stream_9",
        frontier: { lastReadEventId: "evt_1", lastReadSequence: "1", lastReadAt: "2024-01-01T00:00:00.000Z" },
      },
    ])
  })

  it("breaks equal sequences deterministically — the persisted IDB row wins the tie", async () => {
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_idb",
      lastReadSequence: "15",
      lastReadAt: "2024-01-01T00:00:00.000Z",
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    // Same sequence from the socket/HTTP payload — the fold replaces only on a
    // STRICTLY greater sequence, so the durable row is kept (never rewritten
    // with the incoming copy on a tie).
    const resolved = await resolveReadAllFrontiers(queryClient, "ws_1", [
      {
        streamId: "stream_1",
        lastReadEventId: "evt_incoming",
        lastReadSequence: "15",
        lastReadOrdinal: 15,
        lastReadAt: null,
      },
    ])
    expect(resolved[0]?.frontier.lastReadEventId).toBe("evt_idb")
    expect(resolved[0]?.frontier.lastReadSequence).toBe("15")
  })

  it("resolves nothing for a legacy payload without frontiers", async () => {
    expect(await resolveReadAllFrontiers(new QueryClient(), "ws_1", undefined)).toEqual([])
    expect(await resolveReadAllFrontiers(new QueryClient(), "ws_1", [])).toEqual([])
  })
})

describe("commitReadAll (atomic read-all application)", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.streamReadState.clear()])
  })

  it("converges every surface to the canonical highest frontier (IDB 20 beats cache 10 and incoming 15)", async () => {
    await seedUnreadState()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_20",
      lastReadSequence: "20",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: { stream_1: 6 },
      streamReadState: { stream_1: { lastReadEventId: "evt_10", lastReadSequence: "10", lastReadAt: null } },
    })
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_1"), {
      readState: { lastReadEventId: "evt_10", lastReadSequence: "10", lastReadAt: null },
    })

    await commitReadAll(
      queryClient,
      "ws_1",
      [{ streamId: "stream_1", lastReadOrdinal: 10 }],
      [
        {
          streamId: "stream_1",
          lastReadEventId: "evt_15",
          lastReadSequence: "15",
          lastReadOrdinal: 10,
          lastReadAt: null,
        },
      ]
    )

    // All three surfaces end at the canonical seq 20 — stale memory is lifted
    // to the persisted row instead of the incoming 15 writing over it.
    const readState = await db.streamReadState.get("ws_1:stream_1")
    expect(readState?.lastReadSequence).toBe("20")
    expect(readState?.lastReadEventId).toBe("evt_20")
    const bootstrap = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      streamReadState?: Record<string, { lastReadSequence: string | null }>
    }>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("20")
    const perStream = queryClient.getQueryData<{ readState?: { lastReadSequence: string | null } }>(
      streamKeys.bootstrap("ws_1", "stream_1")
    )
    expect(perStream?.readState?.lastReadSequence).toBe("20")
    // The counter clear rode the SAME transaction.
    expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(0)
    expect(bootstrap?.unreadCounts.stream_1).toBe(0)
  })

  it("rolls back the counter clear and publishes nothing when the frontier write fails (one transaction)", async () => {
    await seedUnreadState()
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: { stream_1: 6 },
      streamReadState: {},
    })

    const putSpy = vi.spyOn(db.streamReadState, "bulkPut").mockRejectedValue(new Error("idb boom"))
    try {
      await expect(
        commitReadAll(
          queryClient,
          "ws_1",
          [{ streamId: "stream_1", lastReadOrdinal: 10 }],
          [
            {
              streamId: "stream_1",
              lastReadEventId: "evt_10",
              lastReadSequence: "100",
              lastReadOrdinal: 10,
              lastReadAt: null,
            },
          ]
        )
      ).rejects.toThrow("idb boom")
    } finally {
      putSpy.mockRestore()
    }

    // No partial IDB writes: the counter clear shared the aborted transaction.
    const state = await db.unreadState.get("ws_1")
    expect(state?.unreadCounts.stream_1).toBe(6)
    // And the caches never published the state the IDB lacks.
    const bootstrap = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      streamReadState?: Record<string, unknown>
    }>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(6)
    expect(bootstrap?.streamReadState?.stream_1).toBeUndefined()
  })

  it("a legacy payload without frontiers clears the counter alone and touches no frontier rows", async () => {
    await seedUnreadState()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_old",
      lastReadSequence: "50",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { unreadCounts: { stream_1: 6 } })

    await commitReadAll(queryClient, "ws_1", [{ streamId: "stream_1", lastReadOrdinal: 10 }], undefined)

    expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(0)
    const readState = await db.streamReadState.get("ws_1:stream_1")
    expect(readState?.lastReadEventId).toBe("evt_old")
    expect(readState?.lastReadSequence).toBe("50")
  })
})

describe("CatchUpBatch read-all flush", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.streamReadState.clear(), db.streams.clear()])
  })

  it("persists the counter fold and the canonical frontier rows in the one flush transaction, publishing after commit", async () => {
    await seedUnreadState()
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { unreadCounts: { stream_1: 6 } })

    const batch = new CatchUpBatch(queryClient, "ws_1")
    batch.applyCounter((state) => applyStreamsReadAllOrdinals(state, [{ streamId: "stream_1", lastReadOrdinal: 10 }]))
    batch.applyReadAllFrontiers([
      {
        streamId: "stream_1",
        lastReadEventId: "evt_10",
        lastReadSequence: "100",
        lastReadOrdinal: 10,
        lastReadAt: null,
      },
    ])

    // Buffered, not written — nothing lands before the flush.
    expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(6)
    expect(await db.streamReadState.get("ws_1:stream_1")).toBeUndefined()

    await batch.flush()

    expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(0)
    expect((await db.streamReadState.get("ws_1:stream_1"))?.lastReadSequence).toBe("100")
    const bootstrap = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      streamReadState?: Record<string, { lastReadSequence: string | null }>
    }>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(0)
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("100")
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

  it("mirrors the frontier into the workspace bootstrap cache and folds the counter", async () => {
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
      streamMemberships: [{ streamId: "stream_1" }],
    })

    commitReadStateSnapshot(queryClient, "ws_1", snapshot(), (m) => commitCounterMutation(queryClient, "ws_1", m))

    const cached = queryClient.getQueryData<{
      unreadCounts: Record<string, number>
      readMessageIds: Record<string, string[]>
      streamReadState?: Record<string, { lastReadEventId: string | null; lastReadSequence: string | null }>
    }>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.unreadCounts.stream_1).toBe(4)
    expect(cached?.readMessageIds.stream_1).toEqual(["msg_5", "msg_7"])
    // The frontier map carries the snapshot (row presence is what frontier
    // readers resolve).
    expect(cached?.streamReadState?.stream_1?.lastReadEventId).toBe("evt_4")
    expect(cached?.streamReadState?.stream_1?.lastReadSequence).toBe("40")

    await vi.waitFor(async () => {
      const readState = await db.streamReadState.get("ws_1:stream_1")
      expect(readState?.lastReadEventId).toBe("evt_4")
      expect(readState?.lastReadSequence).toBe("40")
    })
  })
})

describe("replayed message:created entries and the preview write", () => {
  function createTestSocket() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>()
    const socket = {
      on(event: string, handler: (payload: unknown) => void) {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return this
      },
      off(event: string, handler: (payload: unknown) => void) {
        handlers.get(event)?.delete(handler)
        return this
      },
    } as unknown as Socket
    return {
      socket,
      async emit(event: string, payload: unknown) {
        await Promise.all(Array.from(handlers.get(event) ?? []).map((handler) => handler(payload)))
      },
    }
  }

  function entry(streamId: string, index: number) {
    return {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: `evt_replay_${index}`,
        streamId,
        sequence: String(100 + index),
        eventType: "message_created",
        payload: {
          messageId: `evt_replay_${index}`,
          contentMarkdown: `replayed ${index}`,
          contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: "2026-08-04T10:00:00.000Z",
      },
    }
  }

  async function replay(streamId: string): Promise<number> {
    await db.events.clear()
    await db.streams.clear()
    await db.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      rootStreamId: streamId,
      lastMessagePreview: null,
      _cachedAt: Date.now(),
    } as never)

    const previewWrites = vi.spyOn(db.streams, "update")
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())
    for (let index = 0; index < 3; index += 1) await emit("message:created", entry(streamId, index))
    cleanup()
    const calls = previewWrites.mock.calls.length
    previewWrites.mockRestore()
    return calls
  }

  it("live message:created delivery writes no preview — stream:activity is the only writer", async () => {
    expect(await replay("stream_replay_on")).toBe(0)
  })

  it("a catch-up replay's batched stream:activity previews land on flush, last write winning", async () => {
    const streamId = "stream_replay_batch"
    await db.streams.clear()
    await db.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      rootStreamId: streamId,
      lastMessagePreview: null,
      _cachedAt: Date.now(),
    } as never)

    const queryClient = new QueryClient()
    const batch = new CatchUpBatch(queryClient, "ws_1")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
      getCatchUpBatch: () => batch,
    })

    const activity = (content: string, createdAt: string) => ({
      workspaceId: "ws_1",
      streamId,
      authorId: "user_1",
      sequence: "100",
      messageOrdinal: 1,
      lastMessagePreview: { authorId: "user_1", authorType: "user" as const, content, createdAt },
    })

    await emit("stream:activity", activity("first replayed", "2026-08-04T10:00:00.000Z"))
    await emit("stream:activity", activity("last replayed", "2026-08-04T10:00:01.000Z"))

    // Buffered, not written — the replay must not touch the row per entry.
    expect((await db.streams.get(streamId))?.lastMessagePreview).toBeNull()

    await batch.flush()

    expect((await db.streams.get(streamId))?.lastMessagePreview).toEqual({
      authorId: "user_1",
      authorType: "user",
      content: "last replayed",
      createdAt: "2026-08-04T10:00:01.000Z",
    })

    cleanup()
  })
})
