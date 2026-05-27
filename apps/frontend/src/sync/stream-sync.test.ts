import { describe, it, expect, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Socket } from "socket.io-client"
import { db } from "@/db"
import {
  applyStreamBootstrap,
  getLatestPersistedSequence,
  registerStreamSocketHandlers,
  toCachedStreamBootstrap,
  updateMessageEvent,
  type CachedStreamBootstrap,
} from "./stream-sync"
import { streamKeys } from "@/hooks/use-streams"
import type { BotRuntimePresenceSummary, StreamBootstrap, StreamEvent } from "@threa/types"

// With fake-indexeddb loaded in test setup, Dexie works against a real
// in-memory IndexedDB. No mocks needed — tests exercise actual queries.

function makeEvent(overrides: Partial<StreamEvent> & { id: string; streamId: string; sequence: string }): StreamEvent {
  return {
    eventType: "message_created",
    payload: { messageId: overrides.id, contentMarkdown: "test" },
    actorId: "user_1",
    actorType: "user",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeBootstrap(events: StreamEvent[], streamId: string): StreamBootstrap {
  return {
    stream: {
      id: streamId,
      workspaceId: "ws_1",
      type: "channel",
      displayName: "test",
      slug: "test",
      description: null,
      visibility: "public",
      parentStreamId: null,
      parentMessageId: null,
      rootStreamId: null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    },
    events,
    members: [],
    botMemberIds: [],
    membership: null as unknown as StreamBootstrap["membership"],
    latestSequence: events.length > 0 ? events[events.length - 1].sequence : "0",
    hasOlderEvents: false,
    syncMode: "replace",
    unreadCount: 0,
    mentionCount: 0,
    activityCount: 0,
  }
}

describe("applyStreamBootstrap (real IndexedDB)", () => {
  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
  })

  it("preserves a socket-delivered event that arrived during the bootstrap fetch (race condition)", async () => {
    const streamId = "stream_race"

    // Simulate: socket handler wrote event X to IDB while bootstrap was in flight
    const socketEvent = makeEvent({ id: "evt_X", streamId, sequence: "200" })
    await db.events.put({ ...socketEvent, workspaceId: "ws_1", _sequenceNum: 200, _cachedAt: Date.now() })

    // Bootstrap returns events A(100) and B(150) — snapshot taken before X existed
    const bootstrapEvents = [
      makeEvent({ id: "evt_A", streamId, sequence: "100" }),
      makeEvent({ id: "evt_B", streamId, sequence: "150" }),
    ]
    const bootstrap = makeBootstrap(bootstrapEvents, streamId)

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    // All three events must be in IDB
    const allEvents = await db.events.where("streamId").equals(streamId).toArray()
    const ids = allEvents.map((e) => e.id).sort()
    expect(ids).toEqual(["evt_A", "evt_B", "evt_X"])
  })

  it("preserves events from previous sessions (IDB is append-only)", async () => {
    const streamId = "stream_prev"

    // Old event from a previous session
    const oldEvent = makeEvent({ id: "evt_old", streamId, sequence: "50" })
    await db.events.put({ ...oldEvent, workspaceId: "ws_1", _sequenceNum: 50, _cachedAt: Date.now() - 86400000 })

    const bootstrap = makeBootstrap([makeEvent({ id: "evt_A", streamId, sequence: "100" })], streamId)

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.events.get("evt_old")).toBeDefined()
    expect(await db.events.get("evt_A")).toBeDefined()
  })

  it("prunes stale cached events that fall inside the fetched bootstrap window", async () => {
    const streamId = "stream_stale_window"

    await db.events.bulkPut([
      {
        ...makeEvent({ id: "evt_old_page", streamId, sequence: "50" }),
        workspaceId: "ws_1",
        _sequenceNum: 50,
        _cachedAt: Date.now() - 1000,
      },
      {
        ...makeEvent({
          id: "evt_ghost",
          streamId,
          sequence: "120",
          payload: { messageId: "evt_ghost", contentMarkdown: "ghost bot message" },
        }),
        workspaceId: "ws_1",
        _sequenceNum: 120,
        _cachedAt: Date.now() - 1000,
      },
      {
        ...makeEvent({ id: "evt_socket_new", streamId, sequence: "200" }),
        workspaceId: "ws_1",
        _sequenceNum: 200,
        _cachedAt: Date.now(),
      },
    ])

    const bootstrap = makeBootstrap(
      [makeEvent({ id: "evt_A", streamId, sequence: "100" }), makeEvent({ id: "evt_B", streamId, sequence: "150" })],
      streamId
    )

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.events.get("evt_old_page")).toBeDefined()
    expect(await db.events.get("evt_A")).toBeDefined()
    expect(await db.events.get("evt_B")).toBeDefined()
    expect(await db.events.get("evt_socket_new")).toBeDefined()
    expect(await db.events.get("evt_ghost")).toBeUndefined()
  })

  it("removes stale optimistic events (temp_*) not in the send queue", async () => {
    const streamId = "stream_stale"

    // Stale optimistic event — NOT in pendingMessages
    await db.events.put({
      id: "temp_stale",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "message_created",
      payload: {},
      actorId: null,
      actorType: null,
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })

    const bootstrap = makeBootstrap([makeEvent({ id: "evt_A", streamId, sequence: "100" })], streamId)
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.events.get("temp_stale")).toBeUndefined()
    expect(await db.events.get("evt_A")).toBeDefined()
  })

  it("preserves payload fields from a socket update when the bootstrap omits them", async () => {
    // Backend bootstrap takes getThreadsWithReplyCounts and getThreadSummaries
    // as separate non-transactional snapshots. If a reply commits between
    // them, the bootstrap can include threadId+replyCount but omit
    // threadSummary. Meanwhile the message:updated socket handler has already
    // written the full threadSummary into IDB. Per-field merge must keep the
    // socket-written threadSummary in place.
    const streamId = "stream_merge_omit"

    const threadSummary = {
      participants: [{ id: "user_2", name: "Alice", avatarUrl: null }],
      latestReply: {
        actor: { id: "user_2", name: "Alice", avatarUrl: null },
        contentMarkdown: "first reply",
      },
      lastReplyAt: new Date().toISOString(),
    }

    await db.events.put({
      ...makeEvent({
        id: "evt_parent",
        streamId,
        sequence: "100",
        payload: {
          messageId: "evt_parent",
          contentMarkdown: "parent",
          threadId: "stream_thread",
          replyCount: 1,
          threadSummary,
        },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
    })

    const bootstrap = makeBootstrap(
      [
        makeEvent({
          id: "evt_parent",
          streamId,
          sequence: "100",
          payload: {
            messageId: "evt_parent",
            contentMarkdown: "parent",
            threadId: "stream_thread",
            replyCount: 1,
            // threadSummary deliberately missing — snapshot race
          },
        }),
      ],
      streamId
    )

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_parent")
    expect(merged?.payload).toMatchObject({
      threadId: "stream_thread",
      replyCount: 1,
      threadSummary,
    })
  })

  it("overwrites existing payload fields when the bootstrap explicitly carries them", async () => {
    // Symmetry check: when the bootstrap snapshot is fresher than the IDB
    // value (e.g. the user opened a stream that already had thread activity
    // from another session), bootstrap fields should win.
    const streamId = "stream_merge_present"

    await db.events.put({
      ...makeEvent({
        id: "evt_parent",
        streamId,
        sequence: "100",
        payload: { messageId: "evt_parent", contentMarkdown: "parent", replyCount: 0 },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
    })

    const freshSummary = {
      participants: [{ id: "user_2", name: "Alice", avatarUrl: null }],
      latestReply: {
        actor: { id: "user_2", name: "Alice", avatarUrl: null },
        contentMarkdown: "fresh from server",
      },
      lastReplyAt: new Date().toISOString(),
    }

    const bootstrap = makeBootstrap(
      [
        makeEvent({
          id: "evt_parent",
          streamId,
          sequence: "100",
          payload: {
            messageId: "evt_parent",
            contentMarkdown: "parent",
            threadId: "stream_thread",
            replyCount: 3,
            threadSummary: freshSummary,
          },
        }),
      ],
      streamId
    )

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_parent")
    expect(merged?.payload).toMatchObject({
      threadId: "stream_thread",
      replyCount: 3,
      threadSummary: freshSummary,
    })
  })

  it("preserves a row whose _patchedAt is newer than the bootstrap snapshot (stale-but-present field)", async () => {
    // CodeRabbit's race: bootstrap CARRIES a value for a field that the
    // socket already updated more recently (e.g. reactions enrichment ran
    // before a reaction:added committed; bootstrap therefore ships an
    // older reactions map than what's in IDB). Per-field merge alone would
    // overwrite the fresher value because bootstrap "wins" on the spread.
    // The freshness watermark catches this case: existing._patchedAt is
    // greater than snapshotMs, so the merge is skipped entirely.
    const streamId = "stream_freshness_skip"

    const snapshotAt = new Date(Date.now() - 1000).toISOString()
    const fresherPatchAt = Date.now() // socket patch happened after the snapshot

    await db.events.put({
      ...makeEvent({
        id: "evt_M",
        streamId,
        sequence: "100",
        payload: {
          messageId: "evt_M",
          contentMarkdown: "react to me",
          // The reaction the socket just added — bootstrap doesn't know yet.
          reactions: { "🎉": ["user_2"] },
        },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: fresherPatchAt,
      _patchedAt: fresherPatchAt,
    })

    const bootstrap = {
      ...makeBootstrap(
        [
          makeEvent({
            id: "evt_M",
            streamId,
            sequence: "100",
            payload: {
              messageId: "evt_M",
              contentMarkdown: "react to me",
              // Stale enrichment — empty reactions, taken before the patch.
              reactions: {},
            },
          }),
        ],
        streamId
      ),
      snapshotAt,
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_M")
    expect((merged?.payload as { reactions: Record<string, string[]> }).reactions).toEqual({ "🎉": ["user_2"] })
  })

  it("applies bootstrap normally when _patchedAt is older than the snapshot", async () => {
    // Symmetry check: a patch that landed BEFORE the snapshot means the
    // backend's enrichment had a chance to read the patched state, so the
    // bootstrap value is canonical and should win on the merge.
    const streamId = "stream_freshness_apply"

    const oldPatchAt = Date.now() - 5000
    const snapshotAt = new Date().toISOString()

    await db.events.put({
      ...makeEvent({
        id: "evt_M",
        streamId,
        sequence: "100",
        payload: { messageId: "evt_M", contentMarkdown: "old", reactions: { "👀": ["user_3"] } },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: oldPatchAt,
      _patchedAt: oldPatchAt,
    })

    const bootstrap = {
      ...makeBootstrap(
        [
          makeEvent({
            id: "evt_M",
            streamId,
            sequence: "100",
            payload: {
              messageId: "evt_M",
              contentMarkdown: "old",
              reactions: { "👀": ["user_3"], "🚀": ["user_4"] },
            },
          }),
        ],
        streamId
      ),
      snapshotAt,
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_M")
    expect((merged?.payload as { reactions: Record<string, string[]> }).reactions).toEqual({
      "👀": ["user_3"],
      "🚀": ["user_4"],
    })
  })

  it("preserves _patchedAt across bootstrap merge so subsequent bootstraps still see the watermark", async () => {
    // After a merge that doesn't skip (bootstrap is canonical for this
    // window), the row's _patchedAt must carry over — otherwise the next
    // bootstrap that arrives during a still-newer socket patch would lose
    // the freshness signal.
    const streamId = "stream_watermark_carry"

    const patchAt = Date.now() - 3000
    const snapshotAt = new Date().toISOString() // newer than patch

    await db.events.put({
      ...makeEvent({
        id: "evt_M",
        streamId,
        sequence: "100",
        payload: { messageId: "evt_M", contentMarkdown: "x", replyCount: 1 },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: patchAt,
      _patchedAt: patchAt,
    })

    const bootstrap = {
      ...makeBootstrap(
        [
          makeEvent({
            id: "evt_M",
            streamId,
            sequence: "100",
            payload: { messageId: "evt_M", contentMarkdown: "x", replyCount: 2 },
          }),
        ],
        streamId
      ),
      snapshotAt,
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_M")
    expect(merged?._patchedAt).toBe(patchAt)
    expect((merged?.payload as { replyCount: number }).replyCount).toBe(2)
  })

  it("falls back to per-field merge when snapshotAt is missing (older response)", async () => {
    // Backwards compat: cached responses written before snapshotAt landed
    // on the wire don't carry it. The merge path should still work and
    // behave like the previous PR — preserve fields that bootstrap omits.
    const streamId = "stream_legacy"

    const fresherPatchAt = Date.now()

    await db.events.put({
      ...makeEvent({
        id: "evt_M",
        streamId,
        sequence: "100",
        payload: {
          messageId: "evt_M",
          contentMarkdown: "x",
          threadSummary: { participants: [], latestReply: null, lastReplyAt: null },
        },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: fresherPatchAt,
      _patchedAt: fresherPatchAt,
    })

    // No snapshotAt on the bootstrap.
    const bootstrap = makeBootstrap(
      [
        makeEvent({
          id: "evt_M",
          streamId,
          sequence: "100",
          payload: { messageId: "evt_M", contentMarkdown: "x", threadId: "thread_1", replyCount: 1 },
        }),
      ],
      streamId
    )

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const merged = await db.events.get("evt_M")
    const payload = merged?.payload as Record<string, unknown>
    // Per-field merge: bootstrap fields applied, omitted fields preserved.
    expect(payload.threadId).toBe("thread_1")
    expect(payload.replyCount).toBe(1)
    expect(payload.threadSummary).toEqual({ participants: [], latestReply: null, lastReplyAt: null })
  })

  it("preserves optimistic events that are still in the send queue", async () => {
    const streamId = "stream_pending"

    // Optimistic event — still in pendingMessages
    await db.events.put({
      id: "temp_pending",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "message_created",
      payload: {},
      actorId: null,
      actorType: null,
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })
    await db.pendingMessages.add({
      clientId: "temp_pending",
      workspaceId: "ws_1",
      streamId,
      content: "hello",
      contentFormat: "markdown",
      createdAt: Date.now(),
      retryCount: 0,
    })

    const bootstrap = makeBootstrap([makeEvent({ id: "evt_A", streamId, sequence: "100" })], streamId)
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.events.get("temp_pending")).toBeDefined()
    expect(await db.events.get("evt_A")).toBeDefined()
  })

  it("writes stream metadata to IDB", async () => {
    const streamId = "stream_meta"
    const bootstrap = makeBootstrap([], streamId)

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const stream = await db.streams.get(streamId)
    expect(stream).toBeDefined()
    expect(stream?.workspaceId).toBe("ws_1")
    expect(stream?.displayName).toBe("test")
  })

  it("appends reconnect catch-up events without pruning the existing visible window", async () => {
    const streamId = "stream_append"
    const initialBootstrap = makeBootstrap(
      [makeEvent({ id: "evt_A", streamId, sequence: "100" }), makeEvent({ id: "evt_B", streamId, sequence: "150" })],
      streamId
    )
    await applyStreamBootstrap("ws_1", streamId, initialBootstrap)

    const appendBootstrap = {
      ...makeBootstrap([makeEvent({ id: "evt_C", streamId, sequence: "200" })], streamId),
      syncMode: "append" as const,
      latestSequence: "200",
    }

    await applyStreamBootstrap("ws_1", streamId, appendBootstrap)

    const allEvents = await db.events.where("streamId").equals(streamId).sortBy("_sequenceNum")
    expect(allEvents.map((event) => event.id)).toEqual(["evt_A", "evt_B", "evt_C"])
  })

  it("increments windowVersion only for reconnect replace responses", () => {
    const streamId = "stream_window"
    const initial = toCachedStreamBootstrap(
      makeBootstrap([makeEvent({ id: "evt_A", streamId, sequence: "10" })], streamId)
    )
    const append = toCachedStreamBootstrap(
      {
        ...makeBootstrap([makeEvent({ id: "evt_B", streamId, sequence: "20" })], streamId),
        syncMode: "append",
        latestSequence: "20",
      },
      initial,
      { incrementWindowVersionOnReplace: false }
    )
    const replace = toCachedStreamBootstrap(
      makeBootstrap([makeEvent({ id: "evt_C", streamId, sequence: "30" })], streamId),
      append,
      { incrementWindowVersionOnReplace: true }
    )

    expect(initial.windowVersion).toBe(0)
    expect(append.windowVersion).toBe(0)
    expect(replace.windowVersion).toBe(1)
  })

  it("keeps the newer cached latestSequence when appending an older catch-up response", () => {
    const streamId = "stream_latest"
    const current = toCachedStreamBootstrap(
      {
        ...makeBootstrap([makeEvent({ id: "evt_C", streamId, sequence: "30" })], streamId),
        latestSequence: "30",
      },
      undefined,
      { incrementWindowVersionOnReplace: false }
    )
    const append = toCachedStreamBootstrap(
      {
        ...makeBootstrap([makeEvent({ id: "evt_B", streamId, sequence: "20" })], streamId),
        syncMode: "append",
        latestSequence: "20",
      },
      current,
      { incrementWindowVersionOnReplace: false }
    )

    expect(append.latestSequence).toBe("30")
    expect(append.events.map((event) => event.id)).toEqual(["evt_B", "evt_C"])
  })

  it("keeps E2E ciphertext + envelope at rest in IDB (no sync-time decrypt)", async () => {
    // Phase 3.5: bootstrap no longer decrypts E2E payloads at write time. The
    // wire shape (placeholder + ciphertext + envelope) must round-trip into
    // db.events unchanged so the render-time cache is the only surface that
    // ever holds plaintext.
    const streamId = "stream_e2e_atrest"
    const e2eEvent = makeEvent({
      id: "evt_e2e",
      streamId,
      sequence: "100",
      payload: {
        messageId: "msg_e2e",
        contentMarkdown: "​",
        ciphertext: "base64-ciphertext",
        envelope: { kdfParams: { alg: "argon2id" } },
      },
    })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([e2eEvent], streamId))

    const persisted = await db.events.get(e2eEvent.id)
    const payload = persisted?.payload as {
      contentMarkdown: string
      ciphertext?: string
      envelope?: unknown
    }
    expect(payload.contentMarkdown).toBe("​")
    expect(payload.ciphertext).toBe("base64-ciphertext")
    expect(payload.envelope).toEqual({ kdfParams: { alg: "argon2id" } })
  })

  it("derives the reconnect cursor from the latest persisted non-optimistic event", async () => {
    const streamId = "stream_cursor"
    await db.events.bulkPut([
      {
        ...makeEvent({ id: "evt_real", streamId, sequence: "200" }),
        workspaceId: "ws_1",
        _sequenceNum: 200,
        _cachedAt: Date.now(),
      },
      {
        ...makeEvent({ id: "temp_pending", streamId, sequence: `${Date.now()}` }),
        workspaceId: "ws_1",
        _sequenceNum: Date.now(),
        _status: "pending",
        _cachedAt: Date.now(),
      },
    ])

    expect(await getLatestPersistedSequence(streamId)).toBe("200")
  })
})

// ---------------------------------------------------------------------------
// updateMessageEvent — atomic payload updates
// ---------------------------------------------------------------------------

describe("updateMessageEvent", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  it("updates a message payload in place", async () => {
    const streamId = "stream_update"
    const messageId = "msg_1"
    await db.events.put({
      ...makeEvent({ id: "evt_1", streamId, sequence: "100", payload: { messageId, contentMarkdown: "hello" } }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
    })

    await updateMessageEvent(streamId, messageId, (p) => ({ ...p, replyCount: 5 }))

    const event = await db.events.get("evt_1")
    expect((event?.payload as Record<string, unknown>).replyCount).toBe(5)
  })

  it("stamps _patchedAt on every update so bootstrap can see the freshness watermark", async () => {
    const streamId = "stream_patched_at"
    const messageId = "msg_patched"
    const before = Date.now()
    await db.events.put({
      ...makeEvent({ id: "evt_patched", streamId, sequence: "100", payload: { messageId, contentMarkdown: "x" } }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: before - 10000,
    })

    await updateMessageEvent(streamId, messageId, (p) => ({ ...p, replyCount: 1 }))

    const event = await db.events.get("evt_patched")
    expect(event?._patchedAt).toBeDefined()
    expect(event?._patchedAt).toBeGreaterThanOrEqual(before)
  })

  it("does not lose fields when multiple concurrent updates target the same message", async () => {
    const streamId = "stream_race_update"
    const messageId = "msg_race"
    await db.events.put({
      ...makeEvent({ id: "evt_race", streamId, sequence: "100", payload: { messageId, contentMarkdown: "hello" } }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
    })

    // Simulate the race that happens when messages:moved, stream:created and
    // message:updated socket handlers all update the same parent message
    // concurrently. With the old read-then-update implementation the last
    // write would overwrite earlier ones and lose fields.
    await Promise.all([
      updateMessageEvent(streamId, messageId, (p) => ({
        ...p,
        replyCount: 3,
        threadSummary: { lastReplyContentMarkdown: "hi", participantIds: ["u1"] },
      })),
      updateMessageEvent(streamId, messageId, (p) => ({
        ...p,
        threadId: "thread_123",
      })),
    ])

    const event = await db.events.get("evt_race")
    const payload = event?.payload as Record<string, unknown>
    expect(payload.threadId).toBe("thread_123")
    expect(payload.replyCount).toBe(3)
    expect(payload.threadSummary).toEqual({ lastReplyContentMarkdown: "hi", participantIds: ["u1"] })
  })
})

// ---------------------------------------------------------------------------
// Read-side filtering (the logic inside useEvents useMemo)
// ---------------------------------------------------------------------------

describe("event display filtering", () => {
  function filterEventsForDisplay(idbEvents: Array<{ sequence: string; _status?: string }>, bootstrapFloor: bigint) {
    return idbEvents.filter((e) => {
      if (e._status === "pending" || e._status === "failed") return true
      return BigInt(e.sequence) >= bootstrapFloor
    })
  }

  it("includes socket events newer than bootstrap window", () => {
    const events = [
      { sequence: "50", _status: undefined },
      { sequence: "100", _status: undefined },
      { sequence: "150", _status: undefined },
      { sequence: "200", _status: undefined },
    ]
    const displayed = filterEventsForDisplay(events, 100n)
    expect(displayed.map((e) => e.sequence)).toEqual(["100", "150", "200"])
  })

  it("excludes events from previous sessions below bootstrap window", () => {
    const events = [
      { sequence: "10", _status: undefined },
      { sequence: "50", _status: undefined },
      { sequence: "100", _status: undefined },
    ]
    const displayed = filterEventsForDisplay(events, 100n)
    expect(displayed).toEqual([{ sequence: "100", _status: undefined }])
  })

  it("includes pending/failed optimistic events regardless of sequence", () => {
    const events = [
      { sequence: "50", _status: undefined },
      { sequence: "100", _status: undefined },
      { sequence: "999999", _status: "pending" },
      { sequence: "999998", _status: "failed" },
    ]
    const displayed = filterEventsForDisplay(events, 100n)
    expect(displayed).toHaveLength(3)
  })

  it("the race condition scenario end-to-end", () => {
    const idbEvents = [
      { sequence: "30", _status: undefined },
      { sequence: "100", _status: undefined },
      { sequence: "120", _status: undefined },
      { sequence: "150", _status: undefined },
      { sequence: "200", _status: undefined },
    ]
    const displayed = filterEventsForDisplay(idbEvents, 100n)
    expect(displayed.map((e) => e.sequence)).toEqual(["100", "120", "150", "200"])
  })
})

describe("registerStreamSocketHandlers — bot_runtime:presence cache patching", () => {
  // Active Pi runtimes touch presence on every poll/step (multiple times per
  // second). The bootstrap cache must not be patched when only `lastSeenAt`
  // advanced, or every active session bursts cascade re-renders through
  // StreamContent and the composer subtree — that's what was making mobile
  // typing feel laggy.

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
      emit(event: string, payload: unknown) {
        handlers.get(event)?.forEach((handler) => handler(payload))
      },
    }
  }

  function seedBootstrap(
    queryClient: QueryClient,
    streamId: string,
    presence: Record<string, BotRuntimePresenceSummary | null>
  ): CachedStreamBootstrap {
    const base = makeBootstrap([], streamId)
    const cached: CachedStreamBootstrap = {
      ...base,
      botRuntimePresence: presence,
      windowVersion: 0,
    }
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", streamId), cached)
    return cached
  }

  function makePresence(overrides: Partial<BotRuntimePresenceSummary> = {}): BotRuntimePresenceSummary {
    return {
      botId: "bot_1",
      runtimeKind: "pi-local",
      instanceId: "inst_1",
      displayName: "Pi-on-laptop",
      status: "busy",
      acceptingInvocations: false,
      statusText: "Searching the workspace…",
      lastSeenAt: new Date(1700000000000).toISOString(),
      ...overrides,
    }
  }

  it("does not patch the bootstrap cache when only lastSeenAt advances", () => {
    const queryClient = new QueryClient()
    const streamId = "stream_presence_skip"
    const initial = seedBootstrap(queryClient, streamId, { bot_1: makePresence() })
    const before = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    emit("bot_runtime:presence", {
      workspaceId: "ws_1",
      streamId,
      botId: "bot_1",
      presence: makePresence({ lastSeenAt: new Date(1700000001000).toISOString() }),
    })

    // Same reference both ways — the cache value must stay identical so
    // downstream `useStreamBootstrap` consumers don't re-render.
    const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
    expect(after).toBe(before)
    expect(after).toBe(initial)

    cleanup()
  })

  it("patches the cache when statusText changes", () => {
    const queryClient = new QueryClient()
    const streamId = "stream_presence_text"
    seedBootstrap(queryClient, streamId, { bot_1: makePresence({ statusText: "Searching the workspace…" }) })
    const before = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    emit("bot_runtime:presence", {
      workspaceId: "ws_1",
      streamId,
      botId: "bot_1",
      presence: makePresence({
        statusText: "Composing reply…",
        lastSeenAt: new Date(1700000001000).toISOString(),
      }),
    })

    const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
    expect(after).not.toBe(before)
    expect(after?.botRuntimePresence?.bot_1?.statusText).toBe("Composing reply…")

    cleanup()
  })

  it("patches the cache when status flips even if statusText is unchanged", () => {
    const queryClient = new QueryClient()
    const streamId = "stream_presence_status"
    seedBootstrap(queryClient, streamId, { bot_1: makePresence({ status: "busy" }) })
    const before = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    emit("bot_runtime:presence", {
      workspaceId: "ws_1",
      streamId,
      botId: "bot_1",
      presence: makePresence({
        status: "available",
        acceptingInvocations: true,
        lastSeenAt: new Date(1700000002000).toISOString(),
      }),
    })

    const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
    expect(after).not.toBe(before)
    expect(after?.botRuntimePresence?.bot_1?.status).toBe("available")

    cleanup()
  })

  it("ignores presence events for a different stream", () => {
    const queryClient = new QueryClient()
    const streamId = "stream_presence_other"
    seedBootstrap(queryClient, streamId, { bot_1: makePresence() })
    const before = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    emit("bot_runtime:presence", {
      workspaceId: "ws_1",
      streamId: "stream_other",
      botId: "bot_1",
      presence: makePresence({ statusText: "Different stream, ignore me" }),
    })

    const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
    expect(after).toBe(before)

    cleanup()
  })
})
