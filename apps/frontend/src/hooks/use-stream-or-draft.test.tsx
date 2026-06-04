import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, act, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type MessageService, type StreamService } from "@/contexts"
import { PendingMessagesProvider } from "@/contexts/pending-messages-context"
import { clearAllCachedData, db } from "@/db"
import { AuthContext } from "@/auth/context"
import { streamKeys } from "./use-streams"
import { seedWorkspaceCache } from "@/stores/workspace-store"
import { SyncEngineContext } from "@/sync/sync-engine"
import { workspaceKeys } from "./use-workspaces"
import { useStreamOrDraft } from "./use-stream-or-draft"

function createWrapper(
  queryClient: QueryClient,
  options?: {
    streamService?: Partial<StreamService>
    messageService?: Partial<MessageService>
    syncEngine?: { subscribeStream: ReturnType<typeof vi.fn> }
  }
) {
  const streamService = options?.streamService ?? ({} as Partial<StreamService>)
  const messageService = options?.messageService ?? ({} as Partial<MessageService>)
  const syncEngine = options?.syncEngine ?? { subscribeStream: vi.fn() }

  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      undefined,
      createElement(
        SyncEngineContext.Provider,
        { value: syncEngine as never },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(ServicesProvider, {
            services: {
              streams: streamService as StreamService,
              messages: messageService as MessageService,
            },
            children: createElement(
              AuthContext.Provider,
              {
                value: {
                  user: { id: "workos_1", email: "kris@example.com", name: "Kris" },
                  loading: false,
                  error: null,
                  login: vi.fn(),
                  logout: vi.fn(),
                  refetch: vi.fn(),
                },
              },
              createElement(PendingMessagesProvider, undefined, children)
            ),
          })
        )
      )
    )
  }
}

describe("useStreamOrDraft real stream send", () => {
  beforeEach(async () => {
    await clearAllCachedData()
  })

  it("queues the optimistic event in IndexedDB without mutating an empty bootstrap window", async () => {
    const createdAt = "2026-03-31T10:00:00Z"
    const stream = {
      id: "stream_socket_seen",
      workspaceId: "ws_1",
      type: "channel" as const,
      displayName: "Engineering",
      slug: "engineering",
      description: null,
      visibility: "public" as const,
      parentStreamId: null,
      parentMessageId: null,
      rootStreamId: null,
      companionMode: "off" as const,
      companionPersonaId: null,
      createdBy: "member_1",
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      lastMessagePreview: null,
    }

    seedWorkspaceCache("ws_1", {
      workspace: {
        id: "ws_1",
        name: "Workspace",
        slug: "workspace",
        createdAt,
        updatedAt: createdAt,
        _cachedAt: Date.now(),
      },
      users: [
        {
          id: "member_1",
          workspaceId: "ws_1",
          workosUserId: "workos_1",
          email: "kris@example.com",
          role: "owner",
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
          setupCompleted: true,
          joinedAt: createdAt,
          _cachedAt: Date.now(),
        },
      ],
      streams: [{ ...stream, _cachedAt: Date.now() }],
      memberships: [
        {
          id: "ws_1:stream_socket_seen",
          workspaceId: "ws_1",
          streamId: "stream_socket_seen",
          memberId: "member_1",
          pinned: false,
          pinnedAt: null,
          notificationLevel: null,
          lastReadEventId: null,
          lastReadAt: null,
          joinedAt: createdAt,
          _cachedAt: Date.now(),
        },
      ],
      dmPeers: [],
      personas: [],
      bots: [],
      unreadState: {
        id: "ws_1",
        workspaceId: "ws_1",
        unreadCounts: {},
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        mutedStreamIds: [],
        _cachedAt: Date.now(),
      },
      userPreferences: {
        id: "ws_1",
        workspaceId: "ws_1",
        userId: "member_1",
        theme: "system",
        sendMode: "enter",
        _cachedAt: Date.now(),
      },
      metadata: {
        id: "ws_1",
        workspaceId: "ws_1",
        emojis: [],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      },
    })

    const queryClient = new QueryClient()
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", "stream_socket_seen"), {
      stream,
      events: [],
      members: [],
      botMemberIds: [],
      membership: null,
      latestSequence: "0",
    })

    const { result } = renderHook(() => useStreamOrDraft("ws_1", "stream_socket_seen"), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(result.current.stream?.id).toBe("stream_socket_seen")
    })

    await act(async () => {
      await result.current.sendMessage({
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
        },
      })
    })

    const bootstrap = queryClient.getQueryData<{
      events: Array<{ id: string; sequence: string }>
    }>(streamKeys.bootstrap("ws_1", "stream_socket_seen"))
    expect(bootstrap?.events).toEqual([])

    const pendingMessages = await db.pendingMessages.toArray()
    expect(pendingMessages).toHaveLength(1)
    expect(pendingMessages[0]).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_socket_seen",
      content: "hello",
    })

    const queuedEvents = await db.events.toArray()
    expect(queuedEvents).toHaveLength(1)
    expect(queuedEvents[0]).toMatchObject({
      streamId: "stream_socket_seen",
      actorId: "member_1",
      eventType: "message_created",
      _status: "pending",
    })
  })
})

describe("useStreamOrDraft draft DM send", () => {
  beforeEach(async () => {
    await clearAllCachedData()
  })

  it("persists the created DM to IndexedDB so the sidebar can switch from the virtual draft immediately", async () => {
    const createdAt = "2026-03-31T12:00:00Z"
    const queryClient = new QueryClient()
    const subscribeStream = vi.fn()
    const createDm = vi.fn().mockResolvedValue({
      id: "msg_dm_1",
      streamId: "stream_dm_1",
      sequence: "1",
      authorId: "member_1",
      authorType: "user",
      contentJson: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
      },
      contentMarkdown: "hello",
      replyCount: 0,
      sentVia: null,
      reactions: {},
      metadata: {},
      editedAt: null,
      deletedAt: null,
      createdAt,
    })

    seedWorkspaceCache("ws_1", {
      workspace: {
        id: "ws_1",
        name: "Workspace",
        slug: "workspace",
        createdAt,
        updatedAt: createdAt,
        _cachedAt: Date.now(),
      },
      users: [
        {
          id: "member_1",
          workspaceId: "ws_1",
          workosUserId: "workos_1",
          email: "kris@example.com",
          role: "owner",
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
          setupCompleted: true,
          joinedAt: createdAt,
          _cachedAt: Date.now(),
        },
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
          setupCompleted: true,
          joinedAt: createdAt,
          _cachedAt: Date.now(),
        },
      ],
      streams: [],
      memberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
      unreadState: {
        id: "ws_1",
        workspaceId: "ws_1",
        unreadCounts: {},
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        mutedStreamIds: [],
        _cachedAt: Date.now(),
      },
      userPreferences: {
        id: "ws_1",
        workspaceId: "ws_1",
        userId: "member_1",
        theme: "system",
        sendMode: "enter",
        _cachedAt: Date.now(),
      },
      metadata: {
        id: "ws_1",
        workspaceId: "ws_1",
        emojis: [],
        emojiWeights: {},
        commands: [],
        _cachedAt: Date.now(),
      },
    })

    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      workspace: { id: "ws_1", name: "Workspace", slug: "workspace", createdAt, updatedAt: createdAt },
      users: [],
      streams: [],
      streamMemberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
      unreadState: {
        unreadCounts: {},
        mentionCounts: {},
        activityCounts: {},
        unreadActivityCount: 0,
        mutedStreamIds: [],
      },
      userPreferences: null,
      metadata: null,
    })

    const { result } = renderHook(() => useStreamOrDraft("ws_1", "draft_dm_member_2"), {
      wrapper: createWrapper(queryClient, {
        messageService: { createDm },
        syncEngine: { subscribeStream },
      }),
    })

    await waitFor(() => {
      expect(result.current.stream?.id).toBe("draft_dm_member_2")
    })

    await act(async () => {
      const sendResult = await result.current.sendMessage({
        contentJson: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hello" }] }],
        },
      })

      expect(sendResult).toEqual({
        navigateTo: "/w/ws_1/s/stream_dm_1",
        replace: true,
      })
    })

    expect(await db.streams.get("stream_dm_1")).toMatchObject({
      id: "stream_dm_1",
      workspaceId: "ws_1",
      type: "dm",
      displayName: "Invitee",
      lastMessagePreview: {
        authorId: "member_1",
        authorType: "user",
        content: "hello",
        createdAt,
      },
    })
    expect(await db.streamMemberships.get("ws_1:stream_dm_1")).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_dm_1",
      memberId: "member_1",
    })
    expect(await db.dmPeers.get("ws_1:stream_dm_1")).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_dm_1",
      userId: "member_2",
    })
    expect(subscribeStream).toHaveBeenCalledWith("stream_dm_1")

    const bootstrap = queryClient.getQueryData<{
      streams: Array<{ id: string; displayName: string | null }>
      streamMemberships: Array<{ streamId: string }>
      dmPeers: Array<{ streamId: string; userId: string }>
    }>(workspaceKeys.bootstrap("ws_1"))

    expect(bootstrap?.streams).toContainEqual(expect.objectContaining({ id: "stream_dm_1", displayName: "Invitee" }))
    expect(bootstrap?.streamMemberships).toContainEqual(expect.objectContaining({ streamId: "stream_dm_1" }))
    expect(bootstrap?.dmPeers).toContainEqual(expect.objectContaining({ streamId: "stream_dm_1", userId: "member_2" }))
  })
})
