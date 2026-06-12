import { describe, it, expect, beforeEach, vi } from "vitest"
import { db } from "@/db"
import { QueryClient } from "@tanstack/react-query"
import { workspaceKeys } from "@/hooks/use-workspaces"
import {
  applyWorkspaceBootstrap,
  mergeReconnectWorkspaceBootstrap,
  registerWorkspaceSocketHandlers,
} from "./workspace-sync"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_QUICK_LINKS,
  SIDEBAR_CONFIG_VERSION,
  defaultFeatureFlags,
  type StreamBootstrap,
  type WorkspaceBootstrap,
} from "@threa/types"
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
    labelMemberships: [],
    labelAssignments: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    mutedStreamIds: [],
    featureFlags: defaultFeatureFlags(),
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
      parentMessageId: null,
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
      parentMessageId: null,
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
          parentMessageId: null,
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
      parentMessageId: null,
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
      parentMessageId: null,
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
          parentMessageId: null,
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
    expect(merged.mentionCounts.stream_visible).toBe(1)
    expect(merged.activityCounts.stream_visible).toBe(1)
    expect(merged.unreadActivityCount).toBe(1)
    expect(
      merged.streamMemberships.find((membership) => membership.streamId === "stream_visible")?.lastReadEventId
    ).toBe("evt_new")
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
          parentMessageId: null,
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
        mutedStreamIds: ["stream_failed"],
        _cachedAt: Date.now(),
      },
    })

    expect(merged.streams.map((stream) => stream.id)).toContain("stream_failed")
    expect(
      merged.streamMemberships.find((membership) => membership.streamId === "stream_failed")?.lastReadEventId
    ).toBe("evt_cached")
    expect(merged.unreadCounts.stream_failed).toBe(3)
    expect(merged.mentionCounts.stream_failed).toBe(1)
    expect(merged.activityCounts.stream_failed).toBe(2)
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
          parentMessageId: null,
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
          parentMessageId: null,
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
          parentMessageId: null,
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
        parentMessageId: null,
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
        parentMessageId: null,
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
        parentMessageId: null,
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
            parentMessageId: null,
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
      parentMessageId: null,
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
})
