import { describe, it, expect, beforeEach, vi } from "vitest"
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
import { getAgentActivityForStream, __resetAgentActivityStore } from "@/stores/agent-activity-store"
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
          lastReadEventId: "evt_old",
          lastReadAt: null,
          joinedAt: new Date().toISOString(),
        },
      ],
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
              lastReadEventId: "evt_new",
              lastReadAt: null,
              joinedAt: new Date().toISOString(),
            },
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
    })

    expect(merged.unreadCounts.stream_visible).toBe(1)
    expect(
      merged.streamMemberships.find((membership) => membership.streamId === "stream_visible")?.lastReadEventId
    ).toBe("evt_new")
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
      fetchStartedAt,
    })

    expect(merged.streams.map((s) => s.id)).toEqual(["stream_active_fresh"])
  })

  it("preserves prior local state for visible streams that fail reconnect bootstrap", () => {
    const workspaceBootstrap = makeBootstrap({
      streams: [],
      streamMemberships: [],
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
          lastReadEventId: "evt_cached",
          lastReadSequence: "77",
          lastReadAt: null,
          joinedAt: new Date().toISOString(),
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
    const failedMembership = merged.streamMemberships.find((membership) => membership.streamId === "stream_failed")
    // The board-card sequence frontier must survive the cached→bootstrap
    // conversion — dropping it silently degrades card rows to the time fallback.
    expect(failedMembership).toMatchObject({ lastReadEventId: "evt_cached", lastReadSequence: "77" })
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
          lastReadEventId: "evt_terminal",
          lastReadAt: null,
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
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: new Date().toISOString(),
        },
        {
          streamId: "stream_muted",
          memberId: "user_1",
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
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
              lastReadEventId: null,
              lastReadAt: null,
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
              lastReadEventId: null,
              lastReadAt: null,
              joinedAt: new Date().toISOString(),
            },
          }),
        ],
      ]),
      staleStreamIds: new Set(),
      terminalStreamIds: new Set(),
      localStreams: [],
      localMemberships: [],
    })

    expect(merged.mutedStreamIds).not.toContain("stream_unmuted")
    expect(merged.mutedStreamIds).toContain("stream_muted")
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
    await Promise.all([db.streams.clear(), db.streamMemberships.clear(), db.dmPeers.clear(), db.unreadState.clear()])
  })

  const handlerRefs = {
    getCurrentStreamId: () => undefined,
    getCurrentUser: () => ({ id: "workos_1" }),
    subscribeStream: vi.fn(),
  }

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

  it("applies a stream:read_messages snapshot to the overlay, counter, and watermark", async () => {
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
      const membership = await db.streamMemberships.get("ws_1:stream_1")
      expect(membership?.lastReadSequence).toBe("40")
      expect(membership?.lastReadEventId).toBe("evt_4")
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
      lastReadEventId: null,
      lastReadAt: null,
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
      lastReadEventId: null,
      lastReadAt: null,
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

  it("invalidates the memo search queries when a memo:created event lands", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("memo:created", { workspaceId: "ws_1", memoId: "memo_1" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: memoKeys.searches("ws_1") })
    cleanup()
  })

  it("ignores memo:created events from other workspaces", () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { socket, emit } = createTestSocket()
    const cleanup = registerWorkspaceSocketHandlers(socket, "ws_1", queryClient, handlerRefs)

    emit("memo:created", { workspaceId: "ws_other", memoId: "memo_1" })

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
            lastReadEventId: "event_old",
            lastReadAt: null,
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
      lastReadEventId: "event_old",
      _cachedAt: Date.now(),
    })
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_old",
      lastReadAt: null,
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
    })

    await Promise.resolve()

    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({
      lastReadEventId: "event_new",
    })
    expect(await db.streams.get("stream_1")).toMatchObject({
      lastReadEventId: "event_new",
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
      lastReadEventId: null,
      lastReadAt: null,
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

  it("pins the read position to latest while viewing the stream attentively", async () => {
    const focusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true)
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

    expect(queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))?.unreadCounts.stream_1).toBe(0)
    await vi.waitFor(async () => {
      expect((await db.unreadState.get("ws_1"))?.unreadCounts.stream_1).toBe(0)
    })

    cleanup()
    focusSpy.mockRestore()
  })

  it("does NOT pin while the viewed stream's window is unfocused — unread rises like any other stream", async () => {
    // The pin is optimistic against the auto-read confirm, which only fires
    // when attentive (useAutoReadAttention). Pinning here would zero the local
    // count with no server confirm coming — the sticky-zero divergence bug.
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

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(0)
    expect(bootstrap?.activityCounts).toEqual({})
    expect(bootstrap?.unreadActivityCount).toBe(0)

    await vi.waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadCounts.stream_1).toBe(0)
      expect(state?.unreadActivityCount).toBe(0)
    })

    cleanup()
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
})

describe("latest ordinal seeding and reconnect merge (sync phase 2c)", () => {
  beforeEach(async () => {
    await db.unreadState.clear()
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

    const effective = await applyWorkspaceBootstrap(
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
})
