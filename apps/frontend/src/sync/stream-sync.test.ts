import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Socket } from "socket.io-client"
import { db, type CachedEvent } from "@/db"
import {
  applyStreamBootstrap,
  detectSequenceGap,
  getLatestPersistedSequence,
  getPersistedTail,
  optimisticReplyCountUpdate,
  preserveBakedInAppData,
  registerStreamSocketHandlers,
  toCachedStreamBootstrap,
  updateEventByAnchor,
  updateMessageEvent,
  updateMemoEmbedSummary,
  type CachedStreamBootstrap,
} from "./stream-sync"
import { streamKeys } from "@/hooks/use-streams"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { commandsApi } from "@/api"
import { clearDecryptCache, getCachedDecryption } from "@/lib/crypto/decrypt-cache"
import { NO_CAPTURE, PerfCapture, armPerfCapture } from "@/lib/perf/capture"
import { applyStreamReadOrdinal } from "./unread-counters"
import { sharedMessageSlotKey } from "@threa/types"
import {
  __resetAgentActivityStore,
  getAgentActivityForStream,
  getAgentSession,
  upsertAgentSession,
} from "@/stores/agent-activity-store"
import type {
  AttachmentSummary,
  BotRuntimePresenceSummary,
  LinkPreviewSummary,
  Stream,
  SharedMessageSlot,
  SlotMap,
  StreamBootstrap,
  StreamEvent,
  StreamMember,
  ThreadSummary,
  WorkspaceBootstrap,
} from "@threa/types"

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
    __resetAgentActivityStore()
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

  it("clears sidebar activity from the same terminal event applied to the stream", async () => {
    const streamId = "stream_agent"
    upsertAgentSession("ws_1", {
      sessionId: "session_settled",
      streamId,
      rootStreamId: streamId,
      personaName: "Ariadne",
      startedAt: "2026-08-27T11:24:59.119Z",
    })
    const completed = makeEvent({
      id: "evt_completed",
      streamId,
      sequence: "2",
      eventType: "agent_session:completed",
      payload: {
        sessionId: "session_settled",
        stepCount: 2,
        messageCount: 1,
        duration: 10_000,
        completedAt: "2026-08-27T11:25:37.971Z",
      },
    })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([completed], streamId))

    expect(await db.events.get(completed.id)).toMatchObject(completed)
    expect(getAgentActivityForStream("ws_1", streamId)).toEqual([])
  })

  it("does not regress live progress from a bootstrap start snapshot", async () => {
    const streamId = "stream_running_agent"
    upsertAgentSession("ws_1", {
      sessionId: "session_running",
      streamId,
      rootStreamId: streamId,
      personaName: "Ariadne",
      startedAt: "2026-08-27T11:24:59.119Z",
      stepCount: 4,
      messageCount: 1,
    })
    const started = makeEvent({
      id: "evt_started",
      streamId,
      sequence: "1",
      eventType: "agent_session:started",
      payload: {
        sessionId: "session_running",
        personaId: "persona_ariadne",
        personaName: "Ariadne",
        triggerMessageId: "msg_trigger",
        stepCount: 2,
        messageCount: 0,
        startedAt: "2026-08-27T11:24:59.119Z",
      },
    })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([started], streamId))

    expect(getAgentSession("ws_1", "session_running")).toMatchObject({ stepCount: 4, messageCount: 1 })
  })

  it("does not restore a cached start outside the trusted replace window", async () => {
    const streamId = "stream_old_agent"
    const oldStarted = makeEvent({
      id: "evt_old_started",
      streamId,
      sequence: "1",
      eventType: "agent_session:started",
      payload: {
        sessionId: "session_settled",
        personaId: "persona_ariadne",
        personaName: "Ariadne",
        triggerMessageId: "msg_old_trigger",
        startedAt: "2026-08-27T11:24:59.119Z",
      },
    })
    await db.events.put({
      ...oldStarted,
      workspaceId: "ws_1",
      _sequenceNum: 1,
      _cachedAt: Date.now() - 60_000,
    })
    const current = makeEvent({ id: "evt_current", streamId, sequence: "100" })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([current], streamId))

    expect(await db.events.get(oldStarted.id)).toBeDefined()
    expect(getAgentActivityForStream("ws_1", streamId)).toEqual([])
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
    // threadSummary. Meanwhile the thread:updated socket handler has already
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

    const bootstrap = makeBootstrap(
      [makeEvent({ id: "evt_A", streamId, sequence: "100", createdAt: "2020-01-01T00:00:00.000Z" })],
      streamId
    )
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect((await db.events.get("temp_pending"))?._anchorSequenceNum).toBe(100)
    expect(await db.events.get("evt_A")).toBeDefined()
  })

  it("anchors a legacy failed row by its chronology during bootstrap", async () => {
    const streamId = "stream_legacy_failed"
    await db.events.put({
      id: "temp_legacy_failed",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "command_dispatched",
      payload: { commandId: "temp_legacy_failed", name: "thinking", args: "low", status: "dispatched" },
      actorId: "user_1",
      actorType: "user",
      createdAt: "2026-01-01T20:30:00.000Z",
      _status: "failed",
      _cachedAt: 1,
    })
    const before = makeEvent({
      id: "evt_before",
      streamId,
      sequence: "100",
      createdAt: "2026-01-01T20:00:00.000Z",
    })
    const after = makeEvent({
      id: "evt_after",
      streamId,
      sequence: "101",
      createdAt: "2026-01-01T21:00:00.000Z",
    })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([before, after], streamId))

    expect((await db.events.get("temp_legacy_failed"))?._anchorSequenceNum).toBe(100)
  })

  it("collapses an optimistic command when bootstrap carries its idempotent server copy", async () => {
    const streamId = "stream_command_reload"
    await db.events.put({
      id: "temp_command",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      _anchorSequenceNum: 10,
      eventType: "command_dispatched",
      payload: { commandId: "temp_command", name: "stop", args: "", status: "dispatched" },
      actorId: "user_1",
      actorType: "user",
      createdAt: "2026-01-01T20:30:00.000Z",
      _status: "pending",
      _cachedAt: 1,
    })
    await db.events.put({
      ...((await db.events.get("temp_command")) as CachedEvent),
      id: "temp_command:failed",
      eventType: "command_failed",
      payload: { commandId: "temp_command", error: "Timed out" },
      _status: "failed",
    })
    await db.pendingOperations.add({
      id: "op_command",
      workspaceId: "ws_1",
      type: "dispatch_command",
      payload: { streamId, command: "/stop", optimisticEventId: "temp_command" },
      createdAt: 1,
      retryCount: 0,
      startedAt: 2,
    })
    const serverCopy = makeEvent({ id: "evt_command", streamId, sequence: "11" })
    serverCopy.eventType = "command_dispatched"
    serverCopy.payload = {
      commandId: "cmd_1",
      clientCommandId: "temp_command",
      name: "stop",
      args: "",
      status: "dispatched",
    }

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([serverCopy], streamId))

    expect({
      server: (await db.events.get("evt_command"))?.id,
      optimistic: await db.events.get("temp_command"),
      failed: await db.events.get("temp_command:failed"),
      operation: await db.pendingOperations.get("op_command"),
    }).toEqual({ server: "evt_command", optimistic: undefined, failed: undefined, operation: undefined })
  })

  it("collapses an optimistic row when the bootstrap carries its server copy (reload-during-send race)", async () => {
    const streamId = "stream_reload_race"

    // State a reload leaves behind when it interrupts the send pipeline after
    // the server committed: the optimistic event AND its outbox row survive in
    // IDB, the message:created echo was lost with the old page, and the
    // queue's re-send hits the backend's idempotent replay (no new event → no
    // echo ever). The bootstrap is the only remaining reconciliation point.
    await db.events.put({
      id: "temp_reload",
      workspaceId: "ws_1",
      streamId,
      sequence: "1752350000000", // optimistic rows use Date.now() — sorts after every real event
      _sequenceNum: 1752350000000,
      eventType: "message_created",
      payload: { messageId: "temp_reload", contentMarkdown: "hello" },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })
    await db.pendingMessages.add({
      clientId: "temp_reload",
      workspaceId: "ws_1",
      streamId,
      content: "hello",
      contentFormat: "markdown",
      createdAt: Date.now(),
      retryCount: 0,
    })

    const serverCopy = makeEvent({ id: "evt_real", streamId, sequence: "100" })
    serverCopy.payload = { messageId: "msg_1", contentMarkdown: "hello", clientMessageId: "temp_reload" }
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([serverCopy], streamId))

    expect(await db.events.get("evt_real")).toBeDefined()
    expect(await db.events.get("temp_reload")).toBeUndefined()
    expect(await db.pendingMessages.get("temp_reload")).toBeUndefined()
  })

  it("carries the optimistic row's conversationId onto the swapped-in server copy", async () => {
    const streamId = "stream_reload_conv"

    await db.events.put({
      id: "temp_conv",
      workspaceId: "ws_1",
      streamId,
      sequence: "1752350000000",
      _sequenceNum: 1752350000000,
      eventType: "message_created",
      payload: { messageId: "temp_conv", contentMarkdown: "board reply", conversationId: "conv_1" },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })
    // Outbox row still present (the reload case) — without it,
    // cleanupStaleOptimisticEvents drops the temp row before the swap runs.
    await db.pendingMessages.add({
      clientId: "temp_conv",
      workspaceId: "ws_1",
      streamId,
      content: "board reply",
      contentFormat: "markdown",
      createdAt: Date.now(),
      retryCount: 0,
    })

    const serverCopy = makeEvent({ id: "evt_conv_real", streamId, sequence: "100" })
    serverCopy.payload = { messageId: "msg_2", contentMarkdown: "board reply", clientMessageId: "temp_conv" }
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([serverCopy], streamId))

    const swapped = await db.events.get("evt_conv_real")
    expect((swapped?.payload as { conversationId?: string }).conversationId).toBe("conv_1")
    expect(await db.events.get("temp_conv")).toBeUndefined()
  })

  it("seeds the decrypt cache from the optimistic plaintext when the bootstrap swaps in an encrypted server copy", async () => {
    clearDecryptCache()
    const streamId = "stream_reload_e2e"
    const plaintextJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] }

    await db.events.put({
      id: "temp_e2e",
      workspaceId: "ws_1",
      streamId,
      sequence: "1752350000000",
      _sequenceNum: 1752350000000,
      eventType: "message_created",
      payload: { messageId: "temp_e2e", contentMarkdown: "secret", contentJson: plaintextJson },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })
    await db.pendingMessages.add({
      clientId: "temp_e2e",
      workspaceId: "ws_1",
      streamId,
      content: "secret",
      contentFormat: "markdown",
      createdAt: Date.now(),
      retryCount: 0,
    })

    const serverCopy = makeEvent({ id: "evt_e2e_real", streamId, sequence: "100" })
    serverCopy.payload = {
      messageId: "msg_3",
      clientMessageId: "temp_e2e",
      contentMarkdown: "🔒 Encrypted",
      contentJson: null,
      ciphertext: "base64ciphertext",
      envelope: { v: 2 },
    }
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([serverCopy], streamId))

    expect(await db.events.get("temp_e2e")).toBeUndefined()
    expect(await db.events.get("evt_e2e_real")).toBeDefined()
    const cached = getCachedDecryption("evt_e2e_real")
    expect(cached?.status).toBe("decrypted")
    expect(cached?.value?.contentMarkdown).toBe("secret")
    expect(cached?.value?.contentJson).toEqual(plaintextJson)
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

describe("applyStreamBootstrap — per-stream unread count", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.events.clear(), db.streams.clear()])
  })

  it("publishes the stream bootstrap count for access-without-membership viewers", async () => {
    const streamId = "stream_public"
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: {},
      mutedStreamIds: [],
      counterTouchedAt: {},
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: {},
    } as WorkspaceBootstrap)
    const bootstrap = { ...makeBootstrap([], streamId), unreadCount: 4, messageCount: 6 }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt: Date.now(), queryClient })

    const state = await db.unreadState.get("ws_1")
    expect(state?.unreadCounts[streamId]).toBe(4)
    expect(state?.latestOrdinals?.[streamId]).toBe(6)
    expect(
      applyStreamReadOrdinal({ ...state!, unreadActivities: state?.unreadActivities ?? [] }, streamId, 3).unreadCounts[
        streamId
      ]
    ).toBe(3)
    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.unreadCounts[streamId]).toBe(4)
    expect(cached?.messageCounts?.[streamId]).toBe(6)
  })

  it("skips query-cache publication when a newer counter lands after the IDB transaction", async () => {
    const streamId = "stream_public"
    const fetchStartedAt = 100
    const seeded = {
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { [streamId]: 3 },
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: { [streamId]: 10 },
      mutedStreamIds: [],
      counterTouchedAt: {},
      _cachedAt: 90,
    }
    await db.unreadState.put(seeded)
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: { [streamId]: 3 },
      messageCounts: { [streamId]: 10 },
    } as unknown as WorkspaceBootstrap)
    const get = vi
      .spyOn(db.unreadState, "get")
      .mockResolvedValueOnce(seeded)
      .mockResolvedValueOnce({
        ...seeded,
        unreadCounts: { [streamId]: 4 },
        latestOrdinals: { [streamId]: 11 },
        counterTouchedAt: { [streamId]: 101 },
      })

    try {
      await applyStreamBootstrap(
        "ws_1",
        streamId,
        { ...makeBootstrap([], streamId), unreadCount: 1, messageCount: 8 },
        { fetchStartedAt, queryClient }
      )
    } finally {
      get.mockRestore()
    }

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached).toMatchObject({
      unreadCounts: { [streamId]: 3 },
      messageCounts: { [streamId]: 10 },
    })
  })

  it("skips counter publication entirely when the caller provides no fetchStartedAt", async () => {
    // Without a fetch-start timestamp the touched-at guard cannot order the
    // snapshot against a live ordinal, so the counters must not apply at all —
    // a caller that wants counter publication passes `fetchStartedAt`.
    const streamId = "stream_public"
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { [streamId]: 3 },
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: { [streamId]: 10 },
      mutedStreamIds: [],
      counterTouchedAt: {},
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      unreadCounts: { [streamId]: 3 },
      messageCounts: { [streamId]: 10 },
    } as unknown as WorkspaceBootstrap)

    await applyStreamBootstrap(
      "ws_1",
      streamId,
      { ...makeBootstrap([], streamId), unreadCount: 1, messageCount: 8 },
      { queryClient }
    )

    expect(await db.unreadState.get("ws_1")).toMatchObject({
      unreadCounts: { [streamId]: 3 },
      latestOrdinals: { [streamId]: 10 },
    })
    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))).toMatchObject({
      unreadCounts: { [streamId]: 3 },
      messageCounts: { [streamId]: 10 },
    })
  })

  it("preserves a counter touched after the bootstrap request departed", async () => {
    const streamId = "stream_public"
    const fetchStartedAt = Date.now() - 100
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { [streamId]: 3 },
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: {},
      mutedStreamIds: [],
      counterTouchedAt: { [streamId]: Date.now() },
      _cachedAt: Date.now(),
    })

    await applyStreamBootstrap("ws_1", streamId, { ...makeBootstrap([], streamId), unreadCount: 1 }, { fetchStartedAt })

    expect((await db.unreadState.get("ws_1"))?.unreadCounts[streamId]).toBe(3)
  })
})

describe("applyStreamBootstrap — read-state freshness (stale response guard)", () => {
  // A bootstrap snapshot begun at T0 may apply its `readState` only when the
  // local frontier row was NOT touched at/after T0 (socket echo or optimistic
  // mutation). Operation order — not max(sequence) — decides, so an explicit
  // unread (a sanctioned downward move) can never be resurrected by a stale
  // response that was in flight when it landed.

  beforeEach(async () => {
    await Promise.all([db.events.clear(), db.streams.clear(), db.streamReadState.clear(), db.streamMemberships.clear()])
  })

  function membership(streamId: string): StreamMember {
    return {
      streamId,
      memberId: "member_1",
      notificationLevel: null,
      joinedAt: "2026-01-01T00:00:00.000Z",
    }
  }

  it("a stale response cannot restore E100 over an explicit unread (read_set E50) that landed during the fetch", async () => {
    const streamId = "stream_stale_restore"
    const fetchStartedAt = Date.now() - 5000

    // While the request was in flight, a stream:read_set echo SET the frontier
    // back to E50 and stamped the touched time.
    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
      _cachedAt: Date.now() - 1000, // touched inside the fetch window
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: {
        lastReadEventId: "evt_100",
        lastReadSequence: "100",
        lastReadAt: "2026-01-01T00:00:01.000Z",
      },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt })

    // Preserved EXACTLY — max(sequence) alone would have "restored" E100 (100 > 50).
    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
    })
    // The envelope carries the preserved row, so the per-stream query cache the
    // caller writes (toCachedStreamBootstrap) never publishes the stale snapshot.
    expect(bootstrap.readState).toEqual({
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
    })
  })

  it("a stale confirmed-ABSENT (null) response cannot delete a frontier touched during the fetch", async () => {
    const streamId = "stream_stale_absent"
    const fetchStartedAt = Date.now() - 5000

    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
      _cachedAt: Date.now() - 1000,
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: null, // server snapshot predates the row: "no standalone row"
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt })

    // The member absence-delete semantics do NOT apply — the touched row stays.
    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
    })
    expect(bootstrap.readState).toMatchObject({ lastReadEventId: "evt_50" })
  })

  it("a later advance during the fetch (E150) is preserved exactly", async () => {
    const streamId = "stream_stale_advance"
    const fetchStartedAt = Date.now() - 5000

    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_150",
      lastReadSequence: "150",
      lastReadAt: "2026-01-01T00:00:09.000Z",
      _cachedAt: Date.now() - 1000,
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: {
        lastReadEventId: "evt_100",
        lastReadSequence: "100",
        lastReadAt: "2026-01-01T00:00:01.000Z",
      },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt })

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      lastReadEventId: "evt_150",
      lastReadSequence: "150",
      lastReadAt: "2026-01-01T00:00:09.000Z",
    })
  })

  it("an untouched response applies the server row normally", async () => {
    const streamId = "stream_untouched_apply"
    const fetchStartedAt = Date.now() - 1000

    // Touched BEFORE the fetch departed — the snapshot is fresher.
    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:01.000Z",
      _cachedAt: Date.now() - 5000,
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: {
        lastReadEventId: "evt_100",
        lastReadSequence: "100",
        lastReadAt: "2026-01-01T00:00:03.000Z",
      },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt })

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      lastReadEventId: "evt_100",
      lastReadSequence: "100",
    })
    expect(bootstrap.readState).toMatchObject({ lastReadEventId: "evt_100" })
  })

  it("an untouched confirmed-absence response preserves the never-read sentinel", async () => {
    const streamId = "stream_untouched_absent"
    const fetchStartedAt = Date.now() - 1000

    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: null,
      _cachedAt: Date.now() - 5000, // stale never-read sentinel
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: null,
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt })

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      lastReadEventId: null,
      lastReadSequence: null,
    })
  })

  it("publishes the preserved frontier to the workspace cache", async () => {
    const streamId = "stream_stale_publish"
    const fetchStartedAt = Date.now() - 5000
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      streamReadState: {},
      streamMemberships: [],
    } as unknown as WorkspaceBootstrap)

    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
      _cachedAt: Date.now() - 1000,
    })

    const bootstrap = {
      ...makeBootstrap([], streamId),
      membership: membership(streamId),
      readState: {
        lastReadEventId: "evt_100",
        lastReadSequence: "100",
        lastReadAt: "2026-01-01T00:00:01.000Z",
      },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap, { fetchStartedAt, queryClient })

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.streamReadState?.[streamId]).toEqual({
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: "2026-01-01T00:00:05.000Z",
    })
  })
})

describe("updateMemoEmbedSummary", () => {
  const SUMMARY = {
    memoId: "memo_a",
    title: "Launch in June",
    knowledgeType: "decision" as const,
    memoType: "conversation" as const,
    tags: ["launch"],
    updatedAt: "2026-07-31T10:00:00.000Z",
  }

  async function seed(streamId: string, id: string, memoEmbeds: unknown) {
    await db.events.put({
      ...makeEvent({
        id,
        streamId,
        sequence: "100",
        payload: { messageId: `msg_${id}`, contentMarkdown: "cites a memo", memoEmbeds },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
    })
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("replaces the summary on every message citing that memo", async () => {
    const streamId = "stream_memo_patch"
    await seed(streamId, "evt_1", [{ ...SUMMARY, title: "Launch in May" }])
    await seed(streamId, "evt_2", [
      { memoId: "memo_other", title: "Untouched" },
      { ...SUMMARY, title: "Launch in May" },
    ])

    await updateMemoEmbedSummary(streamId, SUMMARY)

    const first = await db.events.get("evt_1")
    expect((first?.payload as { memoEmbeds: Array<{ title: string }> }).memoEmbeds[0].title).toBe("Launch in June")
    const second = await db.events.get("evt_2")
    const embeds = (second?.payload as { memoEmbeds: Array<{ memoId: string; title: string }> }).memoEmbeds
    expect(embeds.map((e) => e.title)).toEqual(["Untouched", "Launch in June"])
  })

  // The event says a memo changed, not that this reader may see it. The server
  // already decided per room which messages carry a summary; adding one here
  // would put a card in front of someone the write path withheld it from.
  it("does not add a summary to a message that never carried one", async () => {
    const streamId = "stream_memo_absent"
    await seed(streamId, "evt_bare", undefined)

    await updateMemoEmbedSummary(streamId, SUMMARY)

    expect((await db.events.get("evt_bare"))?.payload).not.toHaveProperty("memoEmbeds.0")
  })

  it("leaves other streams alone", async () => {
    await seed("stream_a", "evt_a", [{ ...SUMMARY, title: "Launch in May" }])
    await seed("stream_b", "evt_b", [{ ...SUMMARY, title: "Launch in May" }])

    await updateMemoEmbedSummary("stream_a", SUMMARY)

    const untouched = await db.events.get("evt_b")
    expect((untouched?.payload as { memoEmbeds: Array<{ title: string }> }).memoEmbeds[0].title).toBe("Launch in May")
  })
})

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
    // thread:updated socket handlers all update the same parent message
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

describe("updateMessageEvent — indexed payload.messageId lookup", () => {
  function seedRow(overrides: {
    id: string
    streamId: string
    sequence: string
    payload: Record<string, unknown>
    eventType?: StreamEvent["eventType"]
  }): CachedEvent {
    return {
      ...makeEvent({
        id: overrides.id,
        streamId: overrides.streamId,
        sequence: overrides.sequence,
        payload: overrides.payload,
        eventType: overrides.eventType ?? "message_created",
      }),
      workspaceId: "ws_1",
      _sequenceNum: Number(overrides.sequence),
      _cachedAt: Date.now(),
    } as CachedEvent
  }

  /**
   * Counts what each arm's cursor actually visits: `filter` predicate calls are
   * the scan's per-row cost, `modify` callback calls are the rows the cursor
   * yielded, and `written` is Dexie's own count of rows it re-put (the callback
   * returning `false` is what keeps a guard-skipped row out of that count — so
   * the wrapper must PROPAGATE the callback's return value, never swallow it).
   * The indexed arm runs no `filter` at all.
   */
  const unsubscribes: Array<() => void> = []

  function trackCursor() {
    const counts = { indexes: [] as string[], filtered: 0, visited: 0, written: 0 }
    // Dexie's `modify()` resolves to the number of rows the cursor MATCHED, not
    // the number it wrote — the `updating` hook is what fires per actual put.
    const onUpdating = () => {
      counts.written += 1
    }
    db.events.hook("updating", onUpdating)
    unsubscribes.push(() => db.events.hook("updating").unsubscribe(onUpdating))
    const originalWhere = db.events.where.bind(db.events)
    vi.spyOn(db.events, "where").mockImplementation(((key: string) => {
      counts.indexes.push(String(key))
      const clause = originalWhere(key as never) as unknown as {
        equals: (value: unknown) => Record<string, unknown>
      }
      const originalEquals = clause.equals.bind(clause)
      clause.equals = (value: unknown) => {
        const collection = originalEquals(value) as unknown as {
          filter: (fn: (row: CachedEvent) => boolean) => unknown
          modify: (fn: (row: CachedEvent) => void | boolean) => PromiseLike<number>
        }
        const originalFilter = collection.filter.bind(collection)
        const originalModify = collection.modify.bind(collection)
        collection.filter = (fn) =>
          originalFilter((row) => {
            counts.filtered += 1
            return fn(row)
          })
        collection.modify = (fn) =>
          originalModify((row) => {
            counts.visited += 1
            return fn(row)
          })
        return collection as never
      }
      return clause as never
    }) as never)
    return counts
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    while (unsubscribes.length > 0) unsubscribes.pop()?.()
  })

  async function seedLargeStream(streamId: string, count: number, targetMessageId: string): Promise<void> {
    const rows: CachedEvent[] = []
    for (let i = 0; i < count; i += 1) {
      const messageId = i === count - 2 ? targetMessageId : `msg_bulk_${i}`
      rows.push(
        seedRow({
          id: `evt_bulk_${i}`,
          streamId,
          sequence: String(i + 1),
          payload: { messageId, contentMarkdown: "x" },
        })
      )
    }
    await db.events.bulkPut(rows)
  }

  it("a reaction patch touches one row in a thousand-event stream", async () => {
    const streamId = "stream_big"
    const messageId = "msg_target"
    await seedLargeStream(streamId, 1000, messageId)

    const indexed = trackCursor()
    await updateMessageEvent(streamId, messageId, (p) => ({ ...p, reactions: ["👍"] }))
    expect(indexed.indexes).toEqual(["payload.messageId"])
    expect({ filtered: indexed.filtered, visited: indexed.visited }).toEqual({ filtered: 0, visited: 1 })

    const patched = await db.events.get("evt_bulk_998")
    expect((patched?.payload as Record<string, unknown>).reactions).toEqual(["👍"])
  }, 20000)

  it("a patch for a message in another stream is not applied", async () => {
    const messageId = "msg_shared"
    await db.events.bulkPut([
      seedRow({ id: "evt_here", streamId: "stream_here", sequence: "1", payload: { messageId, replyCount: 0 } }),
      seedRow({ id: "evt_there", streamId: "stream_there", sequence: "1", payload: { messageId, replyCount: 0 } }),
    ])

    const counts = trackCursor()
    await updateMessageEvent("stream_here", messageId, (p) => ({ ...p, replyCount: 7 }))

    const here = await db.events.get("evt_here")
    const there = await db.events.get("evt_there")
    expect({
      here: (here?.payload as Record<string, unknown>).replyCount,
      there: (there?.payload as Record<string, unknown>).replyCount,
      therePatchedAt: there?._patchedAt,
      visited: counts.visited,
      written: counts.written,
    }).toEqual({ here: 7, there: 0, therePatchedAt: undefined, visited: 2, written: 1 })
  })

  it("a same-id row of another event type is visited but not re-put", async () => {
    const messageId = "msg_typed"
    await db.events.bulkPut([
      seedRow({ id: "evt_created", streamId: "stream_typed", sequence: "1", payload: { messageId, replyCount: 0 } }),
      seedRow({
        id: "evt_edited",
        streamId: "stream_typed",
        sequence: "2",
        eventType: "message_edited",
        payload: { messageId, replyCount: 0 },
      }),
    ])

    const counts = trackCursor()
    await updateMessageEvent("stream_typed", messageId, (p) => ({ ...p, replyCount: 9 }))

    const created = await db.events.get("evt_created")
    const edited = await db.events.get("evt_edited")
    expect({
      created: (created?.payload as Record<string, unknown>).replyCount,
      edited: (edited?.payload as Record<string, unknown>).replyCount,
      editedPatchedAt: edited?._patchedAt,
      visited: counts.visited,
      written: counts.written,
    }).toEqual({ created: 9, edited: 0, editedPatchedAt: undefined, visited: 2, written: 1 })
  })

  it("concurrent patches to the same message do not lose an update", async () => {
    const messageId = "msg_race_indexed"
    await db.events.put(
      seedRow({ id: "evt_race_indexed", streamId: "stream_race", sequence: "1", payload: { messageId } })
    )

    await Promise.all([
      updateMessageEvent("stream_race", messageId, (p) => ({ ...p, replyCount: 3 })),
      updateMessageEvent("stream_race", messageId, (p) => ({ ...p, threadId: "thread_1" })),
    ])

    const event = await db.events.get("evt_race_indexed")
    expect(event?.payload).toEqual({ messageId, replyCount: 3, threadId: "thread_1" })
  })

  it("an event whose payload carries no messageId is never matched", async () => {
    await db.events.bulkPut([
      seedRow({
        id: "evt_no_message_id",
        streamId: "stream_sparse",
        sequence: "1",
        eventType: "call_started",
        payload: { callId: "call_1" },
      }),
      seedRow({
        id: "evt_with_message_id",
        streamId: "stream_sparse",
        sequence: "2",
        payload: { messageId: "msg_sparse" },
      }),
    ])

    await updateMessageEvent("stream_sparse", "msg_sparse", (p) => ({ ...p, replyCount: 1 }))

    const untouched = await db.events.get("evt_no_message_id")
    const patched = await db.events.get("evt_with_message_id")
    expect({
      untouched: untouched?.payload,
      untouchedPatchedAt: untouched?._patchedAt,
      patched: patched?.payload,
    }).toEqual({
      untouched: { callId: "call_1" },
      untouchedPatchedAt: undefined,
      patched: { messageId: "msg_sparse", replyCount: 1 },
    })
  })

  it("the same message id in two streams patches only the caller's stream", async () => {
    const messageId = "msg_moved"
    await db.events.bulkPut([
      seedRow({ id: "evt_old_stream", streamId: "stream_old", sequence: "1", payload: { messageId, tag: "old" } }),
      seedRow({ id: "evt_new_stream", streamId: "stream_new", sequence: "1", payload: { messageId, tag: "new" } }),
    ])

    await updateMessageEvent("stream_new", messageId, (p) => ({ ...p, tag: "patched" }))

    const rows = await db.events.bulkGet(["evt_old_stream", "evt_new_stream"])
    expect(rows.map((row) => (row?.payload as Record<string, unknown>).tag)).toEqual(["old", "patched"])
  })

  it("six payload shapes round-trip through the updater on the indexed path", async () => {
    const streamId = "stream_callers"
    await db.events.bulkPut([
      seedRow({ id: "evt_edit", streamId, sequence: "1", payload: { messageId: "msg_edit" } }),
      seedRow({ id: "evt_delete", streamId, sequence: "2", payload: { messageId: "msg_delete" } }),
      seedRow({ id: "evt_move", streamId, sequence: "3", payload: { messageId: "msg_move" } }),
      seedRow({ id: "evt_reaction", streamId, sequence: "4", payload: { messageId: "msg_reaction" } }),
      seedRow({ id: "evt_preview", streamId, sequence: "5", payload: { messageId: "msg_preview" } }),
      seedRow({ id: "evt_heal", streamId, sequence: "6", payload: { messageId: "msg_heal" } }),
      seedRow({
        id: "evt_card",
        streamId,
        sequence: "7",
        eventType: "memos:captured",
        payload: { memoId: "memo_1" },
      }),
    ])

    await updateMessageEvent(streamId, "msg_edit", (p) => ({ ...p, contentMarkdown: "edited", editedAt: "t" }))
    await updateMessageEvent(streamId, "msg_delete", (p) => ({ ...p, deletedAt: "t" }))
    await updateMessageEvent(streamId, "msg_move", (p) => ({ ...p, movedToStreamId: "stream_other" }))
    await updateMessageEvent(streamId, "msg_reaction", (p) => ({ ...p, reactions: ["👍"] }))
    await updateMessageEvent(streamId, "msg_preview", (p) => ({ ...p, linkPreviews: [{ url: "u" }] }))
    await updateEventByAnchor(streamId, "msg_heal", (p) => ({ ...p, threadId: "thread_healed" }))
    await updateEventByAnchor(streamId, "evt_card", (p) => ({ ...p, threadId: "thread_card" }))

    const rows = await db.events.bulkGet([
      "evt_edit",
      "evt_delete",
      "evt_move",
      "evt_reaction",
      "evt_preview",
      "evt_heal",
      "evt_card",
    ])
    expect(rows.map((row) => row?.payload)).toEqual([
      { messageId: "msg_edit", contentMarkdown: "edited", editedAt: "t" },
      { messageId: "msg_delete", deletedAt: "t" },
      { messageId: "msg_move", movedToStreamId: "stream_other" },
      { messageId: "msg_reaction", reactions: ["👍"] },
      { messageId: "msg_preview", linkPreviews: [{ url: "u" }] },
      { messageId: "msg_heal", threadId: "thread_healed" },
      { memoId: "memo_1", threadId: "thread_card" },
    ])
  })
})

describe("optimisticReplyCountUpdate", () => {
  const streamId = "stream_optimistic"

  function seedAnchor(id: string, payload: Record<string, unknown>) {
    return db.events.put({
      ...makeEvent({ id, streamId, sequence: "1", payload }),
      workspaceId: "ws_1",
      _sequenceNum: 1,
      _cachedAt: Date.now(),
    } as CachedEvent)
  }

  const summary: ThreadSummary = {
    lastReplyAt: "2026-08-11T10:00:00.000Z",
    participants: [{ id: "user_me", type: "user" }],
    latestReply: { messageId: "msg_mine", actorId: "user_me", actorType: "user", contentMarkdown: "my reply" },
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("writes the summary alongside the count so the card keeps its preview row", async () => {
    await seedAnchor("evt_first", { messageId: "msg_anchor", replyCount: 0 })

    await optimisticReplyCountUpdate(streamId, "msg_anchor", "draft_panel", summary)

    const row = await db.events.get("evt_first")
    expect(row?.payload).toEqual({
      messageId: "msg_anchor",
      threadId: "draft_panel",
      replyCount: 1,
      threadSummary: summary,
    })
  })

  it("appends the sender to an existing summary's participants and replaces latestReply", async () => {
    const existing: ThreadSummary = {
      lastReplyAt: "2026-08-11T09:00:00.000Z",
      participants: [{ id: "user_other", type: "user" }],
      latestReply: {
        messageId: "msg_theirs",
        actorId: "user_other",
        actorType: "user",
        contentMarkdown: "their reply",
      },
    }
    await seedAnchor("evt_merge", { messageId: "msg_anchor", replyCount: 1, threadSummary: existing })

    await optimisticReplyCountUpdate(streamId, "msg_anchor", "draft_panel", summary)

    const row = await db.events.get("evt_merge")
    expect(row?.payload).toEqual({
      messageId: "msg_anchor",
      threadId: "draft_panel",
      replyCount: 2,
      threadSummary: {
        lastReplyAt: summary.lastReplyAt,
        participants: [{ id: "user_other", type: "user" }, ...summary.participants],
        latestReply: summary.latestReply,
      },
    })
  })

  it("keeps an already-present sender once, and never grows participants past the server's cap of 3", async () => {
    const alreadyIn: ThreadSummary["participants"] = [
      { id: "user_a", type: "user" },
      { id: "user_me", type: "user" },
    ]
    const full: ThreadSummary["participants"] = [
      { id: "user_a", type: "user" },
      { id: "persona_b", type: "persona" },
      { id: "bot_c", type: "bot" },
    ]
    const latestReply = { messageId: "msg_a", actorId: "user_a", actorType: "user" as const, contentMarkdown: "a" }
    await seedAnchor("evt_dedupe", {
      messageId: "msg_dedupe",
      replyCount: 4,
      threadSummary: { lastReplyAt: "2026-08-11T09:00:00.000Z", participants: alreadyIn, latestReply },
    })
    await seedAnchor("evt_capped", {
      messageId: "msg_capped",
      replyCount: 9,
      threadSummary: { lastReplyAt: "2026-08-11T09:00:00.000Z", participants: full, latestReply },
    })

    await optimisticReplyCountUpdate(streamId, "msg_dedupe", "draft_panel", summary)
    await optimisticReplyCountUpdate(streamId, "msg_capped", "draft_panel", summary)

    const rows = await db.events.bulkGet(["evt_dedupe", "evt_capped"])
    expect(rows.map((row) => (row?.payload as { threadSummary: ThreadSummary }).threadSummary.participants)).toEqual([
      alreadyIn,
      full,
    ])
  })

  it("leaves the payload's summary untouched when no summary is passed", async () => {
    await seedAnchor("evt_nosummary", { messageId: "msg_anchor", replyCount: 2, contentMarkdown: "parent" })

    await optimisticReplyCountUpdate(streamId, "msg_anchor", "draft_panel")

    const row = await db.events.get("evt_nosummary")
    expect(row?.payload).toEqual({
      messageId: "msg_anchor",
      contentMarkdown: "parent",
      threadId: "draft_panel",
      replyCount: 3,
    })
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

  // The stream's command set is computed server-side at bootstrap time, so a
  // runtime liveness edge (coming online / going away / instance swap) must
  // refetch it — otherwise a scratchpad opened before its agent connected keeps
  // an empty slash menu until the next full bootstrap. Available↔busy flips
  // happen on every turn and must NOT refetch.
  describe("command-set refresh on liveness edges", () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

    it("refetches and patches commands when a runtime comes online", async () => {
      const queryClient = new QueryClient()
      const streamId = "stream_cmd_online"
      seedBootstrap(queryClient, streamId, { bot_1: null })
      const steer = { name: "steer", description: "Steer the linked session" }
      const listForStream = vi.spyOn(commandsApi, "listForStream").mockResolvedValue([steer])

      const { socket, emit } = createTestSocket()
      const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

      emit("bot_runtime:presence", {
        workspaceId: "ws_1",
        streamId,
        botId: "bot_1",
        presence: makePresence({ status: "available", acceptingInvocations: true }),
      })
      await flush()

      expect(listForStream).toHaveBeenCalledWith("ws_1", streamId)
      const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
      expect(after?.commands).toEqual([steer])

      listForStream.mockRestore()
      cleanup()
    })

    it("refetches when a runtime goes offline (commands drop)", async () => {
      const queryClient = new QueryClient()
      const streamId = "stream_cmd_offline"
      seedBootstrap(queryClient, streamId, { bot_1: makePresence({ status: "available" }) })
      const listForStream = vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])

      const { socket, emit } = createTestSocket()
      const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

      emit("bot_runtime:presence", {
        workspaceId: "ws_1",
        streamId,
        botId: "bot_1",
        presence: makePresence({ status: "offline", acceptingInvocations: false }),
      })
      await flush()

      expect(listForStream).toHaveBeenCalledTimes(1)
      const after = queryClient.getQueryData<CachedStreamBootstrap>(streamKeys.bootstrap("ws_1", streamId))
      expect(after?.commands).toEqual([])

      listForStream.mockRestore()
      cleanup()
    })

    it("does not refetch on an available↔busy flip of the same instance", async () => {
      const queryClient = new QueryClient()
      const streamId = "stream_cmd_busy"
      seedBootstrap(queryClient, streamId, { bot_1: makePresence({ status: "available" }) })
      const listForStream = vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])

      const { socket, emit } = createTestSocket()
      const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

      emit("bot_runtime:presence", {
        workspaceId: "ws_1",
        streamId,
        botId: "bot_1",
        presence: makePresence({ status: "busy", statusText: "Working in Claude Code…" }),
      })
      await flush()

      expect(listForStream).not.toHaveBeenCalled()

      listForStream.mockRestore()
      cleanup()
    })

    it("refetches when the serving instance is swapped out", async () => {
      const queryClient = new QueryClient()
      const streamId = "stream_cmd_swap"
      seedBootstrap(queryClient, streamId, { bot_1: makePresence({ status: "available", instanceId: "inst_1" }) })
      const listForStream = vi.spyOn(commandsApi, "listForStream").mockResolvedValue([])

      const { socket, emit } = createTestSocket()
      const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

      emit("bot_runtime:presence", {
        workspaceId: "ws_1",
        streamId,
        botId: "bot_1",
        presence: makePresence({ status: "available", instanceId: "inst_2" }),
      })
      await flush()

      expect(listForStream).toHaveBeenCalledTimes(1)

      listForStream.mockRestore()
      cleanup()
    })
  })
})

describe("registerStreamSocketHandlers — E2E send reconciliation seeds the decrypt cache", () => {
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

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
    await db.pendingOperations.clear()
    clearDecryptCache()
  })

  it("seeds the server event id with the optimistic plaintext so it renders decrypted on arrival", async () => {
    const streamId = "stream_e2e_echo"
    const plaintextJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] }

    // Optimistic (self-sent) event holds the plaintext we just encrypted.
    await db.events.put({
      id: "temp_1",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "message_created",
      payload: { messageId: "temp_1", contentMarkdown: "secret", contentJson: plaintextJson },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })
    await db.pendingMessages.add({
      clientId: "temp_1",
      workspaceId: "ws_1",
      streamId,
      content: "secret",
      contentFormat: "markdown",
      createdAt: Date.now(),
      retryCount: 0,
    })

    const { socket, emit } = createTestSocket()
    const queryClient = new QueryClient()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    // Server echoes the message back as ciphertext + envelope, with clientMessageId.
    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: "evt_server",
        streamId,
        sequence: "1000",
        eventType: "message_created",
        payload: {
          messageId: "evt_server",
          clientMessageId: "temp_1",
          contentMarkdown: "🔒 Encrypted",
          contentJson: null,
          ciphertext: "base64ciphertext",
          envelope: { v: 2 },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    // Optimistic row swapped for the server row, and the decrypt cache is
    // pre-seeded so the encrypted server event never flashes "decrypting".
    expect(await db.events.get("temp_1")).toBeUndefined()
    expect(await db.events.get("evt_server")).toBeDefined()
    const cached = getCachedDecryption("evt_server")
    expect(cached?.status).toBe("decrypted")
    expect(cached?.value?.contentMarkdown).toBe("secret")
    expect(cached?.value?.contentJson).toEqual(plaintextJson)

    cleanup()
  })

  it("removes a failed command sidecar when the live server event confirms the command", async () => {
    const streamId = "stream_command_echo"
    const optimistic = {
      id: "temp_command_echo",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "command_dispatched" as const,
      payload: { commandId: "temp_command_echo", name: "stop", args: "", status: "dispatched" },
      actorId: "user_1",
      actorType: "user" as const,
      createdAt: new Date().toISOString(),
      _status: "failed" as const,
      _cachedAt: Date.now(),
    }
    await db.events.bulkPut([
      optimistic,
      {
        ...optimistic,
        id: "temp_command_echo:failed",
        eventType: "command_failed",
        payload: { commandId: "temp_command_echo", error: "Timed out" },
      },
    ])

    const { socket, emit } = createTestSocket()
    const queryClient = new QueryClient()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("command:dispatched", {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: "evt_command_echo",
        streamId,
        sequence: "1000",
        eventType: "command_dispatched",
        payload: {
          commandId: "cmd_echo",
          clientCommandId: "temp_command_echo",
          name: "stop",
          args: "",
          status: "dispatched",
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    expect(await db.events.bulkGet(["temp_command_echo", "temp_command_echo:failed"])).toEqual([undefined, undefined])
    expect(await db.events.get("evt_command_echo")).toBeDefined()

    cleanup()
  })

  it("does not seed when the server event is plaintext (non-E2E)", async () => {
    const streamId = "stream_plain_echo"

    await db.events.put({
      id: "temp_2",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "message_created",
      payload: { messageId: "temp_2", contentMarkdown: "hi", contentJson: { type: "doc", content: [] } },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const queryClient = new QueryClient()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: "evt_plain",
        streamId,
        sequence: "1000",
        eventType: "message_created",
        payload: {
          messageId: "evt_plain",
          clientMessageId: "temp_2",
          contentMarkdown: "hi",
          contentJson: { type: "doc", content: [] },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    // Plaintext events render straight from their payload; the cache stays empty.
    expect(getCachedDecryption("evt_plain")).toBeUndefined()

    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Board reply: the swap carries the optimistic conversationId onto the real event
// ---------------------------------------------------------------------------

describe("registerStreamSocketHandlers — board reply conversationId carry-forward", () => {
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

  beforeEach(async () => {
    await db.events.clear()
    await db.pendingMessages.clear()
  })

  it("carries the optimistic event's conversationId onto the real event so the board card doesn't blink the reply out", async () => {
    const streamId = "stream_board_reply"

    // The optimistic board reply tags its event with the target conversation.
    await db.events.put({
      id: "temp_reply",
      workspaceId: "ws_1",
      streamId,
      sequence: "1700000000000",
      _sequenceNum: 1700000000000,
      eventType: "message_created",
      payload: {
        messageId: "temp_reply",
        contentMarkdown: "my reply",
        contentJson: { type: "doc", content: [] },
        conversationId: "conv_42",
      },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())

    // The server echo carries clientMessageId but NOT conversationId (that rides a
    // separate conversation:updated). The swap must carry it forward.
    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: "msg_real",
        streamId,
        sequence: "5",
        eventType: "message_created",
        payload: {
          messageId: "msg_real",
          clientMessageId: "temp_reply",
          contentMarkdown: "my reply",
          contentJson: { type: "doc", content: [] },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    expect(await db.events.get("temp_reply")).toBeUndefined()
    const real = await db.events.get("msg_real")
    expect((real?.payload as { conversationId?: string }).conversationId).toBe("conv_42")

    cleanup()
  })

  it("leaves an ordinary send (no optimistic conversationId) untagged", async () => {
    const streamId = "stream_plain_send"

    await db.events.put({
      id: "temp_plain",
      workspaceId: "ws_1",
      streamId,
      sequence: "1700000000001",
      _sequenceNum: 1700000000001,
      eventType: "message_created",
      payload: { messageId: "temp_plain", contentMarkdown: "hi", contentJson: { type: "doc", content: [] } },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: {
        id: "msg_plain",
        streamId,
        sequence: "6",
        eventType: "message_created",
        payload: {
          messageId: "msg_plain",
          clientMessageId: "temp_plain",
          contentMarkdown: "hi",
          contentJson: { type: "doc", content: [] },
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    })

    const real = await db.events.get("msg_plain")
    expect((real?.payload as { conversationId?: string }).conversationId).toBeUndefined()

    cleanup()
  })
})

// ---------------------------------------------------------------------------
// Sequence gap detection — live events that skip past the cached tail
// ---------------------------------------------------------------------------

describe("registerStreamSocketHandlers — sequence gap detection (INV-53)", () => {
  // A live event whose sequence leaves a hole behind the latest persisted one
  // means events were missed (zombie socket, server bounce, failed catch-up).
  // The handler must report the pre-write latest sequence so the caller can
  // fetch the hole — without it the gap is permanent until a full reload.

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

  function makeWireEvent(id: string, streamId: string, sequence: string): StreamEvent {
    return {
      id,
      streamId,
      sequence,
      eventType: "message_created",
      payload: { messageId: id, contentMarkdown: "hi", contentJson: { type: "doc", content: [] } },
      actorId: "user_2",
      actorType: "user",
      createdAt: new Date().toISOString(),
    }
  }

  async function seedPersisted(streamId: string, id: string, sequence: number): Promise<void> {
    await db.events.put({
      ...makeEvent({ id, streamId, sequence: String(sequence) }),
      workspaceId: "ws_1",
      _sequenceNum: sequence,
      _cachedAt: Date.now(),
    })
  }

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
  })

  it("reports a gap when a live message skips past the latest persisted event", async () => {
    const streamId = "stream_gap"
    await seedPersisted(streamId, "evt_100", 100)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_102", streamId, "102") })

    expect(onSequenceGap).toHaveBeenCalledWith({ streamId, afterSequence: "100" })
    // The gap-revealing event itself is still written.
    expect(await db.events.get("evt_102")).toBeDefined()
    cleanup()
  })

  it("does not report a gap for the contiguous next event", async () => {
    const streamId = "stream_contiguous"
    await seedPersisted(streamId, "evt_100", 100)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_101", streamId, "101") })

    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })

  it("does not report a gap when the stream has no cached events yet", async () => {
    const streamId = "stream_cold"
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_5", streamId, "5") })

    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })

  it("does not report a gap for an event at or below the cached tail", async () => {
    const streamId = "stream_old_event"
    await seedPersisted(streamId, "evt_100", 100)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_95", streamId, "95") })

    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })

  it("ignores pending optimistic placeholder rows when computing the gap baseline", async () => {
    const streamId = "stream_gap_pending"
    await seedPersisted(streamId, "evt_100", 100)
    // Pending optimistic row with a Date.now() placeholder sequence must not
    // mask the real tail — it would make every gap invisible.
    const placeholder = Date.now()
    await db.events.put({
      ...makeEvent({ id: "temp_x", streamId, sequence: String(placeholder) }),
      workspaceId: "ws_1",
      _sequenceNum: placeholder,
      _status: "pending",
      _cachedAt: Date.now(),
    })
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_102", streamId, "102") })

    expect(onSequenceGap).toHaveBeenCalledWith({ streamId, afterSequence: "100" })
    cleanup()
  })

  it("detects gaps on append-style events (membership, sessions) too", async () => {
    const streamId = "stream_gap_member"
    await seedPersisted(streamId, "evt_100", 100)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("stream:member_joined", {
      workspaceId: "ws_1",
      streamId,
      event: { ...makeWireEvent("evt_103", streamId, "103"), eventType: "member_joined", payload: {} },
    })

    expect(onSequenceGap).toHaveBeenCalledWith({ streamId, afterSequence: "100" })
    expect(await db.events.get("evt_103")).toBeDefined()
    cleanup()
  })

  it("does not report duplicate gaps for an event already in IDB", async () => {
    const streamId = "stream_gap_dupe"
    await seedPersisted(streamId, "evt_100", 100)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_102", streamId, "102") })
    onSequenceGap.mockClear()
    // Redelivery of the same event (handler re-registration overlap) — deduped.
    await emit("message:created", { workspaceId: "ws_1", streamId, event: makeWireEvent("evt_102", streamId, "102") })

    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })

  // -------------------------------------------------------------------------
  // Broadcast-chain detection (INV-61) — exact, no command-event phantoms
  // -------------------------------------------------------------------------

  async function seedStamped(streamId: string, id: string, sequence: number, broadcastSequence: string | null) {
    await db.events.put({
      ...makeEvent({ id, streamId, sequence: String(sequence) }),
      broadcastSequence,
      workspaceId: "ws_1",
      _sequenceNum: sequence,
      _cachedAt: Date.now(),
    })
  }

  it("does not report a gap when skipped global slots belong to viewer-invisible events (INV-61)", async () => {
    const streamId = "stream_bcast_clean"
    // Persisted tail: message at global 100, broadcast 50. Another user's
    // command events consumed global 101-102 but were never delivered here.
    await seedStamped(streamId, "evt_100", 100, "50")
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: { ...makeWireEvent("evt_103", streamId, "103"), broadcastSequence: "51" },
    })

    // The pre-INV-61 global heuristic would have flagged this as a gap and
    // fired a futile backfill; the dense broadcast chain proves it's contiguous.
    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })

  it("reports a broadcast-chain gap with the latest GLOBAL sequence as cursor", async () => {
    const streamId = "stream_bcast_gap"
    await seedStamped(streamId, "evt_100", 100, "50")
    // Own command event sits on the global tail without a broadcast slot —
    // the cursor must still be the global latest so `bootstrap?after=`
    // fetches everything missed.
    await seedStamped(streamId, "cmd_101", 101, null)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: { ...makeWireEvent("evt_105", streamId, "105"), broadcastSequence: "52" },
    })

    expect(onSequenceGap).toHaveBeenCalledWith({ streamId, afterSequence: "101" })
    cleanup()
  })

  it("compares on the broadcast chain even when an unstamped row is the global tail", async () => {
    const streamId = "stream_bcast_cmd_tail"
    await seedStamped(streamId, "evt_100", 100, "50")
    await seedStamped(streamId, "cmd_101", 101, null)
    const onSequenceGap = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), { onSequenceGap })

    // Global 103 > 101 + 1 would false-positive on the old heuristic, but
    // broadcast 51 is exactly contiguous with the persisted 50.
    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: { ...makeWireEvent("evt_103", streamId, "103"), broadcastSequence: "51" },
    })

    expect(onSequenceGap).not.toHaveBeenCalled()
    cleanup()
  })
})

describe("detectSequenceGap (unit)", () => {
  it("uses the dense broadcast chain when both sides are stamped", () => {
    const tail = { latestSequence: "100", latestBroadcastSequence: "50" }
    expect(detectSequenceGap(tail, { sequence: "105", broadcastSequence: "51" })).toBeNull()
    expect(detectSequenceGap(tail, { sequence: "105", broadcastSequence: "52" })).toBe("100")
    expect(detectSequenceGap(tail, { sequence: "105", broadcastSequence: "50" })).toBeNull()
  })

  it("falls back to the global heuristic when either side is unstamped", () => {
    expect(
      detectSequenceGap(
        { latestSequence: "100", latestBroadcastSequence: null },
        { sequence: "102", broadcastSequence: "51" }
      )
    ).toBe("100")
    expect(
      detectSequenceGap(
        { latestSequence: "100", latestBroadcastSequence: "50" },
        { sequence: "102", broadcastSequence: null }
      )
    ).toBe("100")
    expect(
      detectSequenceGap(
        { latestSequence: "100", latestBroadcastSequence: null },
        { sequence: "101", broadcastSequence: null }
      )
    ).toBeNull()
  })

  it("never reports a gap against an empty cache", () => {
    expect(
      detectSequenceGap(
        { latestSequence: null, latestBroadcastSequence: null },
        { sequence: "5", broadcastSequence: "3" }
      )
    ).toBeNull()
  })
})

describe("getPersistedTail", () => {
  beforeEach(async () => {
    await db.events.clear()
  })

  it("finds the highest broadcast stamp below an unstamped global tail", async () => {
    const streamId = "stream_tail_scan"
    await db.events.bulkPut([
      {
        ...makeEvent({ id: "evt_a", streamId, sequence: "100" }),
        broadcastSequence: "50",
        workspaceId: "ws_1",
        _sequenceNum: 100,
        _cachedAt: Date.now(),
      },
      {
        ...makeEvent({ id: "cmd_b", streamId, sequence: "101" }),
        broadcastSequence: null,
        workspaceId: "ws_1",
        _sequenceNum: 101,
        _cachedAt: Date.now(),
      },
    ])

    expect(await getPersistedTail(streamId)).toEqual({ latestSequence: "101", latestBroadcastSequence: "50" })
  })

  it("excludes pending/failed optimistic rows from both cursors", async () => {
    const streamId = "stream_tail_pending"
    const placeholder = Date.now()
    await db.events.bulkPut([
      {
        ...makeEvent({ id: "evt_a", streamId, sequence: "100" }),
        broadcastSequence: "50",
        workspaceId: "ws_1",
        _sequenceNum: 100,
        _cachedAt: Date.now(),
      },
      {
        ...makeEvent({ id: "temp_x", streamId, sequence: String(placeholder) }),
        broadcastSequence: null,
        workspaceId: "ws_1",
        _sequenceNum: placeholder,
        _status: "pending",
        _cachedAt: Date.now(),
      },
    ])

    expect(await getPersistedTail(streamId)).toEqual({ latestSequence: "100", latestBroadcastSequence: "50" })
  })

  it("returns nulls for an empty stream", async () => {
    expect(await getPersistedTail("stream_tail_empty")).toEqual({ latestSequence: null, latestBroadcastSequence: null })
  })
})

describe("bootstrap no-op rewrite skip (perceived-perf: silence spurious liveQuery emissions)", () => {
  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
  })

  it("does not rewrite a row when a second identical bootstrap applies (unchanged _cachedAt)", async () => {
    const streamId = "stream_noop"
    const events = [
      makeEvent({ id: "evt_1", streamId, sequence: "100" }),
      makeEvent({ id: "evt_2", streamId, sequence: "200" }),
    ]
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap(events, streamId))
    // Sentinel: if the second apply rewrites the row, _cachedAt jumps to "now"
    // and the assertion below catches it even when both applies share a ms.
    await db.events.update("evt_1", { _cachedAt: 12345 })
    const first = await db.events.get("evt_1")

    // Same content arrives again (cold open re-bootstrap). Without the skip,
    // every row would be re-put with a fresh _cachedAt.
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap(events, streamId))
    const second = await db.events.get("evt_1")

    expect(second).toEqual(first)
    expect(second?._cachedAt).toBe(12345)
  })

  it("still rewrites a row whose payload changed", async () => {
    const streamId = "stream_changed"
    const original = makeEvent({ id: "evt_1", streamId, sequence: "100" })
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([original], streamId))

    const edited = {
      ...original,
      payload: { messageId: "evt_1", contentMarkdown: "edited content" },
    }
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([edited], streamId))

    const row = await db.events.get("evt_1")
    expect((row?.payload as { contentMarkdown?: string }).contentMarkdown).toBe("edited content")
  })

  it("never skips a row carrying optimistic _status (the put intentionally clears it)", async () => {
    const streamId = "stream_status"
    const event = makeEvent({ id: "evt_1", streamId, sequence: "100" })
    await db.events.put({
      ...event,
      workspaceId: "ws_1",
      _sequenceNum: 100,
      _cachedAt: Date.now(),
      _status: "sent",
    })

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([event], streamId))

    const row = await db.events.get("evt_1")
    expect(row?._status).toBeUndefined()
  })

  it("skips no-op rewrites for non-message event types too", async () => {
    const streamId = "stream_member"
    const joined = makeEvent({ id: "evt_join", streamId, sequence: "100", eventType: "member_joined" })
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([joined], streamId))
    await db.events.update("evt_join", { _cachedAt: 12345 })
    const first = await db.events.get("evt_join")

    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([joined], streamId))
    const second = await db.events.get("evt_join")

    expect(second).toEqual(first)
    expect(second?._cachedAt).toBe(12345)
  })
})

describe("preserveBakedInAppData", () => {
  const inAppData: LinkPreviewSummary["inAppData"] = {
    kind: "message",
    accessTier: "full",
    authorName: "Author",
    contentPreview: "hi",
  }

  function preview(overrides: Partial<LinkPreviewSummary> & { id: string }): LinkPreviewSummary {
    return {
      url: `https://app.threa.io/p/${overrides.id}`,
      title: null,
      description: null,
      imageUrl: null,
      faviconUrl: null,
      siteName: null,
      contentType: "message_link",
      position: 0,
      ...overrides,
    }
  }

  it("carries baked inAppData forward by id when the broadcast lacks it", () => {
    const existing = [preview({ id: "lp_1", inAppData })]
    const incoming = [preview({ id: "lp_1" })]

    const merged = preserveBakedInAppData(incoming, existing)

    expect(merged[0].inAppData).toEqual(inAppData)
  })

  it("does not carry to a re-extracted preview with a fresh id", () => {
    const existing = [preview({ id: "lp_old", inAppData })]
    const incoming = [preview({ id: "lp_new" })]

    const merged = preserveBakedInAppData(incoming, existing)

    expect(merged[0].inAppData).toBeUndefined()
  })

  it("keeps the incoming inAppData when it already carries one", () => {
    const fresh = { ...inAppData, authorName: "Fresh" }
    const existing = [preview({ id: "lp_1", inAppData })]
    const incoming = [preview({ id: "lp_1", inAppData: fresh })]

    const merged = preserveBakedInAppData(incoming, existing)

    expect(merged[0].inAppData).toEqual(fresh)
  })

  it("returns the incoming array unchanged when nothing was baked", () => {
    const incoming = [preview({ id: "lp_1" })]

    const merged = preserveBakedInAppData(incoming, [preview({ id: "lp_1" })])

    expect(merged).toBe(incoming)
  })
})

describe("registerStreamSocketHandlers — read-state counter wiring", () => {
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

  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.events.clear()])
  })

  it("drops the deleted message's held activity rows on message_deleted (fix A2)", async () => {
    const streamId = "stream_del"
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [
        {
          id: "act_del",
          workspaceId: "ws_1",
          userId: "usr_1",
          activityType: "mention",
          streamId,
          messageId: "msg_del",
          actorId: "usr_2",
          actorType: "user",
          context: {},
          readAt: null,
          createdAt: new Date().toISOString(),
          isSelf: false,
          emoji: null,
        },
        {
          id: "act_keep",
          workspaceId: "ws_1",
          userId: "usr_1",
          activityType: "mention",
          streamId,
          messageId: "msg_keep",
          actorId: "usr_2",
          actorType: "user",
          context: {},
          readAt: null,
          createdAt: new Date().toISOString(),
          isSelf: false,
          emoji: null,
        },
      ],
      latestOrdinals: {},
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    emit("message:deleted", {
      workspaceId: "ws_1",
      streamId,
      messageId: "msg_del",
      deletedAt: new Date().toISOString(),
    })

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadActivities?.map((a) => a.id)).toEqual(["act_keep"])
    })

    cleanup()
  })
})

describe("registerStreamSocketHandlers — thread:updated patch (anchor-agnostic)", () => {
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

  const summary = {
    lastReplyAt: new Date().toISOString(),
    participants: [{ id: "user_2", type: "user" as const }],
    latestReply: { messageId: "msg_r1", actorId: "user_2", actorType: "user" as const, contentMarkdown: "a reply" },
  }

  beforeEach(async () => {
    await db.events.clear()
  })

  it("heals a message anchor (msg_) live by canonical id", async () => {
    const streamId = "stream_tu_msg"
    await db.events.put({
      ...makeEvent({ id: "evt_msg_parent", streamId, sequence: "10" }),
      payload: { messageId: "msg_anchor", contentMarkdown: "parent" },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())

    await emit("thread:updated", {
      workspaceId: "ws_1",
      streamId,
      parentStreamId: streamId,
      anchorId: "msg_anchor",
      threadId: "stream_thread_m",
      replyCount: 3,
      threadSummary: summary,
    })

    const row = await db.events.get("evt_msg_parent")
    expect(row?.payload).toMatchObject({
      messageId: "msg_anchor",
      threadId: "stream_thread_m",
      replyCount: 3,
      threadSummary: summary,
    })
    cleanup()
  })

  it("heals a card anchor (event_) live, located by event id", async () => {
    const streamId = "stream_tu_card"
    // A threadable card row (e.g. delegation:created) — anchored by its own id.
    await db.events.put({
      ...makeEvent({ id: "event_card1", streamId, sequence: "12", eventType: "delegation:created" }),
      payload: { delegationId: "dlg_1", title: "Do the thing" },
      workspaceId: "ws_1",
      _sequenceNum: 12,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())

    await emit("thread:updated", {
      workspaceId: "ws_1",
      streamId,
      parentStreamId: streamId,
      anchorId: "event_card1",
      threadId: "stream_thread_c",
      replyCount: 2,
      threadSummary: summary,
    })

    const row = await db.events.get("event_card1")
    expect(row?.payload).toMatchObject({
      delegationId: "dlg_1",
      threadId: "stream_thread_c",
      replyCount: 2,
      threadSummary: summary,
    })
    cleanup()
  })

  it("thread:updated writes the parent card's reply stats (absolute count, last-write-wins)", async () => {
    const streamId = "stream_tu_double"
    await db.events.put({
      ...makeEvent({ id: "evt_double_parent", streamId, sequence: "10" }),
      payload: { messageId: "msg_double", contentMarkdown: "parent" },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient())

    // The patch carries an ABSOLUTE count — re-delivery is idempotent (last-write-wins).
    await emit("thread:updated", {
      workspaceId: "ws_1",
      streamId,
      parentStreamId: streamId,
      anchorId: "msg_double",
      threadId: "stream_thread_d",
      replyCount: 4,
      threadSummary: summary,
    })
    await emit("thread:updated", {
      workspaceId: "ws_1",
      streamId,
      parentStreamId: streamId,
      anchorId: "msg_double",
      threadId: "stream_thread_d",
      replyCount: 4,
      threadSummary: summary,
    })

    const row = await db.events.get("evt_double_parent")
    expect(row?.payload).toMatchObject({ replyCount: 4, threadId: "stream_thread_d", threadSummary: summary })
    cleanup()
  })
})

describe("applyStreamBootstrap — threadStates healing (append mode)", () => {
  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
  })

  const healSummary = {
    lastReplyAt: new Date().toISOString(),
    participants: [{ id: "user_2", type: "user" as const }],
    latestReply: { messageId: "msg_r9", actorId: "user_2", actorType: "user" as const, contentMarkdown: "latest" },
  }

  it("heals a stale parent row behind the append cursor from threadStates", async () => {
    const streamId = "stream_heal"

    // Parent row persisted long ago; every live thread patch for it was missed.
    await db.events.put({
      ...makeEvent({ id: "evt_stale_parent", streamId, sequence: "10" }),
      payload: { messageId: "msg_stale_parent", contentMarkdown: "parent" },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: Date.now() - 60_000,
    })

    // Append response: only a newer unrelated event, plus the threadStates map.
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([makeEvent({ id: "evt_new", streamId, sequence: "20" })], streamId),
      syncMode: "append",
      snapshotAt: new Date().toISOString(),
      threadStates: [
        {
          anchorId: "msg_stale_parent",
          threadId: "stream_thread_1",
          replyCount: 6,
          threadSummary: healSummary,
        },
      ],
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const row = await db.events.get("evt_stale_parent")
    expect(row?.payload).toMatchObject({
      messageId: "msg_stale_parent",
      threadId: "stream_thread_1",
      replyCount: 6,
      threadSummary: healSummary,
    })
    // Bootstrap data, not a socket patch — the freshness watermark stays unset.
    expect(row?._patchedAt).toBeUndefined()
  })

  it("preserves a parent row patched by a socket handler after the snapshot", async () => {
    const streamId = "stream_heal_fresh"
    const snapshotAt = new Date(Date.now() - 5_000).toISOString()

    // Socket patch landed AFTER the bootstrap snapshot — it is fresher.
    await db.events.put({
      ...makeEvent({ id: "evt_fresh_parent", streamId, sequence: "10" }),
      payload: { messageId: "msg_fresh_parent", contentMarkdown: "parent", threadId: "stream_thread_2", replyCount: 7 },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: Date.now(),
      _patchedAt: Date.now(),
    })

    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      syncMode: "append",
      snapshotAt,
      threadStates: [
        {
          anchorId: "msg_fresh_parent",
          threadId: "stream_thread_2",
          replyCount: 6,
          threadSummary: null,
        },
      ],
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const row = await db.events.get("evt_fresh_parent")
    expect(row?.payload).toMatchObject({ replyCount: 7, threadId: "stream_thread_2" })
  })

  it("does not rewrite rows whose thread state already matches (no useless liveQuery churn)", async () => {
    const streamId = "stream_heal_noop"
    const cachedAt = Date.now() - 60_000

    await db.events.put({
      ...makeEvent({ id: "evt_noop_parent", streamId, sequence: "10" }),
      payload: {
        messageId: "msg_noop_parent",
        contentMarkdown: "parent",
        threadId: "stream_thread_3",
        replyCount: 2,
        threadSummary: null,
      },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: cachedAt,
    })

    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      syncMode: "append",
      snapshotAt: new Date().toISOString(),
      threadStates: [
        {
          anchorId: "msg_noop_parent",
          threadId: "stream_thread_3",
          replyCount: 2,
          threadSummary: null,
        },
      ],
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const row = await db.events.get("evt_noop_parent")
    expect(row?._cachedAt).toBe(cachedAt)
  })

  it("heals a card event's payload by anchorId (event_ anchor)", async () => {
    const streamId = "stream_heal_card"

    // A threadable card row persisted before its thread got replies.
    await db.events.put({
      ...makeEvent({ id: "event_card_stale", streamId, sequence: "10", eventType: "delegation:created" }),
      payload: { delegationId: "dlg_9", title: "task" },
      workspaceId: "ws_1",
      _sequenceNum: 10,
      _cachedAt: Date.now() - 60_000,
    })

    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([makeEvent({ id: "evt_new", streamId, sequence: "20" })], streamId),
      syncMode: "append",
      snapshotAt: new Date().toISOString(),
      threadStates: [
        {
          anchorId: "event_card_stale",
          threadId: "stream_thread_card",
          replyCount: 4,
          threadSummary: healSummary,
        },
      ],
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    const row = await db.events.get("event_card_stale")
    expect(row?.payload).toMatchObject({
      delegationId: "dlg_9",
      threadId: "stream_thread_card",
      replyCount: 4,
      threadSummary: healSummary,
    })
    expect(row?._patchedAt).toBeUndefined()
  })
})

describe("registerStreamSocketHandlers — shared-message slot ingestion (Amendment A)", () => {
  // Live events carry the slot carrier; handlers merge it into `db.slots` in the
  // same transaction as the event write. The bootstrap query cache is never
  // touched. The invalidate-refetch survives only as the deploy-skew fallback
  // for share-bearing events that arrive with NEITHER map.

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

  function okEntry(contentMarkdown: string, messageId = "msg_src"): SharedMessageSlot {
    return {
      type: "sharedMessage",
      state: "ok",
      messageId,
      streamId: "stream_src",
      authorId: "usr_9",
      authorType: "user",
      authorName: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown,
      editedAt: null,
      createdAt: "2026-04-23T10:00:00Z",
      attachments: [],
    }
  }

  const shareNodeContent = {
    type: "doc",
    content: [{ type: "sharedMessage", attrs: { messageId: "msg_src", streamId: "stream_src" } }],
  }

  async function readSlotMap(streamId: string): Promise<SlotMap> {
    const rows = await db.slots.where("streamId").equals(streamId).toArray()
    const map: SlotMap = {}
    for (const row of rows) map[row.slotKey] = row.value
    return map
  }

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.pendingMessages.clear()
    await db.slots.clear()
  })

  it("message:created merges the canonical wire map into db.slots and skips invalidation", async () => {
    const streamId = "stream_wire_hydration"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_share",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_new", contentJson: shareNodeContent },
      }),
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("from the wire") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("from the wire") })
    expect(invalidateQueries).not.toHaveBeenCalled()
    expect(queryClient.getQueryCache().find({ queryKey: streamKeys.bootstrap("ws_1", streamId) })).toBeUndefined()

    cleanup()
  })

  it("message:created rekeys a legacy-only payload (old server / sync_log) to canonical keys", async () => {
    const streamId = "stream_wire_legacy"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_share_legacy",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_new", contentJson: shareNodeContent },
      }),
      sharedMessages: { msg_src: okEntry("legacy wire") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("legacy wire") })
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  it("message:created prefers the canonical map when both carriers are present", async () => {
    const streamId = "stream_wire_both"
    const queryClient = new QueryClient()

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_share_both",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_new", contentJson: shareNodeContent },
      }),
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("canonical") },
      sharedMessages: { msg_src: okEntry("legacy") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("canonical") })

    cleanup()
  })

  it("message:created treats an empty canonical map as authoritative — no rows, no fallback", async () => {
    const streamId = "stream_wire_empty"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_share_empty",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_new", contentJson: shareNodeContent },
      }),
      slots: {},
    })

    expect(await readSlotMap(streamId)).toEqual({})
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  it("message:created falls back to invalidating when a share-bearing event carries no map (deploy skew)", async () => {
    const streamId = "stream_skew_created"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_skew",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_skew", contentJson: shareNodeContent },
      }),
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", streamId) })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.events("ws_1", streamId) })
    expect(await readSlotMap(streamId)).toEqual({})

    cleanup()
  })

  it("message:created with neither a map nor a share node writes no slots and skips invalidation", async () => {
    const streamId = "stream_plain"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_plain",
        streamId,
        sequence: "100",
        payload: { messageId: "msg_plain", contentJson: { type: "doc", content: [] } },
      }),
    })

    expect(await readSlotMap(streamId)).toEqual({})
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  it("message:edited merges the wire map into db.slots and skips invalidation", async () => {
    const streamId = "stream_wire_edit"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    await db.events.put({
      ...makeEvent({
        id: "evt_target",
        streamId,
        sequence: "50",
        payload: { messageId: "msg_target", contentMarkdown: "old" },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 50,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:edited", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_edit",
        streamId,
        sequence: "101",
        eventType: "message_edited",
        payload: { messageId: "msg_target", contentJson: shareNodeContent, contentMarkdown: "edited" },
      }),
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("edited source") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("edited source") })
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  // The card renders from this array and never fetches, so a live edit that
  // swaps or drops a memo has to rewrite it here. Nothing else would: the stale
  // row survives the whole session otherwise.
  it("message:edited replaces the cached memo summaries, including with an empty set", async () => {
    const streamId = "stream_memo_edit"
    const queryClient = new QueryClient()
    const stale = {
      memoId: "memo_old",
      title: "Launch in May",
      knowledgeType: "decision" as const,
      memoType: "conversation" as const,
      tags: [],
      updatedAt: "2026-07-01T00:00:00.000Z",
    }
    const fresh = { ...stale, memoId: "memo_new", title: "Timezone change" }

    for (const [id, memoEmbeds] of [
      ["evt_swap", [fresh]],
      ["evt_clear", []],
    ] as const) {
      await db.events.put({
        ...makeEvent({
          id,
          streamId,
          sequence: "50",
          payload: { messageId: `msg_${id}`, contentMarkdown: "old", memoEmbeds: [stale] },
        }),
        workspaceId: "ws_1",
        _sequenceNum: 50,
        _cachedAt: Date.now(),
      })

      const { socket, emit } = createTestSocket()
      const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
      await emit("message:edited", {
        workspaceId: "ws_1",
        streamId,
        event: makeEvent({
          id: `${id}_edit`,
          streamId,
          sequence: "101",
          eventType: "message_edited",
          payload: { messageId: `msg_${id}`, contentJson: {}, contentMarkdown: "edited", memoEmbeds },
        }),
      })
      cleanup()

      const row = await db.events.get(id)
      expect((row?.payload as { memoEmbeds: unknown }).memoEmbeds).toEqual(memoEmbeds)
    }
  })

  // An edit event can arrive AFTER a memo:updated patch it predates — the edit
  // resolved its summaries before the memo changed. Per memo, the strictly
  // newer updatedAt wins, so the card never repaints backwards; the edit still
  // decides WHICH memos have cards at all.
  it("message:edited does not repaint a summary backwards past a newer memo:updated patch", async () => {
    const streamId = "stream_memo_edit_race"
    const queryClient = new QueryClient()
    const base = {
      memoId: "memo_raced",
      knowledgeType: "decision" as const,
      memoType: "conversation" as const,
      tags: [],
    }
    const patched = { ...base, title: "Launch in June", updatedAt: "2026-07-31T12:00:00.000Z" }
    const preUpdate = { ...base, title: "Launch in May", updatedAt: "2026-07-31T11:00:00.000Z" }
    await db.events.put({
      ...makeEvent({
        id: "evt_raced",
        streamId,
        sequence: "50",
        payload: { messageId: "msg_raced", contentMarkdown: "old", memoEmbeds: [patched] },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 50,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    await emit("message:edited", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_raced_edit",
        streamId,
        sequence: "101",
        eventType: "message_edited",
        payload: { messageId: "msg_raced", contentJson: {}, contentMarkdown: "edited", memoEmbeds: [preUpdate] },
      }),
    })
    cleanup()

    const row = await db.events.get("evt_raced")
    expect((row?.payload as { memoEmbeds: Array<{ title: string }> }).memoEmbeds).toEqual([patched])
  })

  // Two memo edits inside the same millisecond tie on updatedAt — the card
  // version is what still orders them. Same-timestamp fixtures on purpose:
  // an updatedAt comparison alone would let the older edit win here.
  it("message:edited defers to the card version when updatedAt ties", async () => {
    const streamId = "stream_memo_version_tie"
    const queryClient = new QueryClient()
    const base = {
      memoId: "memo_tied",
      knowledgeType: "decision" as const,
      memoType: "conversation" as const,
      tags: [],
      updatedAt: "2026-07-31T12:00:00.000Z",
    }
    const patched = { ...base, title: "Second edit", version: 3 }
    const preUpdate = { ...base, title: "First edit", version: 2 }
    await db.events.put({
      ...makeEvent({
        id: "evt_tied",
        streamId,
        sequence: "50",
        payload: { messageId: "msg_tied", contentMarkdown: "old", memoEmbeds: [patched] },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 50,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    await emit("message:edited", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_tied_edit",
        streamId,
        sequence: "101",
        eventType: "message_edited",
        payload: { messageId: "msg_tied", contentJson: {}, contentMarkdown: "edited", memoEmbeds: [preUpdate] },
      }),
    })
    cleanup()

    const row = await db.events.get("evt_tied")
    expect((row?.payload as { memoEmbeds: Array<{ title: string }> }).memoEmbeds).toEqual([patched])
  })

  // Label pages render from their own query, not db.events; the backend
  // resolves their summaries fresh at read, so invalidation IS their repaint.
  it("memo:updated invalidates label message queries but not the label list", async () => {
    const streamId = "stream_memo_labels"
    const queryClient = new QueryClient()
    queryClient.setQueryData(["labels", "ws_1", "label_1", "messages"], [])
    queryClient.setQueryData(["labels", "ws_1"], [])

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    await emit("memo:updated", {
      streamId,
      memoId: "memo_a",
      summary: {
        memoId: "memo_a",
        title: "Launch in June",
        knowledgeType: "decision",
        memoType: "conversation",
        tags: [],
        updatedAt: "2026-07-31T12:00:00.000Z",
      },
    })
    cleanup()

    expect(queryClient.getQueryState(["labels", "ws_1", "label_1", "messages"])?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(["labels", "ws_1"])?.isInvalidated).toBe(false)
  })

  it("message:edited rekeys a legacy-only payload to canonical keys", async () => {
    const streamId = "stream_wire_edit_legacy"
    const queryClient = new QueryClient()
    await db.events.put({
      ...makeEvent({
        id: "evt_target_legacy",
        streamId,
        sequence: "50",
        payload: { messageId: "msg_target", contentMarkdown: "old" },
      }),
      workspaceId: "ws_1",
      _sequenceNum: 50,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:edited", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_edit_legacy",
        streamId,
        sequence: "101",
        eventType: "message_edited",
        payload: { messageId: "msg_target", contentJson: shareNodeContent, contentMarkdown: "edited" },
      }),
      sharedMessages: { msg_src: okEntry("legacy edit") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("legacy edit") })

    cleanup()
  })

  it("message:edited falls back to invalidating when a share-bearing edit carries no map (deploy skew)", async () => {
    const streamId = "stream_skew_edited"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:edited", {
      workspaceId: "ws_1",
      streamId,
      event: makeEvent({
        id: "evt_edit_skew",
        streamId,
        sequence: "101",
        eventType: "message_edited",
        payload: { messageId: "msg_target", contentJson: shareNodeContent, contentMarkdown: "edited" },
      }),
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", streamId) })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.events("ws_1", streamId) })

    cleanup()
  })

  it("pointer:invalidated merges the fresh entry over the stale one without invalidating", async () => {
    const streamId = "stream_pointer_patch"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId,
        slotKey: sharedMessageSlotKey("msg_src"),
        value: okEntry("stale content"),
        _cachedAt: Date.now(),
      },
      {
        workspaceId: "ws_1",
        streamId,
        slotKey: sharedMessageSlotKey("msg_other"),
        value: okEntry("untouched", "msg_other"),
        _cachedAt: Date.now(),
      },
    ])

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("pointer:invalidated", {
      workspaceId: "ws_1",
      targetStreamId: streamId,
      sourceMessageId: "msg_src",
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("fresh content") },
    })

    expect(await readSlotMap(streamId)).toEqual({
      [sharedMessageSlotKey("msg_src")]: okEntry("fresh content"),
      [sharedMessageSlotKey("msg_other")]: okEntry("untouched", "msg_other"),
    })
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  it("pointer:invalidated rekeys a legacy-only payload to canonical keys", async () => {
    const streamId = "stream_pointer_legacy"
    const queryClient = new QueryClient()

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("pointer:invalidated", {
      workspaceId: "ws_1",
      targetStreamId: streamId,
      sourceMessageId: "msg_src",
      sharedMessages: { msg_src: okEntry("legacy fresh") },
    })

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("legacy fresh") })

    cleanup()
  })

  it("pointer:invalidated without a map falls back to invalidating (deploy skew)", async () => {
    const streamId = "stream_pointer_skew"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("pointer:invalidated", {
      workspaceId: "ws_1",
      targetStreamId: streamId,
      sourceMessageId: "msg_src",
    })

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.bootstrap("ws_1", streamId) })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: streamKeys.events("ws_1", streamId) })

    cleanup()
  })

  it("messages:moved merges the destination carrier under the destination stream (B3)", async () => {
    const sourceStreamId = "stream_move_src"
    const destinationStreamId = "stream_move_dst"
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries")

    const { socket, emit } = createTestSocket()
    // The handler registered for the DESTINATION room applies the destination leg.
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", destinationStreamId, queryClient)

    await emit("messages:moved", {
      workspaceId: "ws_1",
      streamId: sourceStreamId,
      sourceStreamId,
      destinationStreamId,
      targetMessageId: "msg_target",
      movedMessageIds: ["msg_moved"],
      thread: {
        ...makeBootstrap([], destinationStreamId).stream,
        type: "thread",
        parentStreamId: sourceStreamId,
        parentAnchorId: "msg_target",
        rootStreamId: sourceStreamId,
      },
      events: [
        makeEvent({
          id: "evt_moved",
          streamId: destinationStreamId,
          sequence: "10",
          payload: { messageId: "msg_moved", contentJson: shareNodeContent },
        }),
      ],
      removedEventIds: ["evt_moved"],
      sourceTombstoneEvent: makeEvent({
        id: "evt_tombstone",
        streamId: sourceStreamId,
        sequence: "99",
        eventType: "messages:moved",
        payload: {},
      }),
      parentReplyCount: 1,
      parentThreadSummary: null,
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("moved hydration") },
    })

    expect(await readSlotMap(destinationStreamId)).toEqual({
      [sharedMessageSlotKey("msg_src")]: okEntry("moved hydration"),
    })
    // The source leg carries no carrier — nothing lands under the source stream.
    expect(await readSlotMap(sourceStreamId)).toEqual({})
    expect(invalidateQueries).not.toHaveBeenCalled()

    cleanup()
  })

  it("never creates a bootstrap cache entry — slots land in db.slots only", async () => {
    const streamId = "stream_no_cache"
    const queryClient = new QueryClient()

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("pointer:invalidated", {
      workspaceId: "ws_1",
      targetStreamId: streamId,
      sourceMessageId: "msg_src",
      slots: { [sharedMessageSlotKey("msg_src")]: okEntry("wire") },
    })

    expect(queryClient.getQueryCache().find({ queryKey: streamKeys.bootstrap("ws_1", streamId) })).toBeUndefined()
    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okEntry("wire") })

    cleanup()
  })
})

describe("applyStreamBootstrap — slot store ingestion (Amendment A)", () => {
  function okSlot(messageId: string, contentMarkdown: string): SharedMessageSlot {
    return {
      type: "sharedMessage",
      state: "ok",
      messageId,
      streamId: "stream_src",
      authorId: "usr_9",
      authorType: "user",
      authorName: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown,
      editedAt: null,
      createdAt: "2026-04-23T10:00:00Z",
      attachments: [],
    }
  }

  async function readSlotMap(streamId: string): Promise<SlotMap> {
    const rows = await db.slots.where("streamId").equals(streamId).toArray()
    const map: SlotMap = {}
    for (const row of rows) map[row.slotKey] = row.value
    return map
  }

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.slots.clear()
  })

  it("replace mode refreshes in-window keys and preserves out-of-window page merges (B2)", async () => {
    const streamId = "stream_bootstrap_replace"
    await db.slots.bulkPut([
      {
        workspaceId: "ws_1",
        streamId,
        slotKey: sharedMessageSlotKey("msg_fresh"),
        value: okSlot("msg_fresh", "stale snapshot"),
        _cachedAt: 1,
      },
      // Merged by an older page whose events sit OUTSIDE the bootstrap window.
      {
        workspaceId: "ws_1",
        streamId,
        slotKey: sharedMessageSlotKey("msg_page"),
        value: okSlot("msg_page", "older page"),
        _cachedAt: 1,
      },
    ])

    const bootstrap: StreamBootstrap = {
      ...makeBootstrap(
        [
          makeEvent({
            id: "evt_1",
            streamId,
            sequence: "10",
            payload: {
              messageId: "msg_1",
              contentJson: {
                type: "doc",
                content: [{ type: "sharedMessage", attrs: { messageId: "msg_fresh", streamId: "stream_src" } }],
              },
            },
          }),
        ],
        streamId
      ),
      syncMode: "replace",
      slots: { [sharedMessageSlotKey("msg_fresh")]: okSlot("msg_fresh", "fresh") },
    }
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await readSlotMap(streamId)).toEqual({
      [sharedMessageSlotKey("msg_fresh")]: okSlot("msg_fresh", "fresh"),
      [sharedMessageSlotKey("msg_page")]: okSlot("msg_page", "older page"),
    })
  })

  it("append mode merges incoming keys and retains keys the response omits", async () => {
    const streamId = "stream_bootstrap_append"
    await db.slots.put({
      workspaceId: "ws_1",
      streamId,
      slotKey: sharedMessageSlotKey("msg_existing"),
      value: okSlot("msg_existing", "existing"),
      _cachedAt: 1,
    })

    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      syncMode: "append",
      slots: { [sharedMessageSlotKey("msg_new")]: okSlot("msg_new", "new") },
    }
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await readSlotMap(streamId)).toEqual({
      [sharedMessageSlotKey("msg_existing")]: okSlot("msg_existing", "existing"),
      [sharedMessageSlotKey("msg_new")]: okSlot("msg_new", "new"),
    })
  })

  it("rekeys a legacy-only bootstrap carrier (old server) to canonical keys", async () => {
    const streamId = "stream_bootstrap_legacy"
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      syncMode: "replace",
      sharedMessages: { msg_src: okSlot("msg_src", "legacy") },
    }
    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await readSlotMap(streamId)).toEqual({ [sharedMessageSlotKey("msg_src")]: okSlot("msg_src", "legacy") })
  })

  it("toCachedStreamBootstrap strips both carrier fields before the TanStack envelope", () => {
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], "stream_strip"),
      slots: { [sharedMessageSlotKey("msg_1")]: okSlot("msg_1", "x") },
      sharedMessages: { msg_1: okSlot("msg_1", "x") },
    }
    const cached = toCachedStreamBootstrap(bootstrap)
    expect(cached.slots).toBeUndefined()
    expect(cached.sharedMessages).toBeUndefined()
  })
})

describe("applyStreamBootstrap standalone frontier persistence (non-member unlock)", () => {
  const streamId = "stream_frontier"

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.streamReadState.clear()
    await db.pendingMessages.clear()
  })

  it("persists the bootstrap's standalone frontier row", async () => {
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      readState: { lastReadEventId: "evt_9", lastReadSequence: "42", lastReadAt: "2026-07-24T00:00:00.000Z" },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
      lastReadAt: "2026-07-24T00:00:00.000Z",
    })
  })

  it("seeds a never-read sentinel for a confirmed non-member absence — they have no membership mirror to fall back to", async () => {
    const bootstrap: StreamBootstrap = { ...makeBootstrap([], streamId), readState: null }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      streamId,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: null,
    })
  })

  it("seeds a never-read sentinel for a confirmed absence even when a membership row exists — membership carries no frontier", async () => {
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      membership: {
        streamId,
        memberId: "user_1",
        notificationLevel: null,
        joinedAt: new Date().toISOString(),
      },
      readState: null,
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({
      streamId,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: null,
    })
  })

  it("a confirmed absence does not clobber an existing frontier row", async () => {
    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
      lastReadAt: "2026-07-24T00:00:00.000Z",
      _cachedAt: Date.now(),
    })

    // A snapshot with no row (null) must not wipe a fresher locally-written row.
    await applyStreamBootstrap("ws_1", streamId, { ...makeBootstrap([], streamId), readState: null })

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({ lastReadEventId: "evt_9" })
  })

  it("never overwrites an explicit unread-to-zero row with a snapshot frontier that may predate the unread", async () => {
    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: "2026-07-24T12:00:00.000Z",
      _cachedAt: Date.now(),
    })
    const bootstrap: StreamBootstrap = {
      ...makeBootstrap([], streamId),
      readState: { lastReadEventId: "evt_9", lastReadSequence: "42", lastReadAt: "2026-07-24T00:00:00.000Z" },
    }

    await applyStreamBootstrap("ws_1", streamId, bootstrap)

    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({ lastReadEventId: null })
  })

  it("max-merges the incoming row over the stored sequence — a stale snapshot never regresses the frontier", async () => {
    await db.streamReadState.put({
      id: `ws_1:${streamId}`,
      workspaceId: "ws_1",
      streamId,
      lastReadEventId: "evt_high",
      lastReadSequence: "90",
      lastReadAt: "2026-07-24T00:00:00.000Z",
      _cachedAt: Date.now(),
    })

    await applyStreamBootstrap("ws_1", streamId, {
      ...makeBootstrap([], streamId),
      readState: { lastReadEventId: "evt_low", lastReadSequence: "42", lastReadAt: "2026-07-24T00:00:00.000Z" },
    })
    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({ lastReadEventId: "evt_high" })

    await applyStreamBootstrap("ws_1", streamId, {
      ...makeBootstrap([], streamId),
      readState: { lastReadEventId: "evt_higher", lastReadSequence: "100", lastReadAt: "2026-07-24T01:00:00.000Z" },
    })
    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toMatchObject({ lastReadEventId: "evt_higher" })
  })

  it("leaves the store untouched when the field is absent (payload cached before it shipped)", async () => {
    await applyStreamBootstrap("ws_1", streamId, makeBootstrap([], streamId))
    expect(await db.streamReadState.get(`ws_1:${streamId}`)).toBeUndefined()
  })
})

describe("registerStreamSocketHandlers — stream context rows", () => {
  const STREAM_ID = "stream_ctx"
  const THREAD_ID = "stream_ctx_thread"

  function createTestSocket() {
    const handlers = new Map<string, Set<(payload: unknown) => unknown>>()
    const socket = {
      on(event: string, handler: (payload: unknown) => unknown) {
        const set = handlers.get(event) ?? new Set()
        set.add(handler)
        handlers.set(event, set)
        return this
      },
      off(event: string, handler: (payload: unknown) => unknown) {
        handlers.get(event)?.delete(handler)
        return this
      },
    } as unknown as Socket

    return {
      socket,
      async emit(event: string, payload: unknown) {
        await Promise.all([...(handlers.get(event) ?? [])].map((handler) => handler(payload)))
      },
    }
  }

  function messageEvent(
    messageId: string,
    body: { href?: string; attachments?: AttachmentSummary[] },
    sequence = "10"
  ): StreamEvent {
    return {
      id: `event_${messageId}`,
      streamId: STREAM_ID,
      sequence,
      eventType: "message_created",
      payload: {
        messageId,
        contentMarkdown: "hello",
        contentJson: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: body.href
                ? [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: body.href } }] }]
                : [{ type: "text", text: "x" }],
            },
          ],
        },
        attachments: body.attachments ?? [],
      },
      actorId: "usr_1",
      actorType: "user",
      createdAt: "2026-07-01T10:00:00.000Z",
    }
  }

  let harness: ReturnType<typeof createTestSocket>
  let unregister: () => void

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.streamContextItems.clear()
    await db.streams.put({
      id: STREAM_ID,
      workspaceId: "ws_1",
      type: "channel",
      displayName: "ctx",
      slug: "ctx",
      description: null,
      visibility: "public",
      parentStreamId: null,
      rootStreamId: null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      archivedAt: null,
      _cachedAt: Date.now(),
    } as never)
    harness = createTestSocket()
    unregister = registerStreamSocketHandlers(harness.socket, "ws_1", STREAM_ID, new QueryClient())
  })

  afterEach(() => unregister())

  it("writes a pending row per artifact when a message lands", async () => {
    await harness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: messageEvent("msg_1", {
        href: "https://example.com/a",
        attachments: [{ id: "att_1", filename: "p.png", mimeType: "image/png", sizeBytes: 5 }],
      }),
    })

    const rows = await db.streamContextItems.toArray()
    expect(rows.map((r) => [r.key, r.streamId, r.rootStreamId, r._status]).sort()).toEqual([
      ["link:https://example.com/a:msg_1", STREAM_ID, STREAM_ID, "pending"],
      ["media:att_1:msg_1", STREAM_ID, STREAM_ID, "pending"],
    ])
    expect(rows.every((r) => r.occurredAt === "2026-07-01T10:00:00.000Z")).toBe(true)
  })

  it("files a thread's rows under its root so the tree feed sees them", async () => {
    await db.streams.put({
      id: THREAD_ID,
      workspaceId: "ws_1",
      type: "thread",
      displayName: null,
      slug: null,
      description: null,
      visibility: "private",
      parentStreamId: STREAM_ID,
      rootStreamId: STREAM_ID,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      archivedAt: null,
      _cachedAt: Date.now(),
    } as never)
    const threadHarness = createTestSocket()
    const off = registerStreamSocketHandlers(threadHarness.socket, "ws_1", THREAD_ID, new QueryClient())

    await threadHarness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: THREAD_ID,
      event: { ...messageEvent("msg_t", { href: "https://example.com/t" }), streamId: THREAD_ID },
    })
    off()

    expect(await db.streamContextItems.get("link:https://example.com/t:msg_t")).toMatchObject({
      streamId: THREAD_ID,
      rootStreamId: STREAM_ID,
    })
  })

  it("rebuilds a message's rows on edit, dropping a link the edit removed", async () => {
    await harness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: messageEvent("msg_1", {
        href: "https://example.com/gone",
        attachments: [{ id: "att_1", filename: "p.png", mimeType: "image/png", sizeBytes: 5 }],
      }),
    })

    await harness.emit("message:edited", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: {
        id: "event_edit",
        streamId: STREAM_ID,
        sequence: "11",
        eventType: "message_edited",
        payload: {
          messageId: "msg_1",
          contentMarkdown: "hello",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "x", marks: [{ type: "link", attrs: { href: "https://example.com/new" } }] },
                ],
              },
            ],
          },
        },
        actorId: "usr_1",
        actorType: "user",
        createdAt: "2026-07-01T11:00:00.000Z",
      },
    })

    const keys = (await db.streamContextItems.toArray()).map((r) => r.key).sort()
    // The attachment row survives (the edit payload doesn't carry attachments);
    // the removed link is gone and the new one is there.
    expect(keys).toEqual(["link:https://example.com/new:msg_1", "media:att_1:msg_1"])
  })

  it("drops a deleted message's rows", async () => {
    await harness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: messageEvent("msg_1", { href: "https://example.com/a" }),
    })
    await harness.emit("message:deleted", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      messageId: "msg_1",
      deletedAt: "2026-07-01T12:00:00.000Z",
    })
    expect(await db.streamContextItems.toArray()).toEqual([])
  })

  it("writes memo rows from a memos:captured broadcast, anchored on the source message", async () => {
    await harness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: { ...messageEvent("msg_9", {}, "5"), createdAt: "2026-07-01T09:00:00.000Z" },
    })

    await harness.emit("stream:memos_captured", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: {
        id: "event_memos",
        streamId: STREAM_ID,
        sequence: "20",
        eventType: "memos:captured",
        payload: {
          memos: [{ memoId: "memo_1", title: "Decision", knowledgeType: "decision", sourceMessageIds: ["msg_9"] }],
        },
        actorId: null,
        actorType: null,
        createdAt: "2026-07-01T13:00:00.000Z",
      },
    })

    // Anchored on the source message's own time, not the debounced capture time.
    expect(await db.streamContextItems.get("memo:memo_1:msg_9")).toMatchObject({
      category: "memo",
      sourceMessageId: "msg_9",
      streamId: STREAM_ID,
      occurredAt: "2026-07-01T09:00:00.000Z",
    })
  })

  it("re-homes moved messages' rows onto the destination thread", async () => {
    await harness.emit("message:created", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: messageEvent("msg_1", { href: "https://example.com/a" }),
    })

    const thread = {
      id: THREAD_ID,
      workspaceId: "ws_1",
      type: "thread",
      displayName: null,
      slug: null,
      description: null,
      visibility: "private",
      parentStreamId: STREAM_ID,
      rootStreamId: STREAM_ID,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "usr_1",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      archivedAt: null,
    } as unknown as Stream

    // Emitted on the SOURCE stream's handler only: the destination is a
    // brand-new thread with no subscription at move time, so the destination leg
    // does not exist in the real fan-out.
    await harness.emit("messages:moved", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      sourceStreamId: STREAM_ID,
      destinationStreamId: THREAD_ID,
      targetMessageId: "msg_target",
      movedMessageIds: ["msg_1"],
      thread,
      events: [],
      removedEventIds: [],
      sourceTombstoneEvent: {
        id: "event_tomb",
        streamId: STREAM_ID,
        sequence: "30",
        eventType: "messages_moved",
        payload: {},
        actorId: "usr_1",
        actorType: "user",
        createdAt: "2026-07-01T14:00:00.000Z",
      },
      parentReplyCount: 1,
      parentThreadSummary: null,
    })

    expect(await db.streamContextItems.get("link:https://example.com/a:msg_1")).toMatchObject({
      streamId: THREAD_ID,
      rootStreamId: STREAM_ID,
    })
  })

  it("leaves a reconciled server row untouched when its event is replayed", async () => {
    const event = messageEvent("msg_1", { href: "https://example.com/a" })
    await harness.emit("message:created", { workspaceId: "ws_1", streamId: STREAM_ID, event })

    // The read endpoint seeds the server's copy over the same key.
    const seeded = await db.streamContextItems.get("link:https://example.com/a:msg_1")
    await db.streamContextItems.put({
      ...seeded!,
      groupKey: "https://example.com/a",
      groupRef: "link:https://example.com/a",
      detail: { ...seeded!.detail, title: "Example" },
      _status: undefined,
    })

    // Catch-up replays the same event through the same handler.
    await harness.emit("message:created", { workspaceId: "ws_1", streamId: STREAM_ID, event })

    expect(await db.streamContextItems.get("link:https://example.com/a:msg_1")).toMatchObject({
      detail: expect.objectContaining({ title: "Example" }),
      _status: undefined,
    })
  })

  it("keeps a message's rows on edit when its created event is outside the cached window", async () => {
    // A seeded server row whose message_created event this session never cached.
    await db.streamContextItems.put({
      key: "link:https://example.com/old:msg_old",
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      rootStreamId: STREAM_ID,
      category: "link",
      refKind: "url",
      refId: "https://example.com/old",
      groupKey: "https://example.com/old",
      groupRef: "link:https://example.com/old",
      sourceMessageId: "msg_old",
      authorId: "usr_1",
      occurredAt: "2026-06-01T10:00:00.000Z",
      sequence: "1",
      snippet: "old",
      occurrenceCount: 1,
      detail: { url: "https://example.com/old", title: "Old" },
      _cachedAt: Date.now(),
    } as never)

    await harness.emit("message:edited", {
      workspaceId: "ws_1",
      streamId: STREAM_ID,
      event: {
        id: "event_edit_old",
        streamId: STREAM_ID,
        sequence: "99",
        eventType: "message_edited",
        payload: { messageId: "msg_old", contentMarkdown: "typo fixed", contentJson: { type: "doc", content: [] } },
        actorId: "usr_1",
        actorType: "user",
        createdAt: "2026-07-01T15:00:00.000Z",
      },
    })

    expect(await db.streamContextItems.get("link:https://example.com/old:msg_old")).toBeDefined()
  })
})

describe("registerStreamSocketHandlers — one handler set per (event source, stream)", () => {
  function createCountingSocket() {
    const handlers = new Map<string, Set<(payload: unknown) => void>>()
    const on = vi.fn((event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
    })
    const off = vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.get(event)?.delete(handler)
    })
    const socket = {
      on(event: string, handler: (payload: unknown) => void) {
        on(event, handler)
        return this
      },
      off(event: string, handler: (payload: unknown) => void) {
        off(event, handler)
        return this
      },
    } as unknown as Socket
    return {
      socket,
      on,
      off,
      async emit(event: string, payload: unknown) {
        await Promise.all(Array.from(handlers.get(event) ?? []).map((handler) => handler(payload)))
      },
    }
  }

  function messageCreated(streamId: string, id: string, sequence: string, extraPayload: Record<string, unknown> = {}) {
    return {
      workspaceId: "ws_1",
      streamId,
      event: {
        id,
        streamId,
        sequence,
        eventType: "message_created",
        payload: {
          messageId: id,
          contentMarkdown: "hello https://example.com/x",
          contentJson: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "hello https://example.com/x" }],
              },
            ],
          },
          ...extraPayload,
        },
        actorId: "user_1",
        actorType: "user",
        createdAt: new Date().toISOString(),
      },
    }
  }

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.streamContextItems.clear()
    await db.pendingMessages.clear()
    clearDecryptCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("two registrations against one event source bind the listener set once", async () => {
    const streamId = "stream_shared_once"
    await db.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      rootStreamId: streamId,
      _cachedAt: Date.now(),
    } as never)

    const { socket, emit } = createCountingSocket()
    // One scope read per apply — two bindings would read twice.
    const scopeReads = vi.spyOn(db.streams, "get")
    const queryClient = new QueryClient()

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", messageCreated(streamId, "evt_shared", "10"))

    expect({
      scopeReads: scopeReads.mock.calls.length,
      persisted: (await db.events.get("evt_shared"))?.sequence,
    }).toEqual({ scopeReads: 1, persisted: "10" })

    releaseA()
    releaseB()
  })

  it("the listeners survive until the last release", async () => {
    const streamId = "stream_last_release"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    releaseA()
    await emit("message:created", messageCreated(streamId, "evt_after_first_release", "10"))
    expect(await db.events.get("evt_after_first_release")).toBeDefined()

    releaseB()
    await emit("message:created", messageCreated(streamId, "evt_after_last_release", "11"))
    expect(await db.events.get("evt_after_last_release")).toBeUndefined()
  })

  it("releasing twice does not tear down a live registration", async () => {
    const streamId = "stream_strictmode"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    releaseA()
    releaseA()
    releaseB()

    await emit("message:created", messageCreated(streamId, "evt_strictmode", "10"))
    expect(await db.events.get("evt_strictmode")).toBeDefined()
  })

  it("a registration without an engine is not shared with the gated one", async () => {
    const streamId = "stream_two_sources"
    const gated = createCountingSocket()
    const raw = createCountingSocket()
    const queryClient = new QueryClient()

    const releaseGated = registerStreamSocketHandlers(gated.socket, "ws_1", streamId, queryClient)
    const releaseRaw = registerStreamSocketHandlers(raw.socket, "ws_1", streamId, queryClient)

    await gated.emit("message:created", messageCreated(streamId, "evt_gated_only", "9"))
    expect(await db.events.get("evt_gated_only")).toBeDefined()

    releaseGated()
    await raw.emit("message:created", messageCreated(streamId, "evt_raw_only", "10"))
    expect(await db.events.get("evt_raw_only")).toBeDefined()

    releaseRaw()
  })

  it("a second registrant with mismatched wiring throws", () => {
    const streamId = "stream_mismatch"
    const { socket } = createCountingSocket()
    const queryClient = new QueryClient()

    const release = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, {
      onSequenceGap: () => {},
    })

    expect(() =>
      registerStreamSocketHandlers(socket, "ws_1", streamId, new QueryClient(), {
        onSequenceGap: () => {},
      })
    ).toThrow(/queryClient/)

    release()
  })

  it("every registrant's gap callback fires, and a released one stops", async () => {
    const streamId = "stream_gap_fanout"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()
    const gapsA: unknown[] = []
    const gapsB: unknown[] = []

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, {
      onSequenceGap: (gap) => gapsA.push(gap),
    })
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, {
      onSequenceGap: (gap) => gapsB.push(gap),
    })

    await emit("message:created", messageCreated(streamId, "evt_gap_base", "10"))
    await emit("message:created", messageCreated(streamId, "evt_gap_jump", "20"))

    expect({ gapsA, gapsB }).toEqual({
      gapsA: [{ streamId, afterSequence: "10" }],
      gapsB: [{ streamId, afterSequence: "10" }],
    })

    releaseA()
    await emit("message:created", messageCreated(streamId, "evt_gap_jump_again", "40"))

    expect({ gapsA, gapsB }).toEqual({
      gapsA: [{ streamId, afterSequence: "10" }],
      gapsB: [
        { streamId, afterSequence: "10" },
        { streamId, afterSequence: "20" },
      ],
    })

    releaseB()
  })

  it("two registrants sharing ONE callback reference keep the survivor's subscription", async () => {
    const streamId = "stream_gap_same_reference"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()
    const gaps: unknown[] = []
    // One reference for both holders: the per-registration wrapper is what makes
    // them distinct Set members, so releasing A must not unsubscribe B.
    const onGap = (gap: unknown) => gaps.push(gap)

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, { onSequenceGap: onGap })
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, { onSequenceGap: onGap })

    releaseA()
    await emit("message:created", messageCreated(streamId, "evt_same_ref_base", "10"))
    await emit("message:created", messageCreated(streamId, "evt_same_ref_jump", "20"))

    expect(gaps).toEqual([{ streamId, afterSequence: "10" }])

    releaseB()
  })

  it("a registrant that joins a gap-less registration still receives gaps", async () => {
    const streamId = "stream_gap_late_join"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()
    const gaps: unknown[] = []

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, {
      onSequenceGap: (gap) => gaps.push(gap),
    })

    await emit("message:created", messageCreated(streamId, "evt_late_base", "10"))
    await emit("message:created", messageCreated(streamId, "evt_late_jump", "20"))

    expect(gaps).toEqual([{ streamId, afterSequence: "10" }])

    releaseA()
    releaseB()
  })

  it("an E2E self-send seeds the decrypt cache exactly once", async () => {
    const streamId = "stream_e2e_shared"
    const plaintextJson = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "secret" }] }] }
    await db.events.put({
      id: "temp_e2e",
      workspaceId: "ws_1",
      streamId,
      sequence: "999",
      _sequenceNum: 999,
      eventType: "message_created",
      payload: { messageId: "temp_e2e", contentMarkdown: "secret", contentJson: plaintextJson },
      actorId: "user_1",
      actorType: "user",
      createdAt: new Date().toISOString(),
      _status: "pending",
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createCountingSocket()
    // One `stream.eventApply` sample per handler run — the direct count of how
    // many times the shared binding applied this event.
    const capture = new PerfCapture()
    armPerfCapture(capture)
    const queryClient = new QueryClient()

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit(
      "message:created",
      messageCreated(streamId, "evt_e2e_server", "1000", {
        clientMessageId: "temp_e2e",
        contentMarkdown: "🔒 Encrypted",
        contentJson: null,
        ciphertext: "base64ciphertext",
        envelope: { v: 2 },
      })
    )

    const cached = getCachedDecryption("evt_e2e_server")
    expect({
      status: cached?.status,
      markdown: cached?.value?.contentMarkdown,
      applies: capture.snapshot().filter((sample) => sample.name === "stream.eventApply").length,
    }).toEqual({ status: "decrypted", markdown: "secret", applies: 1 })

    armPerfCapture(NO_CAPTURE)
    releaseA()
    releaseB()
  })

  it("the registry drops its entry when the last holder releases", async () => {
    const streamId = "stream_registry_drop"
    const { socket, emit } = createCountingSocket()
    const queryClient = new QueryClient()

    const releaseA = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    const releaseB = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)
    releaseA()
    releaseB()

    // A dropped entry is proven by the next registrant binding afresh rather
    // than reusing a zero-count corpse — and by its handlers working.
    const releaseC = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient, {
      onSequenceGap: () => {},
    })

    await emit("message:created", messageCreated(streamId, "evt_registry_drop", "10"))
    expect(await db.events.get("evt_registry_drop")).toBeDefined()

    releaseC()
  })
})

describe("registerStreamSocketHandlers — stream:activity is the single preview writer", () => {
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

  const contentJson = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "live" }] }],
  }

  function messageCreated(streamId: string, id: string, sequence: string, payload: Record<string, unknown> = {}) {
    return {
      workspaceId: "ws_1",
      streamId,
      event: {
        id,
        streamId,
        sequence,
        eventType: "message_created",
        payload: { messageId: id, contentMarkdown: "live", contentJson, ...payload },
        actorId: "user_7",
        actorType: "user",
        createdAt: "2026-08-04T10:00:00.000Z",
      },
    }
  }

  const bootstrapPreview = {
    authorId: "user_1",
    authorType: "user" as const,
    content: "from the bootstrap",
    createdAt: "2026-08-04T09:00:00.000Z",
  }

  async function seedStream(streamId: string) {
    await db.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      rootStreamId: streamId,
      lastMessagePreview: bootstrapPreview,
      _cachedAt: Date.now(),
    } as never)
  }

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
    await db.streamContextItems.clear()
    await db.pendingMessages.clear()
    await db.slots.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("a live message writes no preview and no bootstrap cache entry", async () => {
    const streamId = "stream_single_writer"
    await seedStream(streamId)

    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      streams: [{ id: streamId, lastMessagePreview: bootstrapPreview }],
    } as unknown as WorkspaceBootstrap)
    const bootstrapBefore = queryClient.getQueryData(workspaceKeys.bootstrap("ws_1"))

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", messageCreated(streamId, "evt_single", "10"))

    expect({
      persisted: (await db.events.get("evt_single"))?.sequence,
      preview: (await db.streams.get(streamId))?.lastMessagePreview,
      bootstrapUnchanged: queryClient.getQueryData(workspaceKeys.bootstrap("ws_1")) === bootstrapBefore,
    }).toEqual({ persisted: "10", preview: bootstrapPreview, bootstrapUnchanged: true })

    cleanup()
  })

  it("a message:created applied without a SyncEngine still writes the event and does not throw", async () => {
    const streamId = "stream_no_engine"
    const queryClient = new QueryClient()

    // No workspace handlers registered — the raw-socket surface a draft panel
    // mounted outside the SyncEngine provider gets (D2). Nothing writes the
    // preview there, and nothing reads one either.
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit("message:created", messageCreated(streamId, "evt_no_engine", "10"))

    expect({
      persisted: (await db.events.get("evt_no_engine"))?.sequence,
      row: await db.streams.get(streamId),
    }).toEqual({ persisted: "10", row: undefined })

    cleanup()
  })

  it("the share-fallback invalidation still fires for a map-less share-bearing event", async () => {
    const streamId = "stream_share_fallback"
    await seedStream(streamId)

    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)

    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", streamId, queryClient)

    await emit(
      "message:created",
      messageCreated(streamId, "evt_share_fallback", "10", {
        contentJson: {
          type: "doc",
          content: [{ type: "sharedMessage", attrs: { messageId: "msg_src", streamId: "stream_src" } }],
        },
      })
    )

    expect(invalidateQueries.mock.calls.map((call) => call[0]?.queryKey)).toEqual([
      streamKeys.bootstrap("ws_1", streamId),
      streamKeys.events("ws_1", streamId),
    ])

    cleanup()
  })
})

describe("registerStreamSocketHandlers — stream:created never treats an aside as the anchor's thread", () => {
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

  beforeEach(async () => {
    await db.events.clear()
    await db.streams.clear()
  })

  it("writes no threadId for an aside anchored on a message, while a thread still claims it", async () => {
    const hostId = "stream_host_aside_gate"
    await db.events.put({
      ...makeEvent({ id: "evt_anchor", streamId: hostId, sequence: "1", payload: { messageId: "msg_anchor" } }),
      workspaceId: "ws_1",
      _sequenceNum: 1,
      _cachedAt: Date.now(),
    })
    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerStreamSocketHandlers(socket, "ws_1", hostId, queryClient)
    const anchored = (id: string, type: "aside" | "thread"): Stream => ({
      id,
      workspaceId: "ws_1",
      type,
      displayName: null,
      slug: null,
      description: null,
      visibility: "private",
      parentStreamId: hostId,
      parentAnchorId: "msg_anchor",
      rootStreamId: type === "thread" ? hostId : null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "user_1",
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      archivedAt: null,
    })

    await emit("stream:created", { workspaceId: "ws_1", streamId: hostId, stream: anchored("stream_aside_1", "aside") })
    expect((await db.events.get("evt_anchor"))?.payload).not.toHaveProperty("threadId")
    expect(await db.streams.get("stream_aside_1")).toBeUndefined()

    await emit("stream:created", {
      workspaceId: "ws_1",
      streamId: hostId,
      stream: anchored("stream_thread_1", "thread"),
    })
    expect((await db.events.get("evt_anchor"))?.payload).toMatchObject({ threadId: "stream_thread_1" })

    cleanup()
  })
})
