import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { db } from "@/db"
import { QueryClient } from "@tanstack/react-query"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"
import {
  applyReconnectBootstrapBatch,
  applyWorkspaceBootstrap,
  mergeReconnectWorkspaceBootstrap,
  registerWorkspaceSocketHandlers,
} from "./workspace-sync"
import { SocketEventGate } from "./socket-event-gate"
import { resetRowConfirmations, rowConfirmedAt } from "./bootstrap-diff"
import { PerfCapture, armPerfCapture, NO_CAPTURE } from "@/lib/perf/capture"
import { savedKeys } from "@/hooks/use-saved"
import { scheduledKeys } from "@/hooks/use-scheduled"
import { memoKeys } from "@/hooks/use-memos"
import { conversationKeys } from "@/hooks/use-conversations"
import { invitationKeys } from "@/api/invitations"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_QUICK_LINKS,
  SIDEBAR_CONFIG_VERSION,
  type LabelAssignment,
  type SavedMessageView,
  type ScheduledMessageView,
  type Stream,
  type StreamBootstrap,
  type StreamMember,
  type StreamWithPreview,
  type WorkspaceBootstrap,
  type Activity,
} from "@threa/types"
import { assignmentId } from "@/hooks/use-labels"
import { getAgentActivityForStream, getAgentSession, __resetAgentActivityStore } from "@/stores/agent-activity-store"
import * as agentSubstep from "@/lib/crypto/agent-substep"
import { getCachedWorkspaceTables, subscribeWorkspaceCache } from "@/stores/workspace-store"
import type { Socket } from "socket.io-client"

function makeBootstrap(overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
  return {
    workspace: {
      id: "ws_1",
      name: "Test",
      slug: "test",
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    users: [],
    streams: [],
    streamMemberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
    labels: [],
    labelAssignments: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    mutedStreamIds: [],
    featureFlags: { workspace: {}, user: {} },
    sidebarConfig: DEFAULT_SIDEBAR_CONFIG,
    userPreferences: {
      workspaceId: "ws_1",
      userId: "user_1",
      theme: "system",
      messageSendMode: "enter",
      messageDisplay: "default",
      accessibility: {
        fontSize: "medium",
        fontFamily: "default",
        reducedMotion: false,
        highContrast: false,
      },
      keyboardShortcuts: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  } as WorkspaceBootstrap
}

function makeStreamBootstrap(streamId: string, overrides: Partial<StreamBootstrap> = {}): StreamBootstrap {
  return {
    stream: {
      id: streamId,
      workspaceId: "ws_1",
      type: "channel",
      displayName: `Stream ${streamId}`,
      slug: streamId,
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
    events: [],
    members: [],
    botMemberIds: [],
    membership: null,
    latestSequence: "0",
    hasOlderEvents: false,
    syncMode: "replace",
    unreadCount: 0,
    mentionCount: 0,
    activityCount: 0,
    ...overrides,
  }
}

function makeStream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    workspaceId: "ws_1",
    type: "channel",
    displayName: `Stream ${id}`,
    slug: id,
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
    ...overrides,
  }
}

describe("applyWorkspaceBootstrap (real IndexedDB)", () => {
  beforeEach(async () => {
    await Promise.all([
      db.workspaces.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.streamReadState.clear(),
      db.dmPeers.clear(),
      db.personas.clear(),
      db.bots.clear(),
      db.unreadState.clear(),
      db.userPreferences.clear(),
      db.sidebarConfigs.clear(),
      db.workspaceMetadata.clear(),
    ])
  })

  it("removes stale streams not in bootstrap", async () => {
    const fetchStartedAt = Date.now() - 1000 // fetch started 1s ago

    // Pre-existing stale stream from a previous environment (before fetch started)
    await db.streams.put({
      id: "stream_stale",
      workspaceId: "ws_1",
      type: "channel",
      displayName: "Gone",
      slug: null,
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
      _cachedAt: fetchStartedAt - 86400000, // well before fetch started
    })

    const bootstrap = makeBootstrap({
      streams: [
        {
          id: "stream_current",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Current",
          slug: null,
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
          lastMessagePreview: null,
        },
      ] as WorkspaceBootstrap["streams"],
    })

    await applyWorkspaceBootstrap("ws_1", bootstrap, fetchStartedAt)

    // Stale stream should be gone
    expect(await db.streams.get("stream_stale")).toBeUndefined()
    // Current stream should exist
    expect(await db.streams.get("stream_current")).toBeDefined()
  })

  it("preserves streams written by socket handlers DURING the fetch (race condition)", async () => {
    const fetchStartedAt = Date.now() - 500 // fetch started 500ms ago

    // Stream created via socket AFTER fetch started (during the fetch window)
    await db.streams.put({
      id: "stream_socket",
      workspaceId: "ws_1",
      type: "channel",
      displayName: "New via socket",
      slug: null,
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
      _cachedAt: fetchStartedAt + 100, // written 100ms after fetch started
    })

    // Bootstrap doesn't include this stream (snapshot taken before it existed)
    await applyWorkspaceBootstrap("ws_1", makeBootstrap(), fetchStartedAt)

    // Socket-handler stream MUST survive — _cachedAt > fetchStartedAt
    expect(await db.streams.get("stream_socket")).toBeDefined()
  })

  it("persists the bootstrap streamReadState map to IDB — every member stream, present nulls included", async () => {
    await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_a: { lastReadEventId: null, lastReadSequence: null, lastReadAt: "2026-02-01T00:00:00.000Z" },
          stream_b: { lastReadEventId: "evt_9", lastReadSequence: "42", lastReadAt: "2026-02-02T00:00:00.000Z" },
        },
      })
    )

    // A null watermark is an authoritative explicit frontier — the row exists.
    expect(await db.streamReadState.get("ws_1:stream_a")).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_a",
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: "2026-02-01T00:00:00.000Z",
    })
    expect(await db.streamReadState.get("ws_1:stream_b")).toMatchObject({
      lastReadEventId: "evt_9",
      lastReadSequence: "42",
    })
  })

  it("writes no read-state rows for a pre-cutover bootstrap lacking the map (membership fallback)", async () => {
    await applyWorkspaceBootstrap("ws_1", makeBootstrap())
    expect(await db.streamReadState.count()).toBe(0)
  })

  it("an omitted streamReadState map is NOT authoritative — the stale sweep preserves standalone rows", async () => {
    const fetchStartedAt = Date.now() - 1000

    // Standalone rows written before this fetch — including an explicit-NULL
    // frontier and a high-sequence one.
    await db.streamReadState.bulkPut([
      {
        id: "ws_1:stream_null",
        workspaceId: "ws_1",
        streamId: "stream_null",
        lastReadEventId: null,
        lastReadSequence: "0",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
      {
        id: "ws_1:stream_high",
        workspaceId: "ws_1",
        streamId: "stream_high",
        lastReadEventId: "evt_99",
        lastReadSequence: "99",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
    ])

    // Old server / cached payload: the map is omitted, not empty.
    await applyWorkspaceBootstrap("ws_1", makeBootstrap(), fetchStartedAt)

    expect(await db.streamReadState.get("ws_1:stream_null")).toMatchObject({
      lastReadEventId: null,
      lastReadSequence: "0",
    })
    expect(await db.streamReadState.get("ws_1:stream_high")).toMatchObject({
      lastReadEventId: "evt_99",
      lastReadSequence: "99",
    })
  })

  it("a present empty streamReadState map still preserves omitted rows — the member-only map is never a deletion authority", async () => {
    const fetchStartedAt = Date.now() - 1000

    // The map enumerates member streams only; these rows are for streams the
    // map never enumerates (nonmember thread lazy state). Even an explicit
    // `{}` ("no member frontiers") says nothing about them.
    await db.streamReadState.bulkPut([
      {
        id: "ws_1:stream_null",
        workspaceId: "ws_1",
        streamId: "stream_null",
        lastReadEventId: null,
        lastReadSequence: "0",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
      {
        id: "ws_1:stream_high",
        workspaceId: "ws_1",
        streamId: "stream_high",
        lastReadEventId: "evt_99",
        lastReadSequence: "99",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
    ])

    await applyWorkspaceBootstrap("ws_1", makeBootstrap({ streamReadState: {} }), fetchStartedAt)

    expect(await db.streamReadState.count()).toBe(2)
    expect(await db.streamReadState.get("ws_1:stream_null")).toMatchObject({
      lastReadEventId: null,
      lastReadSequence: "0",
    })
    expect(await db.streamReadState.get("ws_1:stream_high")).toMatchObject({
      lastReadEventId: "evt_99",
      lastReadSequence: "99",
    })
  })

  it("a present map upserts its member rows while preserving omitted nonmember lazy rows", async () => {
    const fetchStartedAt = Date.now() - 1000

    await db.streamReadState.bulkPut([
      {
        id: "ws_1:stream_member",
        workspaceId: "ws_1",
        streamId: "stream_member",
        lastReadEventId: "evt_old",
        lastReadSequence: "5",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
      {
        // A nonmember thread's lazy frontier — the member-only bootstrap map
        // never enumerates it, so the apply must not touch it.
        id: "ws_1:stream_thread",
        workspaceId: "ws_1",
        streamId: "stream_thread",
        lastReadEventId: "evt_thread",
        lastReadSequence: "12",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
    ])

    await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_member: { lastReadEventId: "evt_new", lastReadSequence: "9", lastReadAt: null },
        },
      }),
      fetchStartedAt
    )

    expect(await db.streamReadState.get("ws_1:stream_member")).toMatchObject({
      lastReadEventId: "evt_new",
      lastReadSequence: "9",
    })
    expect(await db.streamReadState.get("ws_1:stream_thread")).toMatchObject({
      lastReadEventId: "evt_thread",
      lastReadSequence: "12",
    })
  })

  it("an in-flight bootstrap never restores a stale frontier over a live read (snapshot E50, local E100)", async () => {
    const fetchStartedAt = Date.now() - 500

    // A live read landed during the fetch window — the snapshot predates it.
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_100",
      lastReadSequence: "100",
      lastReadAt: null,
      _cachedAt: fetchStartedAt + 100,
    })

    const { bootstrap: returned } = await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_1: { lastReadEventId: "evt_50", lastReadSequence: "50", lastReadAt: null },
        },
      }),
      fetchStartedAt
    )

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_100",
      lastReadSequence: "100",
    })
    // The query cache the caller writes from the return value can't regress either.
    expect(returned.streamReadState?.stream_1?.lastReadEventId).toBe("evt_100")
    expect(returned.streamReadState?.stream_1?.lastReadSequence).toBe("100")
  })

  it("an in-flight bootstrap never restores a frontier over a live explicit unread (snapshot E100, local NULL)", async () => {
    const fetchStartedAt = Date.now() - 500

    // Explicit mark-unread during the fetch window parked the frontier before
    // the first message — a sanctioned regress no max(sequence) rule protects.
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: null,
      lastReadSequence: null,
      lastReadAt: null,
      _cachedAt: fetchStartedAt + 100,
    })

    const { bootstrap: returned } = await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_1: { lastReadEventId: "evt_100", lastReadSequence: "100", lastReadAt: null },
        },
      }),
      fetchStartedAt
    )

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: null,
      lastReadSequence: null,
    })
    expect(returned.streamReadState?.stream_1?.lastReadEventId).toBeNull()
  })

  it("an untouched stream applies the server snapshot over an older local row", async () => {
    const fetchStartedAt = Date.now() - 500

    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_5",
      lastReadSequence: "5",
      lastReadAt: null,
      _cachedAt: fetchStartedAt - 1000,
    })

    const { bootstrap: returned } = await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_1: { lastReadEventId: "evt_50", lastReadSequence: "50", lastReadAt: null },
        },
      }),
      fetchStartedAt
    )

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
    })
    expect(returned.streamReadState?.stream_1?.lastReadEventId).toBe("evt_50")
  })

  it("persists the bootstrap sidebar config to IDB", async () => {
    await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        sidebarConfig: {
          version: SIDEBAR_CONFIG_VERSION,
          basePreset: "all",
          sections: [{ id: "channels", spec: { kind: "type", streamType: "channel" } }],
          quickLinks: DEFAULT_QUICK_LINKS,
        },
      }),
      Date.now()
    )

    const stored = await db.sidebarConfigs.get("ws_1")
    expect(stored?.config).toEqual({
      version: SIDEBAR_CONFIG_VERSION,
      basePreset: "all",
      sections: [{ id: "channels", spec: { kind: "type", streamType: "channel" } }],
      quickLinks: DEFAULT_QUICK_LINKS,
    })
  })

  it("removes stale users not in bootstrap", async () => {
    const fetchStartedAt = Date.now() - 1000

    await db.workspaceUsers.put({
      id: "user_gone",
      workspaceId: "ws_1",
      workosUserId: "workos_gone",
      email: "gone@test.com",
      role: "member",
      slug: "gone",
      name: "Gone User",
      description: null,
      avatarUrl: null,
      timezone: null,
      locale: null,
      pronouns: null,
      phone: null,
      githubUsername: null,
      statusEmoji: null,
      statusText: null,
      statusExpiresAt: null,
      statusPausesNotifications: false,
      notificationsPausedUntil: null,
      notificationsPausedIndefinitely: false,
      setupCompleted: true,
      joinedAt: new Date().toISOString(),
      _cachedAt: fetchStartedAt - 86400000,
    })

    await applyWorkspaceBootstrap("ws_1", makeBootstrap(), fetchStartedAt)

    expect(await db.workspaceUsers.get("user_gone")).toBeUndefined()
  })

  it("skips cleanup when fetchStartedAt is not provided", async () => {
    // Pre-existing stream
    await db.streams.put({
      id: "stream_keep",
      workspaceId: "ws_1",
      type: "channel",
      displayName: "Keep",
      slug: null,
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
      _cachedAt: Date.now() - 86400000,
    })

    // No fetchStartedAt → no cleanup (e.g., cache-seed path)
    await applyWorkspaceBootstrap("ws_1", makeBootstrap())

    expect(await db.streams.get("stream_keep")).toBeDefined()
  })

  it("persists archived roots from bootstrap.archivedStreams and the sweep keeps them", async () => {
    const fetchStartedAt = Date.now()
    const archivedRoot = makeStream("stream_arch_root", { archivedAt: "2026-01-01T00:00:00Z" })

    // A root live-archived in a prior session, now stale in IDB and absent from
    // the active `streams` snapshot — old behaviour swept it on reload.
    await db.streams.put({ ...archivedRoot, _cachedAt: fetchStartedAt - 86400000 })

    await applyWorkspaceBootstrap("ws_1", makeBootstrap({ archivedStreams: [archivedRoot] }), fetchStartedAt)

    const row = await db.streams.get("stream_arch_root")
    expect(row).toBeDefined()
    expect(row?.archivedAt).toBe("2026-01-01T00:00:00Z")
  })

  it("seeds archived roots into the synchronous in-memory cache (no first-paint flash)", async () => {
    const fetchStartedAt = Date.now()
    const archivedRoot = makeStream("stream_arch_seed", { archivedAt: "2026-01-01T00:00:00Z" })

    await applyWorkspaceBootstrap("ws_1", makeBootstrap({ archivedStreams: [archivedRoot] }), fetchStartedAt)

    // The seed is what the first render reads before the async IDB query
    // resolves; if archived roots are missing here, isStreamArchived is blind
    // for one frame and archived-root drafts flash visible.
    const { renderHook } = await import("@testing-library/react")
    const { useWorkspaceStreamsRaw } = await import("@/stores/workspace-store")
    const { result } = renderHook(() => useWorkspaceStreamsRaw("ws_1"))
    expect(result.current.map((s) => s.id)).toContain("stream_arch_seed")
  })

  it("preserves an existing row's lastMessagePreview when re-persisting an archived root", async () => {
    const fetchStartedAt = Date.now()
    const archivedRoot = makeStream("stream_arch_root", { archivedAt: "2026-01-01T00:00:00Z" })

    await db.streams.put({
      ...archivedRoot,
      lastMessagePreview: {
        authorId: "user_1",
        authorType: "user",
        content: "kept",
        createdAt: "2026-01-01T00:00:00Z",
      },
      _cachedAt: fetchStartedAt - 1000,
    })

    // Bootstrap ships the slim archived root (no preview); the merge must not
    // clobber the preview the live-archived row already carried.
    await applyWorkspaceBootstrap("ws_1", makeBootstrap({ archivedStreams: [archivedRoot] }), fetchStartedAt)

    const row = await db.streams.get("stream_arch_root")
    expect(row?.lastMessagePreview?.content).toBe("kept")
  })

  it("persists the bootstrap feature-flag layers to workspaceMetadata", async () => {
    await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({ featureFlags: { workspace: { calls: "off" }, user: { newComposer: "on" } } }),
      Date.now()
    )

    const stored = await db.workspaceMetadata.get("ws_1")
    expect(stored?.featureFlags).toEqual({ workspace: { calls: "off" }, user: { newComposer: "on" } })
  })

  it("writes undefined featureFlags when the bootstrap omits them (old server)", async () => {
    const bootstrap = makeBootstrap()
    delete bootstrap.featureFlags

    await applyWorkspaceBootstrap("ws_1", bootstrap, Date.now())

    const stored = await db.workspaceMetadata.get("ws_1")
    expect(stored?.featureFlags).toBeUndefined()
  })

  it("applies stream bootstraps inside the reconnect batch transaction", async () => {
    const streamId = "stream_reconnect_batch"

    await applyReconnectBootstrapBatch(
      "ws_1",
      makeBootstrap({ streams: [{ ...makeStreamBootstrap(streamId).stream, lastMessagePreview: null }] }),
      new Map([[streamId, makeStreamBootstrap(streamId)]]),
      new Set(),
      new Set(),
      Date.now()
    )

    expect((await db.streams.get(streamId))?.id).toBe(streamId)
  })

  it("applies stream terminal events after seeding the reconnect running set", async () => {
    const streamId = "stream_reconnect_agent"
    const completedAt = "2026-08-27T11:25:37.971Z"
    const streamBootstrap = makeStreamBootstrap(streamId, {
      events: [
        {
          id: "evt_agent_completed",
          streamId,
          sequence: "2",
          eventType: "agent_session:completed",
          payload: {
            sessionId: "session_settled",
            stepCount: 2,
            messageCount: 1,
            duration: 10_000,
            completedAt,
          },
          actorId: "persona_ariadne",
          actorType: "persona",
          createdAt: completedAt,
        },
      ],
      latestSequence: "2",
    })

    await applyReconnectBootstrapBatch(
      "ws_1",
      makeBootstrap({
        streams: [{ ...streamBootstrap.stream, lastMessagePreview: null }],
        activeAgentSessions: [
          {
            sessionId: "session_settled",
            streamId,
            rootStreamId: streamId,
            personaName: "Ariadne",
            startedAt: "2026-08-27T11:24:59.119Z",
          },
        ],
      }),
      new Map([[streamId, streamBootstrap]]),
      new Set([streamId]),
      new Set(),
      Date.now()
    )

    expect(getAgentActivityForStream("ws_1", streamId)).toEqual([])
  })

  it("persists feature-flag layers on the reconnect apply path too", async () => {
    await applyReconnectBootstrapBatch(
      "ws_1",
      makeBootstrap({ featureFlags: { workspace: { calls: "off" }, user: {} } }),
      new Map(),
      new Set(),
      new Set(),
      Date.now()
    )

    const stored = await db.workspaceMetadata.get("ws_1")
    expect(stored?.featureFlags).toEqual({ workspace: { calls: "off" }, user: {} })
  })

  it("preserves standalone read-state rows on reconnect when the map is omitted (old server)", async () => {
    const fetchStartedAt = Date.now() - 1000

    await db.streamReadState.bulkPut([
      {
        id: "ws_1:stream_null",
        workspaceId: "ws_1",
        streamId: "stream_null",
        lastReadEventId: null,
        lastReadSequence: "0",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
      {
        id: "ws_1:stream_high",
        workspaceId: "ws_1",
        streamId: "stream_high",
        lastReadEventId: "evt_99",
        lastReadSequence: "99",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
    ])

    // makeBootstrap() omits streamReadState — not authoritative on reconnect
    // either: the omission propagates through the merge and nothing is swept.
    await applyReconnectBootstrapBatch("ws_1", makeBootstrap(), new Map(), new Set(), new Set(), fetchStartedAt)

    expect(await db.streamReadState.get("ws_1:stream_null")).toMatchObject({
      lastReadEventId: null,
      lastReadSequence: "0",
    })
    expect(await db.streamReadState.get("ws_1:stream_high")).toMatchObject({
      lastReadEventId: "evt_99",
      lastReadSequence: "99",
    })
  })

  it("preserves omitted nonmember rows through a reconnect apply with a present map", async () => {
    const fetchStartedAt = Date.now() - 1000

    await db.streamReadState.bulkPut([
      {
        // A nonmember thread's lazy frontier — the member-only map never
        // enumerates it, so the reconnect apply must not touch it.
        id: "ws_1:stream_thread",
        workspaceId: "ws_1",
        streamId: "stream_thread",
        lastReadEventId: "evt_thread",
        lastReadSequence: "12",
        lastReadAt: null,
        _cachedAt: fetchStartedAt - 500,
      },
    ])

    await applyReconnectBootstrapBatch(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_member: { lastReadEventId: "evt_m", lastReadSequence: "3", lastReadAt: null },
        },
      }),
      new Map(),
      new Set(),
      new Set(),
      fetchStartedAt
    )

    expect(await db.streamReadState.get("ws_1:stream_thread")).toMatchObject({
      lastReadEventId: "evt_thread",
      lastReadSequence: "12",
    })
    expect(await db.streamReadState.get("ws_1:stream_member")).toMatchObject({
      lastReadEventId: "evt_m",
      lastReadSequence: "3",
    })
  })

  it("preserves a frontier written DURING the reconnect fetch window (newer _cachedAt)", async () => {
    const fetchStartedAt = Date.now() - 1000

    await db.streamReadState.bulkPut([
      {
        // Written after the fetch started (e.g. a stream:read arrived mid-fetch)
        // for a stream NOT in successfulStreamBootstraps — must survive.
        id: "ws_1:stream_live",
        workspaceId: "ws_1",
        streamId: "stream_live",
        lastReadEventId: "evt_live",
        lastReadSequence: "99",
        lastReadAt: null,
        _cachedAt: fetchStartedAt + 100,
      },
    ])

    await applyReconnectBootstrapBatch(
      "ws_1",
      makeBootstrap({
        streamReadState: {
          stream_other: { lastReadEventId: "evt_o", lastReadSequence: "1", lastReadAt: null },
        },
      }),
      new Map(),
      new Set(), // stream_live NOT in successfulStreamBootstraps
      new Set(),
      fetchStartedAt
    )

    // The locally-written frontier survives untouched.
    expect(await db.streamReadState.get("ws_1:stream_live")).toMatchObject({
      lastReadEventId: "evt_live",
      lastReadSequence: "99",
    })
  })

  describe("the bootstrap row diff", () => {
    interface DiffTable {
      name: string
      toArray: () => Promise<Array<{ id: string; _cachedAt: number }>>
      bulkPut: (rows: Array<{ id: string; _cachedAt: number }>) => Promise<unknown>
    }

    function diffTables(): DiffTable[] {
      return [
        db.workspaces,
        db.workspaceUsers,
        db.streams,
        db.streamMemberships,
        db.streamReadState,
        db.dmPeers,
        db.personas,
        db.bots,
        db.labels,
        db.labelAssignments,
        db.unreadState,
        db.userPreferences,
        db.sidebarConfigs,
        db.workspaceMetadata,
      ] as unknown as DiffTable[]
    }

    async function stampCachedAt(value: number): Promise<void> {
      for (const table of diffTables()) {
        const rows = await table.toArray()
        if (rows.length > 0) await table.bulkPut(rows.map((row) => ({ ...row, _cachedAt: value })))
      }
    }

    async function cachedAtSnapshot(): Promise<Record<string, number>> {
      const snapshot: Record<string, number> = {}
      for (const table of diffTables()) {
        for (const row of await table.toArray()) snapshot[`${table.name}:${row.id}`] = row._cachedAt
      }
      return snapshot
    }

    let diffBase: WorkspaceBootstrap | undefined

    function diffBootstrap(overrides: Partial<WorkspaceBootstrap> = {}): WorkspaceBootstrap {
      diffBase ??= makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [
          { ...makeStream("stream_d1"), lastMessagePreview: null },
          { ...makeStream("stream_d2"), lastMessagePreview: null },
        ] as WorkspaceBootstrap["streams"],
        streamMemberships: [
          { streamId: "stream_d1", memberId: "member_1", notificationLevel: null, joinedAt: "2026-01-01T00:00:00Z" },
        ],
        streamReadState: {
          stream_d1: { lastReadEventId: "evt_1", lastReadSequence: "3", lastReadAt: "2026-01-01T00:00:00Z" },
        },
        dmPeers: [{ userId: "member_1", streamId: "stream_d2" }],
        personas: [
          {
            id: "persona_d1",
            workspaceId: "ws_1",
            slug: "ariadne",
            name: "Ariadne",
            description: null,
            avatarEmoji: null,
            avatarUrl: null,
            systemPrompt: null,
            model: "openrouter:anthropic/claude-sonnet-5",
            temperature: null,
            maxTokens: null,
            enabledTools: null,
            managedBy: "workspace",
            ownerUserId: null,
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        bots: [
          {
            id: "bot_d1",
            workspaceId: "ws_1",
            type: "shared",
            ownerUserId: null,
            traits: [],
            slug: "helper",
            name: "Helper",
            description: null,
            avatarEmoji: null,
            avatarUrl: null,
            archivedAt: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        labels: [
          {
            id: "label_d1",
            workspaceId: "ws_1",
            creatorActorType: "user",
            creatorUserId: "member_1",
            name: "Focus",
            slug: "focus",
            color: "blue",
            emoji: null,
            description: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            archivedAt: null,
          },
        ],
        labelAssignments: [
          {
            labelId: "label_d1",
            resourceType: "stream",
            resourceId: "stream_d1",
            actorType: "user",
            userId: "member_1",
            workspaceId: "ws_1",
            assignedAt: "2026-01-01T00:00:00Z",
          },
        ],
        unreadCounts: { stream_d1: 2 },
        mentionCounts: { stream_d1: 1 },
        activityCounts: { stream_d1: 2 },
        unreadActivityCount: 2,
      })
      return { ...structuredClone(diffBase), ...overrides }
    }

    beforeEach(async () => {
      resetRowConfirmations()
      await Promise.all([db.labels.clear(), db.labelAssignments.clear()])
    })

    afterEach(() => {
      armPerfCapture(NO_CAPTURE)
    })

    it("a second identical bootstrap writes no rows", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)
      const before = await cachedAtSnapshot()

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      expect(await cachedAtSnapshot()).toEqual(before)
      expect(Object.values(before).every((value) => value === 1)).toBe(true)
      expect(await db.streams.get("stream_d1")).toBeDefined()
      expect(await db.streams.get("stream_d2")).toBeDefined()
    })

    it("a second identical bootstrap reports rowsWritten 0", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      const rowCount = Object.keys(await cachedAtSnapshot()).length

      const capture = new PerfCapture()
      armPerfCapture(capture)
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      const samples = capture.snapshot()
      expect(samples.filter((s) => s.name === "bootstrap.rowsWritten").map((s) => s.value)).toEqual([0])
      expect(samples.filter((s) => s.name === "bootstrap.rowsSkipped").map((s) => s.value)).toEqual([rowCount])
    })

    it("the stale sweep drops a deleted row's confirmation", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())
      expect(rowConfirmedAt("ws_1", "streams", "stream_d2")).toBeDefined()

      await applyWorkspaceBootstrap(
        "ws_1",
        diffBootstrap({
          streams: [{ ...makeStream("stream_d1"), lastMessagePreview: null }] as WorkspaceBootstrap["streams"],
        }),
        Date.now()
      )

      expect(await db.streams.get("stream_d2")).toBeUndefined()
      expect(rowConfirmedAt("ws_1", "streams", "stream_d2")).toBeUndefined()
    })

    it("a changed row is written and its neighbours are not", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      const base = diffBootstrap()
      const changed = diffBootstrap({
        streams: base.streams.map((s) => (s.id === "stream_d1" ? { ...s, displayName: "Renamed" } : s)),
      })
      await applyWorkspaceBootstrap("ws_1", changed, Date.now())

      expect((await db.streams.get("stream_d1"))?.displayName).toBe("Renamed")
      expect((await db.streams.get("stream_d1"))?._cachedAt).toBeGreaterThan(1)
      expect((await db.streams.get("stream_d2"))?._cachedAt).toBe(1)
      expect((await db.workspaceUsers.get("member_1"))?._cachedAt).toBe(1)
    })

    it("a row present in the bootstrap but skipped by the diff is never swept", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      const fetchStartedAt = Date.now()
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), fetchStartedAt)

      expect(await db.streams.get("stream_d1")).toBeDefined()
      expect(await db.streams.get("stream_d2")).toBeDefined()
      expect(await db.workspaceUsers.get("member_1")).toBeDefined()
      expect(await db.streamMemberships.get("ws_1:stream_d1")).toBeDefined()
      expect((await db.streams.get("stream_d1"))?._cachedAt).toBe(1)
    })

    it("a stream written by a socket handler during the fetch window and absent from the snapshot still survives", async () => {
      const fetchStartedAt = Date.now() - 500
      await db.streams.put({ ...makeStream("stream_socket_diff"), _cachedAt: fetchStartedAt + 100 })

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), fetchStartedAt)

      expect(await db.streams.get("stream_socket_diff")).toBeDefined()
    })

    it("a socket write during the fetch window that the snapshot contradicts is still healed by the snapshot", async () => {
      const fetchStartedAt = Date.now() - 500
      await db.streams.put({
        ...makeStream("stream_d1"),
        displayName: "Local socket name",
        _cachedAt: fetchStartedAt + 100,
      })

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), fetchStartedAt)

      expect((await db.streams.get("stream_d1"))?.displayName).toBe("Stream stream_d1")
    })

    it("userPreferences does not false-diff on the seed-only sendMode field", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      expect((await db.userPreferences.get("ws_1"))?._cachedAt).toBe(1)
      expect((await db.userPreferences.get("ws_1")) as unknown as { sendMode?: string }).not.toHaveProperty("sendMode")
    })

    it("userPreferences does not false-diff on the server's per-request createdAt/updatedAt", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      const restamped = diffBootstrap()
      const later = new Date(Date.now() + 60_000).toISOString()
      restamped.userPreferences = { ...restamped.userPreferences, createdAt: later, updatedAt: later }
      await applyWorkspaceBootstrap("ws_1", restamped, Date.now())

      expect((await db.userPreferences.get("ws_1"))?._cachedAt).toBe(1)
    })

    it("reconnect apply's userPreferences does not false-diff on the server's per-request createdAt/updatedAt", async () => {
      await applyReconnectBootstrapBatch("ws_1", diffBootstrap(), new Map(), new Set(), new Set(), Date.now() - 5000)
      await stampCachedAt(1)

      const restamped = diffBootstrap()
      const later = new Date(Date.now() + 60_000).toISOString()
      restamped.userPreferences = { ...restamped.userPreferences, createdAt: later, updatedAt: later }
      await applyReconnectBootstrapBatch("ws_1", restamped, new Map(), new Set(), new Set(), Date.now())

      expect((await db.userPreferences.get("ws_1"))?._cachedAt).toBe(1)
    })

    it("archived roots ride the single diffed streams write", async () => {
      const archivedRoot = makeStream("stream_arch_diff", { archivedAt: "2026-01-01T00:00:00Z" })
      await db.streams.put({
        ...archivedRoot,
        lastMessagePreview: {
          authorId: "user_1",
          authorType: "user",
          content: "kept",
          createdAt: "2026-01-01T00:00:00Z",
        },
        _cachedAt: Date.now() - 90000,
      })

      await applyWorkspaceBootstrap("ws_1", diffBootstrap({ archivedStreams: [archivedRoot] }), Date.now() - 5000)
      await stampCachedAt(1)

      await applyWorkspaceBootstrap("ws_1", diffBootstrap({ archivedStreams: [archivedRoot] }), Date.now())

      const row = await db.streams.get("stream_arch_diff")
      expect(row?._cachedAt).toBe(1)
      expect(row?.lastMessagePreview?.content).toBe("kept")
    })

    it("unreadState is not rewritten when counters and touch maps are unchanged", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      expect((await db.unreadState.get("ws_1"))?._cachedAt).toBe(1)
    })

    it("reconnect apply writes no rows for an unchanged workspace snapshot", async () => {
      await applyReconnectBootstrapBatch("ws_1", diffBootstrap(), new Map(), new Set(), new Set(), Date.now() - 5000)
      await stampCachedAt(1)
      const before = await cachedAtSnapshot()

      await applyReconnectBootstrapBatch("ws_1", diffBootstrap(), new Map(), new Set(), new Set(), Date.now())

      expect(await cachedAtSnapshot()).toEqual(before)
    })

    async function warmThenOlderReconnect(reconnectOverrides: Partial<WorkspaceBootstrap>): Promise<void> {
      const warm = (): WorkspaceBootstrap =>
        diffBootstrap({
          streamReadState: {
            stream_d1: { lastReadEventId: "evt_9", lastReadSequence: "9", lastReadAt: "2026-01-02T00:00:00Z" },
          },
        })

      await applyWorkspaceBootstrap("ws_1", warm(), Date.now() - 5000)
      await stampCachedAt(1)
      const warmAppliedAt = Date.now()
      await applyWorkspaceBootstrap("ws_1", warm(), warmAppliedAt)

      await applyReconnectBootstrapBatch(
        "ws_1",
        diffBootstrap({ ...reconnectOverrides }),
        new Map(),
        new Set(),
        new Set(),
        warmAppliedAt - 1000
      )
    }

    it("a warm apply carrying an older frontier cannot regress a row the diff just confirmed", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      const fetchStartedAt = Date.now() - 1000
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      const stale = diffBootstrap({
        streamReadState: {
          stream_d1: { lastReadEventId: "evt_old", lastReadSequence: "2", lastReadAt: "2025-01-01T00:00:00Z" },
        },
      })
      await applyWorkspaceBootstrap("ws_1", stale, fetchStartedAt)

      expect((await db.streamReadState.get("ws_1:stream_d1"))?.lastReadSequence).toBe("3")
    })

    it("a reconnect carrying an older frontier cannot regress a row the diff just confirmed", async () => {
      await warmThenOlderReconnect({
        streamReadState: {
          stream_d1: { lastReadEventId: "evt_2", lastReadSequence: "2", lastReadAt: "2026-01-01T00:00:00Z" },
        },
      })

      expect((await db.streamReadState.get("ws_1:stream_d1"))?.lastReadSequence).toBe("9")
    })

    it("a reconnect carrying an older displayName cannot clobber a stream row the diff just confirmed", async () => {
      const base = diffBootstrap()
      await warmThenOlderReconnect({
        streams: base.streams.map((s) => (s.id === "stream_d1" ? { ...s, displayName: "Older Name" } : s)),
      })

      expect((await db.streams.get("stream_d1"))?.displayName).toBe("Stream stream_d1")
    })

    it("a reconnect carrying an older notificationLevel cannot clobber a membership row the diff just confirmed", async () => {
      await warmThenOlderReconnect({
        streamMemberships: [
          {
            streamId: "stream_d1",
            memberId: "member_1",
            notificationLevel: "mentions",
            joinedAt: "2026-01-01T00:00:00Z",
          },
        ],
      })

      expect((await db.streamMemberships.get("ws_1:stream_d1"))?.notificationLevel).toBeNull()
    })

    it("an identical re-apply emits no store publication", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)

      let notifications = 0
      const unsubscribe = subscribeWorkspaceCache("ws_1", () => {
        notifications += 1
      })
      const capture = new PerfCapture()
      armPerfCapture(capture)
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())
      unsubscribe()

      expect(notifications).toBe(0)
      expect(capture.snapshot().filter((s) => s.name === "bootstrap.storePublish")).toEqual([])
    })

    it("a changed row still publishes exactly once", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)

      const base = diffBootstrap()
      const changed = diffBootstrap({
        streams: base.streams.map((s) => (s.id === "stream_d1" ? { ...s, displayName: "Renamed" } : s)),
      })
      let notifications = 0
      const unsubscribe = subscribeWorkspaceCache("ws_1", () => {
        notifications += 1
      })
      await applyWorkspaceBootstrap("ws_1", changed, Date.now())
      unsubscribe()

      expect(notifications).toBe(1)
    })

    it("a bootstrap that drops a row publishes and replaces the cached bootstrap object", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      await stampCachedAt(1)

      const base = diffBootstrap()
      const dropped = diffBootstrap({
        streams: base.streams.filter((s) => s.id !== "stream_d2") as WorkspaceBootstrap["streams"],
      })
      let notifications = 0
      const unsubscribe = subscribeWorkspaceCache("ws_1", () => {
        notifications += 1
      })
      const applied = await applyWorkspaceBootstrap("ws_1", dropped, Date.now())
      unsubscribe()

      expect(notifications).toBe(1)
      expect(await db.streams.get("stream_d2")).toBeUndefined()
      // The value sync-engine's setQueryData gate consults: false here would
      // leave the swept stream in the cached bootstrap forever.
      expect(applied.anyChanged).toBe(true)
      expect(getCachedWorkspaceTables("ws_1").streams?.map((s) => s.id)).toEqual(["stream_d1"])
    })

    it("two unchanged applies keep the cached streams array reference", async () => {
      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now() - 5000)
      const first = getCachedWorkspaceTables("ws_1").streams

      await applyWorkspaceBootstrap("ws_1", diffBootstrap(), Date.now())

      expect(getCachedWorkspaceTables("ws_1").streams).toBe(first)
    })
  })
})

describe("mergeReconnectWorkspaceBootstrap", () => {
  it("overlays authoritative visible stream counts and membership onto the workspace snapshot", () => {
    const workspaceBootstrap = makeBootstrap({
      streams: [
        {
          id: "stream_visible",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Visible",
          slug: "visible",
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
          lastMessagePreview: null,
        },
      ],
      streamMemberships: [
        {
          streamId: "stream_visible",
          memberId: "user_1",
          notificationLevel: null,
          joinedAt: new Date().toISOString(),
        },
      ],
      streamReadState: {
        stream_visible: { lastReadEventId: "evt_old", lastReadSequence: "1", lastReadAt: null },
      },
      unreadCounts: { stream_visible: 5 },
      mentionCounts: { stream_visible: 2 },
      activityCounts: { stream_visible: 5 },
      unreadActivityCount: 5,
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map([
        [
          "stream_visible",
          makeStreamBootstrap("stream_visible", {
            membership: {
              streamId: "stream_visible",
              memberId: "user_1",
              notificationLevel: "activity",
              joinedAt: new Date().toISOString(),
            },
            readState: { lastReadEventId: "evt_new", lastReadSequence: "2", lastReadAt: null },
            unreadCount: 1,
            mentionCount: 1,
            activityCount: 1,
          }),
        ],
      ]),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
      localReadStates: [],
    })

    expect(merged.unreadCounts.stream_visible).toBe(1)
    expect(merged.streamReadState?.stream_visible?.lastReadEventId).toBe("evt_new")
  })

  it("never promotes an archived local row into the active streams list, even when locally fresher", () => {
    const fetchStartedAt = Date.now() - 1000
    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap: makeBootstrap({ streams: [] }),
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [
        { ...makeStream("stream_archived_fresh", { archivedAt: new Date().toISOString() }), _cachedAt: Date.now() },
        { ...makeStream("stream_active_fresh"), _cachedAt: Date.now() },
      ],
      localMemberships: [],
      localReadStates: [],
      fetchStartedAt,
    })

    expect(merged.streams.map((s) => s.id)).toEqual(["stream_active_fresh"])
  })

  it("preserves prior local state for visible streams that fail reconnect bootstrap", () => {
    const workspaceBootstrap = makeBootstrap({
      streams: [],
      streamMemberships: [],
      streamReadState: {},
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      mutedStreamIds: [],
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(["stream_failed"]),
      terminalStreamIds: new Set(),
      localStreams: [
        {
          id: "stream_failed",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Cached failed stream",
          slug: "failed",
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
          lastMessagePreview: null,
          _cachedAt: Date.now(),
        },
      ],
      localMemberships: [
        {
          id: "ws_1:stream_failed",
          workspaceId: "ws_1",
          streamId: "stream_failed",
          memberId: "user_1",
          notificationLevel: null,
          joinedAt: new Date().toISOString(),
          _cachedAt: Date.now(),
        },
      ],
      localReadStates: [
        {
          id: "ws_1:stream_failed",
          workspaceId: "ws_1",
          streamId: "stream_failed",
          lastReadEventId: "evt_cached",
          lastReadSequence: "77",
          lastReadAt: null,
          _cachedAt: Date.now(),
        },
      ],
      localUnreadState: {
        id: "ws_1",
        workspaceId: "ws_1",
        unreadCounts: { stream_failed: 3 },
        mentionCounts: { stream_failed: 1 },
        activityCounts: { stream_failed: 2 },
        unreadActivityCount: 2,
        unreadActivities: [],
        mutedStreamIds: ["stream_failed"],
        _cachedAt: Date.now(),
      },
    })

    expect(merged.streams.map((stream) => stream.id)).toContain("stream_failed")
    // The board-card sequence frontier must survive the cached→bootstrap
    // conversion — dropping it silently degrades card rows to the time fallback.
    expect(merged.streamReadState?.stream_failed).toMatchObject({
      lastReadEventId: "evt_cached",
      lastReadSequence: "77",
    })
    expect(merged.unreadCounts.stream_failed).toBe(3)
    expect(merged.mutedStreamIds).toContain("stream_failed")
  })

  it("removes terminal visible streams from the merged snapshot and sidebar state", () => {
    const workspaceBootstrap = makeBootstrap({
      streams: [
        {
          id: "stream_terminal",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Terminal",
          slug: "terminal",
          description: null,
          visibility: "private",
          parentStreamId: null,
          rootStreamId: null,
          companionMode: "off",
          companionPersonaId: null,
          createdBy: "user_1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archivedAt: null,
          lastMessagePreview: null,
        },
      ],
      streamMemberships: [
        {
          streamId: "stream_terminal",
          memberId: "user_1",
          notificationLevel: "muted",
          joinedAt: new Date().toISOString(),
        },
      ],
      unreadCounts: { stream_terminal: 3 },
      mentionCounts: { stream_terminal: 1 },
      activityCounts: { stream_terminal: 2 },
      unreadActivityCount: 2,
      unreadActivities: [],
      mutedStreamIds: ["stream_terminal"],
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(["stream_terminal"]),
      localStreams: [],
      localMemberships: [],
      localReadStates: [],
    })

    expect(merged.streams.map((stream) => stream.id)).not.toContain("stream_terminal")
    expect(merged.streamMemberships.map((membership) => membership.streamId)).not.toContain("stream_terminal")
    expect(merged.unreadCounts).not.toHaveProperty("stream_terminal")
    expect(merged.mentionCounts).not.toHaveProperty("stream_terminal")
    expect(merged.activityCounts).not.toHaveProperty("stream_terminal")
    expect(merged.unreadActivityCount).toBe(0)
    expect(merged.mutedStreamIds).not.toContain("stream_terminal")
  })

  it("recomputes mutedStreamIds from successful visible stream memberships", () => {
    const workspaceBootstrap = makeBootstrap({
      streams: [
        {
          id: "stream_unmuted",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Unmuted",
          slug: "unmuted",
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
          lastMessagePreview: null,
        },
        {
          id: "stream_muted",
          workspaceId: "ws_1",
          type: "channel",
          displayName: "Muted",
          slug: "muted",
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
          lastMessagePreview: null,
        },
      ],
      streamMemberships: [
        {
          streamId: "stream_unmuted",
          memberId: "user_1",
          notificationLevel: "muted",
          joinedAt: new Date().toISOString(),
        },
        {
          streamId: "stream_muted",
          memberId: "user_1",
          notificationLevel: null,
          joinedAt: new Date().toISOString(),
        },
      ],
      mutedStreamIds: ["stream_unmuted"],
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map([
        [
          "stream_unmuted",
          makeStreamBootstrap("stream_unmuted", {
            membership: {
              streamId: "stream_unmuted",
              memberId: "user_1",
              notificationLevel: null,
              joinedAt: new Date().toISOString(),
            },
          }),
        ],
        [
          "stream_muted",
          makeStreamBootstrap("stream_muted", {
            membership: {
              streamId: "stream_muted",
              memberId: "user_1",
              notificationLevel: "muted",
              joinedAt: new Date().toISOString(),
            },
          }),
        ],
      ]),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
      localReadStates: [],
    })

    expect(merged.mutedStreamIds).not.toContain("stream_unmuted")
    expect(merged.mutedStreamIds).toContain("stream_muted")
  })

  it("keeps a locally-fresh standalone read-state row over the server snapshot and drops terminal streams", () => {
    const fetchStartedAt = Date.now() - 500
    const workspaceBootstrap = makeBootstrap({
      streamReadState: {
        stream_server: { lastReadEventId: "evt_server", lastReadSequence: "10", lastReadAt: null },
        stream_touched: { lastReadEventId: "evt_stale", lastReadSequence: "5", lastReadAt: null },
        stream_terminal: { lastReadEventId: "evt_gone", lastReadSequence: "1", lastReadAt: null },
      },
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(["stream_terminal"]),
      localStreams: [],
      localMemberships: [],
      localReadStates: [
        {
          id: "ws_1:stream_touched",
          workspaceId: "ws_1",
          streamId: "stream_touched",
          lastReadEventId: "evt_local",
          lastReadSequence: "20",
          lastReadAt: null,
          // Written during the fetch window — fresher than the snapshot.
          _cachedAt: fetchStartedAt + 100,
        },
      ],
      fetchStartedAt,
    })

    expect(merged.streamReadState?.stream_server?.lastReadEventId).toBe("evt_server")
    expect(merged.streamReadState?.stream_touched?.lastReadEventId).toBe("evt_local")
    expect(merged.streamReadState?.stream_touched?.lastReadSequence).toBe("20")
    expect(merged.streamReadState?.stream_terminal).toBeUndefined()
  })

  it("falls back to the server snapshot for a local read-state row older than the fetch window", () => {
    const fetchStartedAt = Date.now() - 500
    const workspaceBootstrap = makeBootstrap({
      streamReadState: {
        stream_1: { lastReadEventId: "evt_server", lastReadSequence: "10", lastReadAt: null },
      },
    })

    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap,
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
      localReadStates: [
        {
          id: "ws_1:stream_1",
          workspaceId: "ws_1",
          streamId: "stream_1",
          lastReadEventId: "evt_ancient",
          lastReadSequence: "1",
          lastReadAt: null,
          _cachedAt: fetchStartedAt - 1000,
        },
      ],
      fetchStartedAt,
    })

    expect(merged.streamReadState?.stream_1?.lastReadEventId).toBe("evt_server")
  })

  it("propagates an omitted streamReadState map rather than fabricating an authoritative empty one", () => {
    const fetchStartedAt = Date.now() - 500
    // makeBootstrap() omits streamReadState — old server / cached payload.
    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap: makeBootstrap(),
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(["stream_stale"]),
      terminalStreamIds: new Set(["stream_terminal"]),
      localStreams: [],
      localMemberships: [],
      localReadStates: [
        {
          id: "ws_1:stream_fresh",
          workspaceId: "ws_1",
          streamId: "stream_fresh",
          lastReadEventId: "evt_local",
          lastReadSequence: "20",
          lastReadAt: null,
          // Touched during the fetch window — would override a present map.
          _cachedAt: fetchStartedAt + 100,
        },
      ],
      fetchStartedAt,
    })

    // The omission must survive the merge: a fabricated `{}` would read as
    // "authoritative empty" downstream and sweep every standalone IDB row.
    expect(merged.streamReadState).toBeUndefined()
  })

  it("keeps a present empty streamReadState map authoritative (explicit {} stays present)", () => {
    const fetchStartedAt = Date.now() - 500
    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap: makeBootstrap({ streamReadState: {} }),
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
      localReadStates: [
        {
          id: "ws_1:stream_old",
          workspaceId: "ws_1",
          streamId: "stream_old",
          lastReadEventId: "evt_local",
          lastReadSequence: "5",
          lastReadAt: null,
          // Older than the fetch window — the authoritative empty snapshot wins.
          _cachedAt: fetchStartedAt - 1000,
        },
      ],
      fetchStartedAt,
    })

    // Present (not undefined) and empty: the query cache carries the member
    // authority as-is. IDB rows are never swept on the map's authority —
    // omitted nonmember lazy rows survive the apply.
    expect(merged.streamReadState).toEqual({})
  })
})

function createTestSocket() {
  const handlers = new Map<string, Set<(payload: unknown) => unknown>>()

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
    async emitAsync(event: string, payload: unknown) {
      await Promise.all(Array.from(handlers.get(event) ?? [], (handler) => handler(payload)))
    },
  }
}

function makeWorkspaceUser() {
  return {
    id: "member_1",
    workspaceId: "ws_1",
    workosUserId: "workos_1",
    email: "kris@example.com",
    role: "owner" as const,
    slug: "kris",
    name: "Kris",
    description: null,
    avatarUrl: null,
    timezone: "Europe/Stockholm",
    locale: "en",
    pronouns: null,
    phone: null,
    githubUsername: null,
    statusEmoji: null,
    statusText: null,
    statusExpiresAt: null,
    statusPausesNotifications: false,
    notificationsPausedUntil: null,
    notificationsPausedIndefinitely: false,
    setupCompleted: true,
    joinedAt: new Date().toISOString(),
  }
}

describe("registerWorkspaceSocketHandlers", () => {
  beforeEach(async () => {
    await Promise.all([
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.streamReadState.clear(),
      db.dmPeers.clear(),
      db.unreadState.clear(),
    ])
  })

  const handlerRefs = {
    getCurrentStreamId: () => undefined,
    getCurrentUser: () => ({ id: "workos_1" }),
    subscribeStream: vi.fn(),
  }

  it("revision-orders stream title events and ignores another workspace", async () => {
    const queryClient = new QueryClient()
    const current = makeStream("stream_title", {
      displayName: "revision two",
      displayNameSource: "explicit",
      displayNameRevision: 2,
    })
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ streams: [{ ...current, lastMessagePreview: null }] })
    )
    await db.streams.put({ ...current, _cachedAt: Date.now() })
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    const title = () =>
      queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.streams[0]?.displayName
    emit("stream:display_name_updated", {
      workspaceId: "ws_1",
      streamId: current.id,
      displayName: "lower",
      source: "generated",
      revision: 1,
    })
    expect(title()).toBe("revision two")
    emit("stream:display_name_updated", { workspaceId: "ws_1", streamId: current.id, displayName: "missing" })
    expect(title()).toBe("revision two")
    emit("stream:display_name_updated", {
      workspaceId: "ws_other",
      streamId: current.id,
      displayName: "foreign",
      source: "explicit",
      revision: 3,
    })
    expect(title()).toBe("revision two")
    emit("stream:display_name_updated", {
      workspaceId: "ws_1",
      streamId: current.id,
      displayName: "equal",
      source: "explicit",
      revision: 2,
    })
    expect(title()).toBe("equal")
    emit("stream:display_name_updated", {
      workspaceId: "ws_1",
      streamId: current.id,
      displayName: "newer",
      source: "generated",
      revision: 3,
    })
    expect(title()).toBe("newer")
    await vi.waitFor(async () => expect((await db.streams.get(current.id))?.displayName).toBe("newer"))
    cleanup()
  })

  it("merges a delayed stream:created into cache and IndexedDB without regressing title fields", async () => {
    const queryClient = new QueryClient()
    const current = makeStream("stream_delayed_create", {
      displayName: "new title",
      displayNameSource: "explicit",
      displayNameRevision: 4,
      description: "old description",
    })
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ streams: [{ ...current, lastMessagePreview: null }] })
    )
    await db.streams.put({ ...current, _cachedAt: Date.now() })
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:created", {
      workspaceId: "ws_1",
      streamId: current.id,
      stream: {
        ...current,
        displayName: "old title",
        displayNameSource: "generated",
        displayNameRevision: 2,
        description: "new description",
      },
    })

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.streams[0]
    expect(cached).toMatchObject({ displayName: "new title", displayNameRevision: 4, description: "new description" })
    await vi.waitFor(async () =>
      expect(await db.streams.get(current.id)).toMatchObject({
        displayName: "new title",
        displayNameRevision: 4,
        description: "new description",
      })
    )
    cleanup()
  })

  it("keeps a newer socket title when an older workspace bootstrap finishes later", async () => {
    const newer = makeStream("stream_delayed_bootstrap", {
      displayName: "socket title",
      displayNameSource: "explicit",
      displayNameRevision: 3,
      description: "before fetch",
    })
    await db.streams.put({ ...newer, workspaceId: "ws_1", _cachedAt: Date.now() })
    const stale = makeBootstrap({
      streams: [
        {
          ...newer,
          displayName: "stale bootstrap title",
          displayNameSource: "generated",
          displayNameRevision: 1,
          description: "from delayed fetch",
          lastMessagePreview: null,
        },
      ],
    })

    const { bootstrap } = await applyWorkspaceBootstrap("ws_1", stale, Date.now() - 1_000)

    expect(bootstrap.streams[0]).toMatchObject({
      displayName: "socket title",
      displayNameRevision: 3,
      description: "from delayed fetch",
    })
    expect(await db.streams.get(newer.id)).toMatchObject({
      displayName: "socket title",
      displayNameRevision: 3,
      description: "from delayed fetch",
    })
  })

  it("does not run the INV-53 saved/scheduled reconnect invalidations on registration", () => {
    // The workspace catch-up cursor replays the missed user-scoped saved/
    // scheduled entries through these same handlers, so registration never
    // blanket-invalidates those caches.
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket } = createTestSocket()

    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: savedKeys.all })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: scheduledKeys.all })
    cleanup()
  })

  it("applies a stream:read_messages snapshot to the overlay, counter, and frontier", async () => {
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

    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:read_messages", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      readMessageIds: ["msg_5", "msg_7"],
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
      lastReadOrdinal: 4,
    })

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.readMessageIds?.stream_1).toEqual(["msg_5", "msg_7"])
      expect(state?.unreadCounts.stream_1).toBe(4) // 10 - 4 - 2
      const readState = await db.streamReadState.get("ws_1:stream_1")
      expect(readState?.lastReadSequence).toBe("40")
      expect(readState?.lastReadEventId).toBe("evt_4")
    })

    cleanup()
  })

  it("ignores a stream:read_messages for another workspace", async () => {
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

    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:read_messages", {
      workspaceId: "ws_other",
      authorId: "member_1",
      streamId: "stream_1",
      readMessageIds: ["msg_5"],
      lastReadEventId: "evt_4",
      lastReadSequence: "40",
      lastReadOrdinal: 4,
    })

    await new Promise((r) => setTimeout(r, 20))
    const state = await db.unreadState.get("ws_1")
    expect(state?.readMessageIds?.stream_1).toBeUndefined()
    expect(state?.unreadCounts.stream_1).toBe(6)
    cleanup()
  })

  describe("stream:read_all frontier propagation", () => {
    function seedUnreadState() {
      return db.unreadState.put({
        id: "ws_1",
        workspaceId: "ws_1",
        unreadCounts: { stream_1: 5 },
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        unreadActivities: [],
        latestOrdinals: { stream_1: 10 },
        mutedStreamIds: [],
        _cachedAt: Date.now(),
      })
    }

    const FRONTIER = {
      streamId: "stream_1",
      lastReadEventId: "evt_10",
      lastReadSequence: "100",
      lastReadOrdinal: 10,
      lastReadAt: "2024-01-01T00:00:00.000Z",
    }

    it("applies the additive frontier snapshot to the bootstrap cache and IDB (second-device path)", async () => {
      await seedUnreadState()
      const queryClient = new QueryClient()
      queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())
      const { socket, emit } = createTestSocket()
      const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

      emit("stream:read_all", {
        workspaceId: "ws_1",
        authorId: "member_1",
        streamIds: ["stream_1"],
        reads: [{ streamId: "stream_1", lastReadOrdinal: 10 }],
        frontiers: [FRONTIER],
      })

      await vi.waitFor(async () => {
        const readState = await db.streamReadState.get("ws_1:stream_1")
        expect(readState?.lastReadEventId).toBe("evt_10")
        expect(readState?.lastReadSequence).toBe("100")
        // The bootstrap cache (the divider's reload source) reflects the
        // frontier — published only after the IDB transaction commits.
        const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
        expect(bootstrap?.streamReadState?.stream_1).toMatchObject({
          lastReadEventId: "evt_10",
          lastReadSequence: "100",
        })
      })
      cleanup()
    })

    it("advances a stale local frontier", async () => {
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
      queryClient.setQueryData(
        workspaceKeys.bootstrap("ws_1"),
        makeBootstrap({
          streamReadState: { stream_1: { lastReadEventId: "evt_old", lastReadSequence: "50", lastReadAt: null } },
        })
      )
      const { socket, emit } = createTestSocket()
      const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

      emit("stream:read_all", {
        workspaceId: "ws_1",
        authorId: "member_1",
        streamIds: ["stream_1"],
        reads: [{ streamId: "stream_1", lastReadOrdinal: 10 }],
        frontiers: [FRONTIER],
      })

      await vi.waitFor(async () => {
        const readState = await db.streamReadState.get("ws_1:stream_1")
        expect(readState?.lastReadEventId).toBe("evt_10")
        expect(readState?.lastReadSequence).toBe("100")
        const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
        expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("100")
      })
      cleanup()
    })

    it("never regresses a higher local frontier", async () => {
      await seedUnreadState()
      await db.streamReadState.put({
        id: "ws_1:stream_1",
        workspaceId: "ws_1",
        streamId: "stream_1",
        lastReadEventId: "evt_ahead",
        lastReadSequence: "200",
        lastReadAt: null,
        _cachedAt: Date.now(),
      })
      const queryClient = new QueryClient()
      queryClient.setQueryData(
        workspaceKeys.bootstrap("ws_1"),
        makeBootstrap({
          streamReadState: { stream_1: { lastReadEventId: "evt_ahead", lastReadSequence: "200", lastReadAt: null } },
        })
      )
      const { socket, emit } = createTestSocket()
      const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

      // Stale/replayed snapshot (sequence 100 < local 200).
      emit("stream:read_all", {
        workspaceId: "ws_1",
        authorId: "member_1",
        streamIds: ["stream_1"],
        reads: [{ streamId: "stream_1", lastReadOrdinal: 10 }],
        frontiers: [FRONTIER],
      })

      // The counter still clears, but the frontier must not move backward.
      await vi.waitFor(async () => {
        const state = await db.unreadState.get("ws_1")
        expect(state?.unreadCounts.stream_1).toBe(0)
      })
      await vi.waitFor(async () => {
        const readState = await db.streamReadState.get("ws_1:stream_1")
        expect(readState?.lastReadEventId).toBe("evt_ahead")
        expect(readState?.lastReadSequence).toBe("200")
        const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
        expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("200")
      })
      cleanup()
    })

    it("a legacy payload without frontiers leaves existing frontier rows untouched", async () => {
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
      queryClient.setQueryData(
        workspaceKeys.bootstrap("ws_1"),
        makeBootstrap({
          streamReadState: { stream_1: { lastReadEventId: "evt_old", lastReadSequence: "50", lastReadAt: null } },
        })
      )
      const { socket, emit } = createTestSocket()
      const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

      // Legacy shape: no `frontiers` field — counter behavior only.
      emit("stream:read_all", {
        workspaceId: "ws_1",
        authorId: "member_1",
        streamIds: ["stream_1"],
        reads: [{ streamId: "stream_1", lastReadOrdinal: 10 }],
      })

      await vi.waitFor(async () => {
        const state = await db.unreadState.get("ws_1")
        expect(state?.unreadCounts.stream_1).toBe(0)
      })
      await vi.waitFor(async () => {
        const readState = await db.streamReadState.get("ws_1:stream_1")
        expect(readState?.lastReadEventId).toBe("evt_old")
        expect(readState?.lastReadSequence).toBe("50")
        const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
        expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("50")
      })
      cleanup()
    })
  })

  it("applies gate-dispatched saved/scheduled catch-up replays to IDB", async () => {
    // The coverage the engine-gated `refetchOnReconnect` is traded for: these
    // handlers register on the engine's event gate, so a catch-up replay
    // (gate.dispatch, never the raw socket) writes the rows through the same
    // code path as a live emit.
    await Promise.all([db.savedMessages.clear(), db.scheduledMessages.clear()])
    const queryClient = new QueryClient()
    const gate = new SocketEventGate("ws_1")
    const cleanup = registerWorkspaceSocketHandlers(gate, "ws_1", queryClient, handlerRefs)

    const now = new Date().toISOString()
    const saved: SavedMessageView = {
      id: "saved_replay",
      workspaceId: "ws_1",
      userId: "member_1",
      messageId: "msg_1",
      streamId: "stream_1",
      conversationId: null,
      status: "saved",
      title: null,
      note: null,
      remindAt: null,
      reminderSentAt: null,
      savedAt: now,
      statusChangedAt: now,
      message: null,
      unavailableReason: null,
    }
    const scheduled: ScheduledMessageView = {
      id: "sched_replay",
      workspaceId: "ws_1",
      userId: "member_1",
      streamId: "stream_1",
      parentMessageId: null,
      contentJson: { type: "doc", content: [] },
      contentMarkdown: "hello",
      attachmentIds: [],
      metadata: null,
      scheduledFor: now,
      status: "pending",
      sentMessageId: null,
      lastError: null,
      editActiveUntil: null,
      clientMessageId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      statusChangedAt: now,
    }

    await gate.dispatch("saved:upserted", { workspaceId: "ws_1", saved })
    await gate.dispatch("scheduled_message:upserted", { workspaceId: "ws_1", scheduled })

    // The handlers persist fire-and-forget, so poll IDB for the rows.
    await vi.waitFor(async () => {
      expect(await db.savedMessages.get("saved_replay")).toBeTruthy()
      expect(await db.scheduledMessages.get("sched_replay")).toBeTruthy()
    })

    cleanup()
    gate.dispose()
  })

  it("applies gate-dispatched label assignment catch-up replays to IDB", async () => {
    // The coverage labels' dropped `refetchOnReconnect` is traded for in
    // active mode: the label handlers register on the engine's event gate, so
    // a catch-up replay (gate.dispatch, never the raw socket) lands assignment
    // rows in IDB through the same code path as a live emit.
    await db.labelAssignments.clear()
    const queryClient = new QueryClient()
    const gate = new SocketEventGate("ws_1")
    const cleanup = registerWorkspaceSocketHandlers(gate, "ws_1", queryClient, handlerRefs)

    const assignment: LabelAssignment = {
      workspaceId: "ws_1",
      labelId: "label_1",
      resourceType: "stream",
      resourceId: "stream_1",
      actorType: "user",
      userId: "member_1",
      assignedAt: new Date().toISOString(),
    }
    const rowId = assignmentId("ws_1", "stream", "stream_1", "label_1", "member_1")

    await gate.dispatch("label:assigned", { workspaceId: "ws_1", targetUserId: null, assignment })
    // The handlers persist fire-and-forget, so poll IDB for the row.
    await vi.waitFor(async () => {
      expect(await db.labelAssignments.get(rowId)).toBeTruthy()
    })

    await gate.dispatch("label:unassigned", {
      workspaceId: "ws_1",
      targetUserId: null,
      labelId: "label_1",
      resourceType: "stream",
      resourceId: "stream_1",
      userId: "member_1",
    })
    await vi.waitFor(async () => {
      expect(await db.labelAssignments.get(rowId)).toBeUndefined()
    })

    cleanup()
    gate.dispose()
  })

  it("applies a gate-dispatched notification-level catch-up replay to IDB", async () => {
    // A mute/notify change made in another session reaches this one as either a
    // live emit or a catch-up replay (gate.dispatch); both share this handler.
    // It writes the new level into the streamMemberships mirror AND the derived
    // unreadState.mutedStreamIds set — the latter is what the sidebar / quick-
    // switcher / share badges actually render from, so both must move.
    const queryClient = new QueryClient()
    const gate = new SocketEventGate("ws_1")
    const cleanup = registerWorkspaceSocketHandlers(gate, "ws_1", queryClient, handlerRefs)

    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })
    await db.streams.put({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "channel",
      displayName: "general",
      slug: "general",
      description: null,
      visibility: "public",
      parentStreamId: null,
      rootStreamId: null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "member_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      _cachedAt: Date.now(),
    })
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    await gate.dispatch("stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      notificationLevel: "muted",
    })

    await vi.waitFor(async () => {
      expect((await db.streamMemberships.get("ws_1:stream_1"))?.notificationLevel).toBe("muted")
      // The badge source: muting the channel adds it to the muted set.
      expect((await db.unreadState.get("ws_1"))?.mutedStreamIds).toContain("stream_1")
    })

    // Unmuting (back to the channel default) removes it from the set again.
    await gate.dispatch("stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      notificationLevel: null,
    })

    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.mutedStreamIds).not.toContain("stream_1")
    })

    cleanup()
    gate.dispose()
  })

  it("applies a gate-dispatched notification-level replay to the in-memory bootstrap caches", async () => {
    // Companion to the IDB test above. The same handler also moves the two
    // TanStack caches the UI reads in-memory, with no IDB round-trip or remount:
    // the workspace bootstrap's derived `mutedStreamIds` (what the sidebar /
    // quick-switcher / share badges render from) and the stream bootstrap's
    // `membership.notificationLevel` (the settings dialog's selected level).
    // setQueryData is synchronous inside the handler, so the caches are current
    // the moment dispatch resolves — no waitFor needed for these reads.
    const queryClient = new QueryClient()
    const gate = new SocketEventGate("ws_1")
    const cleanup = registerWorkspaceSocketHandlers(gate, "ws_1", queryClient, handlerRefs)

    const channel: StreamWithPreview = { ...makeStreamBootstrap("stream_1").stream, lastMessagePreview: null }
    const membership: StreamMember = {
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: null,
      joinedAt: new Date().toISOString(),
    }
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ streams: [channel], streamMemberships: [membership], mutedStreamIds: [] })
    )
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_1"), makeStreamBootstrap("stream_1", { membership }))

    await gate.dispatch("stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      notificationLevel: "muted",
    })

    const mutedWorkspace = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(mutedWorkspace?.mutedStreamIds).toContain("stream_1")
    expect(mutedWorkspace?.streamMemberships.find((m) => m.streamId === "stream_1")?.notificationLevel).toBe("muted")
    expect(
      queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap("ws_1", "stream_1"))?.membership?.notificationLevel
    ).toBe("muted")

    // Unmuting (back to the channel default) reverses both caches in place.
    await gate.dispatch("stream:notification_level_updated", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      notificationLevel: null,
    })

    const unmutedWorkspace = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(unmutedWorkspace?.mutedStreamIds).not.toContain("stream_1")
    expect(unmutedWorkspace?.streamMemberships.find((m) => m.streamId === "stream_1")?.notificationLevel).toBeNull()
    expect(
      queryClient.getQueryData<StreamBootstrap>(streamKeys.bootstrap("ws_1", "stream_1"))?.membership?.notificationLevel
    ).toBeNull()

    cleanup()
    gate.dispose()
  })

  // The event is delivered to the memo's source stream room, not the workspace
  // room — but registration is per event type on the one workspace socket, so
  // the handler must still fire on the room-delivered payload.
  it("invalidates the memo search queries when a memo:created event lands", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("memo:created", { workspaceId: "ws_1", streamId: "stream_1", memoId: "memo_1" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: memoKeys.searches("ws_1") })
    cleanup()
  })

  it("ignores memo:created events from other workspaces", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("memo:created", { workspaceId: "ws_other", streamId: "stream_1", memoId: "memo_1" })

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: memoKeys.searches("ws_other") })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: memoKeys.searches("ws_1") })
    cleanup()
  })

  it("merges a conversation:updated for a cached card into the board IDB store (re-sorts live)", async () => {
    await db.conversations.clear()
    await db.conversations.put({
      id: "conv_1",
      workspaceId: "ws_1",
      conversation: { id: "conv_1", lastActivityAt: "2026-06-20T12:00:00.000Z" },
      openingMessage: null,
      recentMessages: [],
      totalReplies: 0,
      _lastActivityMs: Date.parse("2026-06-20T12:00:00.000Z"),
      _cachedAt: Date.now(),
    } as never)
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("conversation:updated", {
      workspaceId: "ws_1",
      conversation: { id: "conv_1", lastActivityAt: "2026-06-22T12:00:00.000Z" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const row = await db.conversations.get("conv_1")
    expect(row?._lastActivityMs).toBe(Date.parse("2026-06-22T12:00:00.000Z"))
    // A cached card merges in place — no refetch of the board head.
    expect(invalidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: [...conversationKeys.all, "workspaceList", "ws_1"] })
    )
    cleanup()
  })

  it("refreshes the board head when a conversation:created arrives for an uncached card", async () => {
    await db.conversations.clear()
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("conversation:created", {
      workspaceId: "ws_1",
      conversation: { id: "conv_new", lastActivityAt: "2026-06-22T12:00:00.000Z" },
    })
    // The handler awaits the (async) IDB merge before deciding to invalidate, so
    // poll for the call rather than a single tick — one macrotask isn't enough
    // for the Dexie transaction to settle.
    for (let i = 0; i < 50 && invalidate.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // The event carries the aggregate but not the message bodies, so a card we
    // don't have cached is hydrated by refetching the board head (stale-mark all,
    // refetch only active observers).
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...conversationKeys.all, "workspaceList", "ws_1"],
      refetchType: "active",
    })
    cleanup()
  })

  it("ignores conversation events from other workspaces", async () => {
    await db.conversations.clear()
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("conversation:created", {
      workspaceId: "ws_other",
      conversation: { id: "conv_x", lastActivityAt: "2026-06-22T12:00:00.000Z" },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(await db.conversations.get("conv_x")).toBeUndefined()
    expect(invalidate).not.toHaveBeenCalled()
    cleanup()
  })

  const invitationEventTypes = [
    "invitation:sent",
    "invitation:accepted",
    "invitation:revoked",
    "invitation:link-created",
    "invitation:link-claimed",
  ] as const

  it.each(invitationEventTypes)("invalidates the invitations list when %s lands", (eventType) => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit(eventType, { workspaceId: "ws_1", invitationId: "invite_1" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: invitationKeys.list("ws_1") })
    cleanup()
  })

  it("ignores invitation events from other workspaces", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("invitation:sent", { workspaceId: "ws_other", invitationId: "invite_1" })

    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: invitationKeys.list("ws_other") })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: invitationKeys.list("ws_1") })
    cleanup()
  })

  it("invalidates the invitations list on a gate-dispatched catch-up replay", async () => {
    // The coverage proof: in active mode the invitation handler registers on
    // the engine's event gate, so a catch-up replay (gate.dispatch, never the
    // raw socket) heals an open list through the same path as a live emit —
    // this is what lets another admin's invite/revoke reach a viewer who was
    // disconnected when it happened.
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const gate = new SocketEventGate("ws_1")
    const cleanup = registerWorkspaceSocketHandlers(gate, "ws_1", queryClient, handlerRefs)

    await gate.dispatch("invitation:revoked", { workspaceId: "ws_1", invitationId: "invite_1" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: invitationKeys.list("ws_1") })
    cleanup()
    gate.dispose()
  })

  it("subscribes the creator when a new stream is created at runtime", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
      })
    )

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_new",
      stream: {
        id: "stream_new",
        workspaceId: "ws_1",
        type: "channel",
        displayName: "Engineering",
        slug: "engineering",
        description: null,
        visibility: "public",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "off",
        companionPersonaId: null,
        createdBy: "member_1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
    })

    await Promise.resolve()

    expect(subscribeStream).toHaveBeenCalledWith("stream_new")
    expect(await db.streamMemberships.get("ws_1:stream_new")).toBeDefined()

    cleanup()
  })

  it("excludes a persona-test scratchpad from the sidebar cache and IDB on live create", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ users: [makeWorkspaceUser()], streams: [], streamMemberships: [] })
    )

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_persona_test",
      stream: {
        id: "stream_persona_test",
        workspaceId: "ws_1",
        type: "scratchpad",
        displayName: "Ariadne draft test",
        slug: null,
        description: null,
        visibility: "private",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "on",
        companionPersonaId: "persona_system_ariadne",
        // The workbench marker — the creator would otherwise get it in the sidebar.
        purpose: "persona_test",
        createdBy: "member_1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
    })

    await Promise.resolve()

    // Not listed, not persisted, not subscribed — it is mounted directly by the
    // editor, which runs its own subscribe+bootstrap.
    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.streams.some((s) => s.id === "stream_persona_test")).toBe(false)
    expect(await db.streamMemberships.get("ws_1:stream_persona_test")).toBeUndefined()
    expect(await db.streams.get("stream_persona_test")).toBeUndefined()
    expect(subscribeStream).not.toHaveBeenCalledWith("stream_persona_test")

    cleanup()
  })

  it("ignores the creator's own stream:member_added for a persona-test stream (the second sidebar-add path)", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ users: [makeWorkspaceUser()], streams: [], streamMemberships: [] })
    )

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:member_added", {
      workspaceId: "ws_1",
      streamId: "stream_persona_test",
      memberId: "member_1",
      stream: {
        id: "stream_persona_test",
        workspaceId: "ws_1",
        type: "scratchpad",
        displayName: "Ariadne draft test",
        slug: null,
        description: null,
        visibility: "private",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "on",
        companionPersonaId: "persona_system_ariadne",
        purpose: "persona_test",
        createdBy: "member_1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
      event: { id: "evt_1", streamId: "stream_persona_test", eventType: "member_added" },
    })

    await Promise.resolve()

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.streams.some((s) => s.id === "stream_persona_test")).toBe(false)
    expect(cached?.streamMemberships.some((m) => m.streamId === "stream_persona_test")).toBe(false)
    expect(await db.streams.get("stream_persona_test")).toBeUndefined()
    expect(subscribeStream).not.toHaveBeenCalledWith("stream_persona_test")

    cleanup()
  })

  it("patches only the user layer on feature_flags:updated, leaving the workspace layer intact", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ featureFlags: { workspace: { calls: "off" }, user: {} } })
    )

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })

    emit("feature_flags:updated", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      overrides: { newComposer: "on" },
    })

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.featureFlags).toEqual({ workspace: { calls: "off" }, user: { newComposer: "on" } })

    cleanup()
  })

  it("patches only the workspace layer on feature_flags:workspace_updated, leaving the user layer intact", () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ featureFlags: { workspace: {}, user: { newComposer: "on" } } })
    )

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })

    emit("feature_flags:workspace_updated", {
      workspaceId: "ws_1",
      overrides: { calls: "off" },
    })

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.featureFlags).toEqual({ workspace: { calls: "off" }, user: { newComposer: "on" } })

    cleanup()
  })

  it("writes the patched layers back to the persisted metadata row so a warm restart repaints the live value", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ featureFlags: { workspace: {}, user: {} } })
    )
    await db.workspaceMetadata.put({
      id: "ws_1",
      workspaceId: "ws_1",
      emojis: [],
      emojiWeights: {},
      commands: [],
      featureFlags: { workspace: {}, user: {} },
      _cachedAt: 1,
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })

    emit("feature_flags:workspace_updated", { workspaceId: "ws_1", overrides: { calls: "off" } })

    await vi.waitFor(async () => {
      const persisted = await db.workspaceMetadata.get("ws_1")
      expect(persisted?.featureFlags).toEqual({ workspace: { calls: "off" }, user: {} })
    })

    cleanup()
    await db.workspaceMetadata.clear()
  })

  it("promotes newly created DMs for recipients without waiting for a workspace refetch", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [
          makeWorkspaceUser(),
          {
            id: "member_2",
            workspaceId: "ws_1",
            workosUserId: "workos_2",
            email: "invitee@example.com",
            role: "member",
            slug: "invitee",
            name: "Invitee",
            description: null,
            avatarUrl: null,
            timezone: "Europe/Stockholm",
            locale: "en",
            pronouns: null,
            phone: null,
            githubUsername: null,
            statusEmoji: null,
            statusText: null,
            statusExpiresAt: null,
            statusPausesNotifications: false,
            notificationsPausedUntil: null,
            notificationsPausedIndefinitely: false,
            setupCompleted: true,
            joinedAt: new Date().toISOString(),
          },
        ],
        streams: [],
        streamMemberships: [],
        dmPeers: [],
      })
    )

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:created", {
      workspaceId: "ws_1",
      streamId: "stream_dm_1",
      dmUserIds: ["member_1", "member_2"],
      stream: {
        id: "stream_dm_1",
        workspaceId: "ws_1",
        type: "dm",
        displayName: null,
        slug: null,
        description: null,
        visibility: "private",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "off",
        companionPersonaId: null,
        createdBy: "member_2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(subscribeStream).toHaveBeenCalledWith("stream_dm_1")
    expect(await db.streams.get("stream_dm_1")).toMatchObject({
      id: "stream_dm_1",
      type: "dm",
      displayName: "Invitee",
    })
    expect(await db.streamMemberships.get("ws_1:stream_dm_1")).toMatchObject({
      streamId: "stream_dm_1",
      memberId: "member_1",
    })
    expect(await db.dmPeers.get("ws_1:stream_dm_1")).toMatchObject({
      streamId: "stream_dm_1",
      userId: "member_2",
    })

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streams).toContainEqual(expect.objectContaining({ id: "stream_dm_1", displayName: "Invitee" }))
    expect(bootstrap?.streamMemberships).toContainEqual(expect.objectContaining({ streamId: "stream_dm_1" }))
    expect(bootstrap?.dmPeers).toContainEqual(expect.objectContaining({ streamId: "stream_dm_1", userId: "member_2" }))

    cleanup()
  })

  it("upserts carried bot metadata when a bot joins a stream (personal bots are outside other members' rosters)", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({ users: [makeWorkspaceUser()], streams: [], streamMemberships: [], bots: [] })
    )

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })

    const bot = {
      id: "bot_friend",
      workspaceId: "ws_1",
      type: "personal",
      ownerUserId: "member_2",
      traits: [],
      slug: "kris-bot",
      name: "Kris's Bot",
      description: null,
      avatarEmoji: null,
      avatarUrl: null,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    emit("stream:member_added", {
      workspaceId: "ws_1",
      streamId: "stream_dm_bot",
      memberId: "bot_friend",
      stream: {
        id: "stream_dm_bot",
        workspaceId: "ws_1",
        type: "dm",
        displayName: null,
        slug: null,
        description: null,
        visibility: "private",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "off",
        companionPersonaId: null,
        createdBy: "member_2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
      event: { id: "evt_bot", streamId: "stream_dm_bot", eventType: "member_added", actorType: "bot" },
      bot,
    })

    await Promise.resolve()

    const cached = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(cached?.bots).toContainEqual(expect.objectContaining({ id: "bot_friend", name: "Kris's Bot" }))
    expect(await db.bots.get("bot_friend")).toMatchObject({ id: "bot_friend", name: "Kris's Bot" })

    cleanup()
  })

  it("subscribes the current user when they are added to a stream at runtime", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
      })
    )

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => undefined,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:member_added", {
      workspaceId: "ws_1",
      streamId: "stream_added",
      memberId: "member_1",
      stream: {
        id: "stream_added",
        workspaceId: "ws_1",
        type: "channel",
        displayName: "Added",
        slug: "added",
        description: null,
        visibility: "public",
        parentStreamId: null,
        rootStreamId: null,
        companionMode: "off",
        companionPersonaId: null,
        createdBy: "member_2",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      },
    })

    await Promise.resolve()

    expect(subscribeStream).toHaveBeenCalledWith("stream_added")
    expect(await db.streamMemberships.get("ws_1:stream_added")).toBeDefined()

    cleanup()
  })

  it("updates the membership read pointer when a stream:read socket event arrives", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [
          {
            id: "stream_1",
            workspaceId: "ws_1",
            type: "channel",
            displayName: "Engineering",
            slug: "engineering",
            description: null,
            visibility: "public",
            parentStreamId: null,
            rootStreamId: null,
            companionMode: "off",
            companionPersonaId: null,
            createdBy: "member_1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archivedAt: null,
            lastMessagePreview: null,
          },
        ],
        streamMemberships: [
          {
            streamId: "stream_1",
            memberId: "member_1",
            notificationLevel: "everything",
            joinedAt: new Date().toISOString(),
          },
        ],
        unreadCounts: { stream_1: 1 },
        mentionCounts: { stream_1: 0 },
        activityCounts: { stream_1: 0 },
      })
    )

    await db.streams.put({
      id: "stream_1",
      workspaceId: "ws_1",
      type: "channel",
      displayName: "Engineering",
      slug: "engineering",
      description: null,
      visibility: "public",
      parentStreamId: null,
      rootStreamId: null,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "member_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      _cachedAt: Date.now(),
    })
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 1 },
      mentionCounts: { stream_1: 0 },
      activityCounts: { stream_1: 0 },
      unreadActivityCount: 0,
      unreadActivities: [],
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    const subscribeStream = vi.fn()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => "stream_1",
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream,
    })

    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_new",
      lastReadSequence: "12",
    })

    await Promise.resolve()

    // The frontier lands in stream_read_state: IDB row + bootstrap map.
    // Membership is never written on a read.
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        workspaceId: "ws_1",
        streamId: "stream_1",
        lastReadEventId: "event_new",
        lastReadSequence: "12",
      })
    })
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1).toMatchObject({
      lastReadEventId: "event_new",
      lastReadSequence: "12",
    })

    cleanup()
  })

  it("max-merges the standalone frontier on stream:read — a stale replay never regresses it", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
        streamReadState: {
          stream_1: { lastReadEventId: "event_new", lastReadSequence: "20", lastReadAt: null },
        },
      })
    )
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "event_new",
      lastReadSequence: "20",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    // A replayed/stale advance from catch-up, below the stored frontier.
    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_old",
      lastReadSequence: "10",
      lastReadOrdinal: 3,
    })

    await Promise.resolve()

    // The monotonic store keeps the higher frontier (cache + IDB).
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1?.lastReadEventId).toBe("event_new")
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("20")
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        lastReadEventId: "event_new",
        lastReadSequence: "20",
      })
    })

    cleanup()
  })

  it("a sequence-less stream:read never overwrites an EXISTING frontier", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [
          {
            streamId: "stream_1",
            memberId: "member_1",
            notificationLevel: null,
            joinedAt: new Date().toISOString(),
          },
        ],
        streamReadState: {
          stream_1: { lastReadEventId: "event_new", lastReadSequence: "20", lastReadAt: null },
        },
      })
    )
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "event_new",
      lastReadSequence: "20",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    // Legacy payload: no lastReadSequence. Event ids are not order-comparable,
    // so the frontier must not be touched — the next bootstrap reconciles.
    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_legacy",
      lastReadOrdinal: 3,
    })

    await Promise.resolve()

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1?.lastReadEventId).toBe("event_new")
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("20")
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        lastReadEventId: "event_new",
        lastReadSequence: "20",
      })
    })

    cleanup()
  })

  it("a sequence-less stream:read leaves a present explicit-NULL standalone row unchanged", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
        // Explicit unread-to-zero: the row exists with a null watermark.
        streamReadState: {
          stream_1: { lastReadEventId: null, lastReadSequence: "0", lastReadAt: null },
        },
      })
    )
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: null,
      lastReadSequence: "0",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_legacy",
      lastReadOrdinal: 3,
    })

    await Promise.resolve()

    // Row presence is authoritative — the sequence-less event id can't be
    // ordered against the explicit frontier, so the row stays.
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1?.lastReadEventId).toBeNull()
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("0")
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        lastReadEventId: null,
        lastReadSequence: "0",
      })
    })

    cleanup()
  })

  it("a sequence-less stream:read seeds a compatibility row when no standalone frontier exists", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
        // No streamReadState entry — pre-cutover client state.
      })
    )

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_legacy",
      lastReadOrdinal: 3,
    })

    await Promise.resolve()

    // Seeding is allowed: row presence beats the membership fallback, with a
    // null sequence marking "frontier from a sequence-less legacy event".
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        lastReadEventId: "event_legacy",
        lastReadSequence: null,
      })
    })
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1).toMatchObject({
      lastReadEventId: "event_legacy",
      lastReadSequence: null,
    })

    cleanup()
  })

  it("stream:read_set SETs the standalone frontier — explicit unread may regress it, null included", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streams: [],
        streamMemberships: [],
        streamReadState: {
          stream_1: { lastReadEventId: "event_new", lastReadSequence: "20", lastReadAt: null },
        },
      })
    )
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "event_new",
      lastReadSequence: "20",
      lastReadAt: null,
      _cachedAt: Date.now(),
    })

    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    // Mark-unread-to-zero: the pointer parks before the first message. The
    // present null must beat the stored non-null frontier.
    emit("stream:read_set", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: null,
      lastReadSequence: "0",
      lastReadOrdinal: 0,
    })

    await Promise.resolve()

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamReadState?.stream_1?.lastReadEventId).toBeNull()
    expect(bootstrap?.streamReadState?.stream_1?.lastReadSequence).toBe("0")
    await vi.waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({
        lastReadEventId: null,
        lastReadSequence: "0",
      })
    })

    cleanup()
  })

  it("puts a stream row on stream:unarchived when none exists in IDB (swept while archived)", async () => {
    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    // No pre-existing row — a bare .update() would no-op and silently lose it.
    emit("stream:unarchived", {
      workspaceId: "ws_1",
      streamId: "stream_unarch",
      stream: makeStream("stream_unarch", { archivedAt: null }),
    })

    await vi.waitFor(async () => {
      const row = await db.streams.get("stream_unarch")
      expect(row).toBeDefined()
      expect(row?.archivedAt).toBeNull()
      expect(row?.lastMessagePreview).toBeNull()
    })

    cleanup()
  })

  it("carries stream:archived / stream:unarchived onto the board rows the stream covers", async () => {
    await db.conversations.clear()
    await seedBoardRow("conv_arch", "ws_1", "thread_1", "stream_arch_board")
    await seedBoardRow("conv_elsewhere", "ws_1", "chan_other", "chan_other")

    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:archived", {
      workspaceId: "ws_1",
      streamId: "stream_arch_board",
      stream: makeStream("stream_arch_board", { archivedAt: "2026-01-01T00:00:00Z" }),
    })
    await vi.waitFor(async () => {
      expect(await db.conversations.get("conv_arch")).toMatchObject({ rootArchived: true })
    })
    expect((await db.conversations.get("conv_elsewhere"))?.rootArchived).toBeUndefined()

    emit("stream:unarchived", {
      workspaceId: "ws_1",
      streamId: "stream_arch_board",
      stream: makeStream("stream_arch_board", { archivedAt: null }),
    })
    await vi.waitFor(async () => {
      expect(await db.conversations.get("conv_arch")).toMatchObject({ rootArchived: false })
    })

    cleanup()
  })

  it("preserves an existing row's lastMessagePreview on stream:unarchived", async () => {
    await db.streams.put({
      ...makeStream("stream_unarch2", { archivedAt: "2026-01-01T00:00:00Z" }),
      lastMessagePreview: {
        authorId: "member_1",
        authorType: "user",
        content: "kept",
        createdAt: "2026-01-01T00:00:00Z",
      },
      _cachedAt: Date.now(),
    })

    const queryClient = new QueryClient()
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("stream:unarchived", {
      workspaceId: "ws_1",
      streamId: "stream_unarch2",
      stream: makeStream("stream_unarch2", { archivedAt: null }),
    })

    await vi.waitFor(async () => {
      const row = await db.streams.get("stream_unarch2")
      expect(row?.archivedAt).toBeNull()
      // Partial-merge upsert keeps the preview the socket payload never carries.
      expect(row?.lastMessagePreview?.content).toBe("kept")
    })

    cleanup()
  })
})

describe("unread counter events (absolute payloads, sync phase 2c)", () => {
  const preview = {
    authorId: "member_2",
    authorType: "user" as const,
    content: "hello",
    createdAt: new Date().toISOString(),
  }

  function membership(streamId: string) {
    return {
      streamId,
      memberId: "member_1",
      notificationLevel: null,
      joinedAt: new Date().toISOString(),
    }
  }

  /**
   * Fixture: stream_1 has 5 messages, 1 unread (implied read position 4),
   * 1 mention + 1 activity; stream_2 contributes 1 activity to the total.
   */
  function fixtureActivity(id: string, streamId: string, activityType: string): Activity {
    return {
      id,
      workspaceId: "ws_1",
      userId: "member_1",
      activityType,
      streamId,
      messageId: `msg_${id}`,
      actorId: "member_2",
      actorType: "user",
      context: {},
      readAt: null,
      createdAt: new Date().toISOString(),
      isSelf: false,
      emoji: null,
    }
  }

  async function seedCounterFixture(queryClient: QueryClient) {
    // The held set is the source of truth: stream_1 has one unread mention,
    // stream_2 one unread message. The count fields below are their projection.
    const unreadActivities = [
      fixtureActivity("act_s1", "stream_1", "mention"),
      fixtureActivity("act_s2", "stream_2", "message"),
    ]
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()],
        streamMemberships: [membership("stream_1"), membership("stream_2")],
        unreadCounts: { stream_1: 1 },
        mentionCounts: { stream_1: 1 },
        activityCounts: { stream_1: 1, stream_2: 1 },
        unreadActivityCount: 2,
        unreadActivities,
        messageCounts: { stream_1: 5 },
      })
    )

    const now = Date.now()
    await db.workspaceUsers.put({ ...makeWorkspaceUser(), _cachedAt: now })
    await db.streamMemberships.bulkPut(
      ["stream_1", "stream_2"].map((streamId) => ({
        ...membership(streamId),
        id: `ws_1:${streamId}`,
        workspaceId: "ws_1",
        _cachedAt: now,
      }))
    )
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 1 },
      mentionCounts: { stream_1: 1 },
      activityCounts: { stream_1: 1, stream_2: 1 },
      unreadActivityCount: 2,
      unreadActivities,
      latestOrdinals: { stream_1: 5 },
      mutedStreamIds: [],
      _cachedAt: now,
    })
  }

  function register(queryClient: QueryClient, currentStreamId?: string) {
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => currentStreamId,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })
    return { emit, cleanup }
  }

  beforeEach(async () => {
    await Promise.all([
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.streamReadState.clear(),
      db.workspaceUsers.clear(),
      db.unreadState.clear(),
    ])
  })

  it("applies stream:activity ordinals as absolutes — duplicates converge", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    const payload = {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    }
    emit("stream:activity", payload)
    emit("stream:activity", payload)

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(2)
    expect(bootstrap?.messageCounts?.stream_1).toBe(6)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadCounts.stream_1).toBe(2)
      expect(state?.latestOrdinals?.stream_1).toBe(6)
    })

    cleanup()
  })

  it("stream:activity records one activityApply sample per event", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)
    const capture = new PerfCapture()
    armPerfCapture(capture)

    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    })

    const samples = capture.snapshot().filter((s) => s.name === "stream.activityApply")
    expect(samples).toHaveLength(1)
    expect(samples[0].value).toBeTypeOf("number")

    armPerfCapture(NO_CAPTURE)
    cleanup()
  })

  it("advances the read position for own messages instead of skipping the event", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_1",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    })

    // The server auto-advances the author's read pointer in the send
    // transaction, so the prior unread message clears too.
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(0)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadCounts.stream_1).toBe(0)
      expect(state?.latestOrdinals?.stream_1).toBe(6)
    })

    cleanup()
  })

  it("raises unread for another author's message even while its route is focused", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient, "stream_1")

    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    })

    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.unreadCounts.stream_1).toBe(2)
    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(2)
    })

    cleanup()
  })

  it("raises unread for the currently viewed stream without a direct membership", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"), (current) =>
      current ? { ...current, streamMemberships: [] } : current
    )
    const { emit, cleanup } = register(queryClient, "stream_1")

    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    })

    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.unreadCounts.stream_1).toBe(2)
    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(2)
    })

    cleanup()
  })

  it("raises unread for the viewed stream while its window is unfocused", async () => {
    const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient, "stream_1")

    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: preview,
    })

    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.unreadCounts.stream_1).toBe(2)
    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(2)
    })

    cleanup()
    focusSpy.mockRestore()
  })

  it("applies stream:read absolute positions — newer messages stay unread", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    // 7 messages now exist; the read position covers 6 of them.
    emit("stream:activity", {
      workspaceId: "ws_1",
      streamId: "stream_1",
      authorId: "member_2",
      sequence: "10",
      messageOrdinal: 7,
      lastMessagePreview: preview,
    })
    emit("stream:read", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamId: "stream_1",
      lastReadEventId: "event_6",
      lastReadSequence: "8",
      lastReadOrdinal: 6,
    })

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(1)
    expect(bootstrap?.mentionCounts.stream_1 ?? 0).toBe(0)
    expect(bootstrap?.activityCounts.stream_1 ?? 0).toBe(0)
    // stream_1's rows dropped on read (coupling); stream_2's activity survives.
    expect(bootstrap?.unreadActivityCount).toBe(1)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadCounts.stream_1).toBe(1)
      expect(state?.unreadActivityCount).toBe(1)
    })

    cleanup()
  })

  it("applies stream:read_all reads as absolute positions", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    emit("stream:read_all", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamIds: ["stream_1", "stream_2"],
      reads: [
        { streamId: "stream_1", lastReadOrdinal: 5 },
        { streamId: "stream_2", lastReadOrdinal: 3 },
      ],
    })

    // The counter fold and the cache publication land only after the atomic
    // IDB transaction commits (a failed transaction publishes nothing).
    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadCounts.stream_1).toBe(0)
      expect(state?.unreadActivityCount).toBe(0)
      const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
      expect(bootstrap?.unreadCounts.stream_1).toBe(0)
      expect(bootstrap?.activityCounts).toEqual({})
      expect(bootstrap?.unreadActivityCount).toBe(0)
    })

    cleanup()
  })

  it("stream:read_all stamps standalone rows so an in-flight bootstrap preserves them", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    // A frontier written long before any in-flight fetch.
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_77",
      lastReadSequence: "77",
      lastReadAt: null,
      _cachedAt: Date.now() - 60_000,
    })
    const before = (await db.streamReadState.get("ws_1:stream_1"))?._cachedAt ?? 0

    emit("stream:read_all", {
      workspaceId: "ws_1",
      authorId: "member_1",
      streamIds: ["stream_1", "stream_2"],
      reads: [
        { streamId: "stream_1", lastReadOrdinal: 5 },
        { streamId: "stream_2", lastReadOrdinal: 3 },
      ],
    })

    // The stamp (not the value) moves: read_all carries no event ids, but an
    // in-flight bootstrap's per-stream merge must keep this row, not restore
    // a pre-read_all snapshot over it.
    await vi.waitFor(async () => {
      const row = await db.streamReadState.get("ws_1:stream_1")
      expect(row?._cachedAt).toBeGreaterThan(before)
      expect(row?.lastReadEventId).toBe("evt_77")
      expect(row?.lastReadSequence).toBe("77")
    })
    // read_all carries ordinals only — it must never fabricate a frontier row.
    expect(await db.streamReadState.get("ws_1:stream_2")).toBeUndefined()

    cleanup()
  })

  it("holds activity for a focused route until a viewport read clears it", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient, "stream_1")

    const before = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    emit("activity:created", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activity: {
        id: "act_viewed",
        activityType: "message",
        streamId: "stream_1",
        messageId: "msg_viewed",
        actorId: "member_2",
        actorType: "user",
        context: {},
        createdAt: new Date().toISOString(),
        isSelf: false,
        emoji: null,
      },
    })

    const after = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(after?.activityCounts.stream_1).toBe((before?.activityCounts.stream_1 ?? 0) + 1)
    expect(after?.unreadActivityCount).toBe((before?.unreadActivityCount ?? 0) + 1)

    cleanup()
  })

  it("holds an activity for the viewed stream when unfocused, and for other streams", async () => {
    const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(false)
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient, "stream_1")

    const base = {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activity: {
        id: "act_unfocused",
        activityType: "message",
        streamId: "stream_1",
        messageId: "msg_unfocused",
        actorId: "member_2",
        actorType: "user",
        context: {},
        createdAt: new Date().toISOString(),
        isSelf: false,
        emoji: null,
      },
    }
    const before = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    emit("activity:created", base)
    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.activityCounts.stream_1).toBe(
      (before?.activityCounts.stream_1 ?? 0) + 1
    )

    // A different stream is held even while focused on stream_1.
    focusSpy.mockReturnValue(true)
    emit("activity:created", {
      ...base,
      activity: { ...base.activity, id: "act_other", messageId: "msg_other", streamId: "stream_2" },
    })
    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.activityCounts.stream_2).toBe(
      (before?.activityCounts.stream_2 ?? 0) + 1
    )

    cleanup()
    focusSpy.mockRestore()
  })

  it("upserts activity:created rows by id (idempotent) and derives counts from the held set", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    const payload = {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activity: {
        id: "act_1",
        activityType: "mention",
        streamId: "stream_1",
        messageId: "msg_1",
        actorId: "member_2",
        actorType: "user",
        context: {},
        createdAt: new Date().toISOString(),
        isSelf: false,
        emoji: null,
      },
    }
    // A duplicate (sync-log replay) must upsert by id, never double-count.
    emit("activity:created", payload)
    emit("activity:created", payload)

    let bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    // Fixture seeded stream_1 with one mention (act_s1); act_1 adds a second.
    expect(bootstrap?.mentionCounts.stream_1).toBe(2)
    expect(bootstrap?.activityCounts.stream_1).toBe(2)
    expect(bootstrap?.unreadActivityCount).toBe(3) // stream_1: 2, stream_2: 1

    // A distinct id adds another held row.
    emit("activity:created", { ...payload, activity: { ...payload.activity, id: "act_2", messageId: "msg_2" } })
    bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.activityCounts.stream_1).toBe(3)
    expect(bootstrap?.unreadActivityCount).toBe(4)

    // A self row is never held (it doesn't count as unread).
    emit("activity:created", {
      ...payload,
      activity: { ...payload.activity, id: "act_self", messageId: "msg_self", isSelf: true },
    })
    bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadActivityCount).toBe(4)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadActivityCount).toBe(4)
      expect(state?.unreadActivities?.length).toBe(4)
    })

    cleanup()
  })

  it("activity:read drops held rows by id, re-derives counts, and is idempotent on replay", async () => {
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    // A read performed on another device drops exactly the listed ids;
    // unknown ids (already dropped, or outside the capped held set) no-op.
    emit("activity:read", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activityIds: ["act_s1", "act_unknown"],
      streamIds: ["stream_1"],
    })

    let bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadActivities?.map((a) => a.id)).toEqual(["act_s2"])
    expect(bootstrap?.activityCounts).toEqual({ stream_2: 1 })
    expect(bootstrap?.mentionCounts).toEqual({})
    expect(bootstrap?.unreadActivityCount).toBe(1)

    // Duplicate/replayed event is a no-op.
    emit("activity:read", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activityIds: ["act_s1"],
      streamIds: ["stream_1"],
    })
    bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadActivityCount).toBe(1)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadActivities?.map((a) => a.id)).toEqual(["act_s2"])
      expect(state?.unreadActivityCount).toBe(1)
    })

    cleanup()
  })

  it("catch-up ordering: a creation replayed after a read settles held (snapshot semantics)", async () => {
    // A row created after the read (its id absent from the delta) stays unread:
    // replay applies the read first (unknown-id no-op), then the creation.
    const queryClient = new QueryClient()
    await seedCounterFixture(queryClient)
    const { emit, cleanup } = register(queryClient)

    emit("activity:read", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activityIds: ["act_read_elsewhere"],
      streamIds: ["stream_1"],
    })
    emit("activity:created", {
      workspaceId: "ws_1",
      targetUserId: "member_1",
      activity: {
        id: "act_late",
        activityType: "message",
        streamId: "stream_1",
        messageId: "msg_late",
        actorId: "member_2",
        actorType: "user",
        context: {},
        createdAt: new Date().toISOString(),
        isSelf: false,
        emoji: null,
      },
    })

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadActivities?.map((a) => a.id)).toContain("act_late")
    expect(bootstrap?.unreadActivityCount).toBe(3)

    cleanup()
  })
})

describe("latest ordinal seeding and reconnect merge (sync phase 2c)", () => {
  beforeEach(async () => {
    await Promise.all([db.unreadState.clear(), db.streamReadState.clear()])
  })

  it("applyWorkspaceBootstrap seeds latestOrdinals from messageCounts", async () => {
    await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        unreadCounts: { stream_1: 2 },
        messageCounts: { stream_1: 7 },
      })
    )

    expect((await db.unreadState.get("ws_1"))?.latestOrdinals).toEqual({ stream_1: 7 })
  })

  it("applyWorkspaceBootstrap heals a drifted stream even when another stream keeps the local row fresh", async () => {
    const fetchStartedAt = Date.now() - 1000
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      // stream_drifted: stale local zero (server says 3 unread). stream_busy:
      // touched during the fetch window, its local count must survive.
      unreadCounts: { stream_drifted: 0, stream_busy: 5 },
      mentionCounts: {},
      activityCounts: {},
      unreadActivityCount: 0,
      unreadActivities: [],
      latestOrdinals: { stream_drifted: 8, stream_busy: 12 },
      mutedStreamIds: [],
      counterTouchedAt: { stream_busy: fetchStartedAt + 200 },
      _cachedAt: fetchStartedAt + 200,
    })

    const { bootstrap: effective } = await applyWorkspaceBootstrap(
      "ws_1",
      makeBootstrap({
        unreadCounts: { stream_drifted: 3, stream_busy: 9 },
        messageCounts: { stream_drifted: 8, stream_busy: 9 },
      }),
      fetchStartedAt
    )

    const row = await db.unreadState.get("ws_1")
    expect(row?.unreadCounts).toEqual({ stream_drifted: 3, stream_busy: 5 })
    expect(row?.latestOrdinals).toEqual({ stream_drifted: 8, stream_busy: 12 })
    // The returned bootstrap (written to the query cache by callers) carries
    // the same merged counters as IDB.
    expect(effective.unreadCounts).toEqual({ stream_drifted: 3, stream_busy: 5 })
    expect(effective.messageCounts).toEqual({ stream_drifted: 8, stream_busy: 12 })
  })

  it("mergeReconnectWorkspaceBootstrap keeps each stream's ordinal paired with its winning unread source", () => {
    const fetchStartedAt = Date.now() - 1000
    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap: makeBootstrap({
        unreadCounts: { stream_fresh: 9, stream_stale: 9, stream_gone: 9 },
        messageCounts: { stream_fresh: 9, stream_stale: 9, stream_gone: 9 },
      }),
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(["stream_stale"]),
      terminalStreamIds: new Set(["stream_gone"]),
      localStreams: [],
      localMemberships: [],
      localReadStates: [],
      localUnreadState: {
        id: "ws_1",
        workspaceId: "ws_1",
        // stream_fresh was TOUCHED during the fetch window, so its local pair
        // wins; stream_stale rides the failed-catch-up branch and keeps its
        // local unread but has NO local ordinal — its baseline must drop
        // rather than pair the server ordinal with the local unread.
        unreadCounts: { stream_fresh: 2, stream_stale: 1 },
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        unreadActivities: [],
        latestOrdinals: { stream_fresh: 11 },
        mutedStreamIds: [],
        counterTouchedAt: { stream_fresh: fetchStartedAt + 500 },
        _cachedAt: fetchStartedAt + 500,
      },
      fetchStartedAt,
    })

    expect(merged.unreadCounts).toEqual({ stream_fresh: 2, stream_stale: 1 })
    expect(merged.messageCounts).toEqual({ stream_fresh: 11 })
  })

  it("mergeReconnectWorkspaceBootstrap lets the server heal a stream the local row did not touch during the fetch", () => {
    const fetchStartedAt = Date.now() - 1000
    const merged = mergeReconnectWorkspaceBootstrap({
      workspaceBootstrap: makeBootstrap({
        unreadCounts: { stream_drifted: 4, stream_busy: 9 },
        messageCounts: { stream_drifted: 10, stream_busy: 9 },
      }),
      successfulStreamBootstraps: new Map(),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
      localReadStates: [],
      localUnreadState: {
        id: "ws_1",
        workspaceId: "ws_1",
        // The row is "fresh" (stream_busy was touched during the fetch), but
        // stream_drifted was NOT — its stale local zero must lose to the
        // server's count instead of riding the row-level freshness.
        unreadCounts: { stream_drifted: 0, stream_busy: 3 },
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        unreadActivities: [],
        latestOrdinals: { stream_drifted: 10, stream_busy: 12 },
        mutedStreamIds: [],
        counterTouchedAt: { stream_busy: fetchStartedAt + 200 },
        _cachedAt: fetchStartedAt + 200,
      },
      fetchStartedAt,
    })

    expect(merged.unreadCounts).toEqual({ stream_drifted: 4, stream_busy: 3 })
    expect(merged.messageCounts).toEqual({ stream_drifted: 10, stream_busy: 12 })
  })
})

describe("agent-activity sidebar socket handlers", () => {
  const handlerRefs = {
    getCurrentStreamId: () => undefined,
    getCurrentUser: () => ({ id: "workos_1" }),
    subscribeStream: vi.fn(),
  }

  async function putStream(id: string, rootStreamId: string | null) {
    await db.streams.put({
      id,
      workspaceId: "ws_1",
      type: rootStreamId ? "thread" : "channel",
      displayName: id,
      slug: null,
      description: null,
      visibility: "public",
      parentStreamId: rootStreamId,
      rootStreamId,
      companionMode: "off",
      companionPersonaId: null,
      createdBy: "user_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      _cachedAt: Date.now(),
    })
  }

  beforeEach(async () => {
    __resetAgentActivityStore()
    await db.streams.clear()
  })

  it("upserts on started (wrapped outbox shape), resolving the channel root, and removes on the flat session-room completed shape", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_1", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })

    expect(getAgentActivityForStream("ws_1", "stream_ch").map((s) => s.sessionId)).toEqual(["sess_1"])

    // Flat session-room shape (trace dialog open on the shared socket).
    await emitAsync("agent_session:completed", { sessionId: "sess_1" })
    expect(getAgentActivityForStream("ws_1", "stream_ch")).toEqual([])

    cleanup()
  })

  it("keeps a thread session on the thread and honors the cross-workspace guard", async () => {
    await putStream("stream_ch", null)
    await putStream("stream_thr", "stream_ch")
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_thr",
      event: { payload: { sessionId: "sess_thr", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })
    expect(getAgentActivityForStream("ws_1", "stream_ch")).toEqual([])
    expect(getAgentActivityForStream("ws_1", "stream_thr").map((s) => s.sessionId)).toEqual(["sess_thr"])

    // Different workspace — ignored.
    await emitAsync("agent_session:started", {
      workspaceId: "ws_other",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_other", personaName: "X", startedAt: "2026-07-16T00:00:00.000Z" } },
    })
    expect(getAgentActivityForStream("ws_1", "stream_ch")).toEqual([])
    expect(getAgentActivityForStream("ws_1", "stream_thr").map((s) => s.sessionId)).toEqual(["sess_thr"])

    cleanup()
  })

  it("preserves lifecycle order when a terminal event arrives during started root resolution", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emit, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_race", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })
    await emitAsync("agent_session:completed", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_race" } },
    })

    expect(getAgentActivityForStream("ws_1", "stream_ch")).toEqual([])
    cleanup()
  })

  it("skips an uncached thread and leaves progress on a tracked session a no-op", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    // Started for a stream not in the cache — skipped, nothing tracked.
    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_uncached",
      event: { payload: { sessionId: "sess_u", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })
    expect(getAgentActivityForStream("ws_1", "stream_uncached")).toEqual([])

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_p", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })

    await emitAsync("agent_session:progress", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      sessionId: "sess_p",
      personaName: "Ariadne",
    })
    expect(getAgentActivityForStream("ws_1", "stream_ch").map((s) => s.sessionId)).toEqual(["sess_p"])

    cleanup()
  })

  it("folds live counts from progress ticks onto a tracked session", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_c", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })
    // The join-time bootstrap tick: it lands before any board row mounts, so the
    // counts must survive in the store for a late-mounting row to read.
    await emitAsync("agent_session:progress", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      sessionId: "sess_c",
      personaName: "Ariadne",
      stepCount: 5,
      messageCount: 1,
    })
    expect(getAgentSession("ws_1", "sess_c")).toMatchObject({ stepCount: 5, messageCount: 1 })

    await emitAsync("agent_session:substep", {
      sessionId: "sess_c",
      streamId: "stream_ch",
      substep: "Reading the migration",
      updatedAt: "2026-07-16T00:00:02.000Z",
    })
    expect(getAgentSession("ws_1", "sess_c")).toMatchObject({ substep: "Reading the migration" })

    cleanup()
  })

  it("decrypts a sealed substep, and skips it when the session is locked", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_e", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })

    const decrypt = vi.spyOn(agentSubstep, "decryptAgentSubstepText").mockResolvedValue("Planning queries…")
    await emitAsync("agent_session:substep", {
      workspaceId: "ws_1",
      sessionId: "sess_e",
      streamId: "stream_ch",
      ciphertext: "c1",
      envelope: { v: 1 },
      updatedAt: "2026-07-16T00:00:02.000Z",
    })
    expect(getAgentSession("ws_1", "sess_e")).toMatchObject({ substep: "Planning queries…" })

    // Locked session (or a failed open): the helper returns null and the ephemeral
    // substep is skipped rather than blanking the applied one.
    decrypt.mockResolvedValue(null)
    await emitAsync("agent_session:substep", {
      workspaceId: "ws_1",
      sessionId: "sess_e",
      streamId: "stream_ch",
      ciphertext: "c2",
      envelope: { v: 1 },
      updatedAt: "2026-07-16T00:00:03.000Z",
    })
    expect(getAgentSession("ws_1", "sess_e")).toMatchObject({ substep: "Planning queries…" })

    // A redelivery of the older substep (stream room + parent room) is dropped.
    decrypt.mockResolvedValue("Evaluating results…")
    await emitAsync("agent_session:substep", {
      workspaceId: "ws_1",
      sessionId: "sess_e",
      streamId: "stream_ch",
      ciphertext: "c1",
      envelope: { v: 1 },
      updatedAt: "2026-07-16T00:00:01.000Z",
    })
    expect(getAgentSession("ws_1", "sess_e")).toMatchObject({ substep: "Planning queries…" })

    decrypt.mockRestore()
    cleanup()
  })

  it("skips the substep decrypt entirely for a session it doesn't track", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    const decrypt = vi.spyOn(agentSubstep, "decryptAgentSubstepText").mockResolvedValue("Planning queries…")
    await emitAsync("agent_session:substep", {
      workspaceId: "ws_1",
      sessionId: "sess_untracked",
      streamId: "stream_ch",
      ciphertext: "c1",
      envelope: { v: 1 },
      updatedAt: "2026-07-16T00:00:02.000Z",
    })

    expect(decrypt).not.toHaveBeenCalled()
    decrypt.mockRestore()
    cleanup()
  })

  it("applies a terminal event without waiting on a pending substep decrypt", async () => {
    await putStream("stream_ch", null)
    const queryClient = new QueryClient()
    const { socket, emit, emitAsync } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    await emitAsync("agent_session:started", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_slow", personaName: "Ariadne", startedAt: "2026-07-16T00:00:00.000Z" } },
    })

    let resolveDecrypt: (text: string | null) => void = () => {}
    const pending = new Promise<string | null>((resolve) => {
      resolveDecrypt = resolve
    })
    const decrypt = vi.spyOn(agentSubstep, "decryptAgentSubstepText").mockReturnValue(pending)

    emit("agent_session:substep", {
      workspaceId: "ws_1",
      sessionId: "sess_slow",
      streamId: "stream_ch",
      ciphertext: "c1",
      envelope: { v: 1 },
      updatedAt: "2026-07-16T00:00:02.000Z",
    })

    // The decrypt is still open; the terminal event must not queue behind it.
    await emitAsync("agent_session:completed", {
      workspaceId: "ws_1",
      streamId: "stream_ch",
      event: { payload: { sessionId: "sess_slow" } },
    })
    expect(getAgentSession("ws_1", "sess_slow")).toBeUndefined()

    // The late decrypt lands on a removed session and is a no-op.
    resolveDecrypt("Planning queries…")
    await pending
    await Promise.resolve()
    expect(getAgentSession("ws_1", "sess_slow")).toBeUndefined()

    decrypt.mockRestore()
    cleanup()
  })
})

/** A board row anchored in `streamId` under `rootStreamId`, as the board store writes it. */
async function seedBoardRow(id: string, workspaceId: string, streamId: string, rootStreamId: string) {
  await db.conversations.put({
    id,
    workspaceId,
    rootStreamId,
    conversation: { id, streamId, lastActivityAt: "2026-06-20T12:00:00.000Z" },
    openingMessage: null,
    recentMessages: [],
    totalReplies: 0,
    _lastActivityMs: Date.parse("2026-06-20T12:00:00.000Z"),
    _cachedAt: Date.now(),
  } as never)
}

describe("stream:member_removed board cleanup", () => {
  const handlerRefs = {
    getCurrentStreamId: () => undefined,
    getCurrentUser: () => ({ id: "workos_1" }),
    subscribeStream: vi.fn(),
  }

  function seededClient(visibility: "public" | "private") {
    const queryClient = new QueryClient()
    queryClient.setQueryData(
      workspaceKeys.bootstrap("ws_1"),
      makeBootstrap({
        users: [makeWorkspaceUser()] as never,
        streams: [{ ...makeStream("chan_x", { visibility }), lastMessagePreview: null }] as StreamWithPreview[],
        streamMemberships: [
          { streamId: "chan_x", memberId: "member_1", notificationLevel: null, joinedAt: new Date().toISOString() },
        ] as StreamMember[],
      })
    )
    return queryClient
  }

  beforeEach(async () => {
    await db.conversations.clear()
  })

  it("drops the stream's board rows when the viewer loses access to a private stream", async () => {
    await seedBoardRow("conv_x", "ws_1", "thread_x", "chan_x")
    await seedBoardRow("conv_keep", "ws_1", "chan_y", "chan_y")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", seededClient("private"), handlerRefs)

    emit("stream:member_removed", { workspaceId: "ws_1", streamId: "chan_x", memberId: "member_1" })

    await vi.waitFor(async () => {
      expect(await db.conversations.get("conv_x")).toBeUndefined()
    })
    expect(await db.conversations.get("conv_keep")).toBeDefined()
    cleanup()
  })

  it("keeps the board rows of a PUBLIC stream — a public root grants read without membership (INV-62)", async () => {
    await seedBoardRow("conv_x", "ws_1", "thread_x", "chan_x")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", seededClient("public"), handlerRefs)

    emit("stream:member_removed", { workspaceId: "ws_1", streamId: "chan_x", memberId: "member_1" })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await db.conversations.get("conv_x")).toBeDefined()
    cleanup()
  })

  it("leaves the board alone when someone else is removed", async () => {
    await seedBoardRow("conv_x", "ws_1", "thread_x", "chan_x")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", seededClient("private"), handlerRefs)

    emit("stream:member_removed", { workspaceId: "ws_1", streamId: "chan_x", memberId: "member_2" })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await db.conversations.get("conv_x")).toBeDefined()
    cleanup()
  })
})

describe("stream:activity is the single preview writer", () => {
  const serverPreview = {
    authorId: "member_2",
    authorType: "user" as const,
    content: "**bold** from the server",
    createdAt: "2026-08-04T10:00:00.000Z",
  }

  function activity(streamId: string) {
    return {
      workspaceId: "ws_1",
      streamId,
      authorId: "member_2",
      sequence: "9",
      messageOrdinal: 6,
      lastMessagePreview: serverPreview,
    }
  }

  async function seedStreamRow(streamId: string) {
    await db.streams.put({
      id: streamId,
      workspaceId: "ws_1",
      rootStreamId: streamId,
      lastMessagePreview: null,
      _cachedAt: Date.now(),
    } as never)
  }

  function register(queryClient: QueryClient, currentStreamId?: string) {
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, {
      getCurrentStreamId: () => currentStreamId,
      getCurrentUser: () => ({ id: "workos_1" }),
      subscribeStream: vi.fn(),
    })
    return { emit, cleanup }
  }

  beforeEach(async () => {
    await Promise.all([db.streams.clear(), db.unreadState.clear()])
  })

  it("stream:activity writes the server markdown as the preview content", async () => {
    const streamId = "stream_activity_markdown"
    await seedStreamRow(streamId)
    const queryClient = new QueryClient()
    const { emit, cleanup } = register(queryClient)

    emit("stream:activity", activity(streamId))

    await vi.waitFor(async () => {
      const stored = (await db.streams.get(streamId))?.lastMessagePreview
      expect({ preview: stored, isString: typeof stored?.content === "string" }).toEqual({
        preview: serverPreview,
        isString: true,
      })
    })

    cleanup()
  })

  it("a stream:activity for the currently-open stream still commits its preview", async () => {
    const streamId = "stream_activity_open"
    await seedStreamRow(streamId)
    const queryClient = new QueryClient()
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined)
    const { emit, cleanup } = register(queryClient, streamId)

    emit("stream:activity", activity(streamId))

    await vi.waitFor(async () => {
      expect((await db.streams.get(streamId))?.lastMessagePreview).toEqual(serverPreview)
    })
    expect(
      invalidateQueries.mock.calls.some(
        (call) => JSON.stringify(call[0]?.queryKey) === JSON.stringify(streamKeys.bootstrap("ws_1", streamId))
      )
    ).toBe(false)

    cleanup()
  })
})
