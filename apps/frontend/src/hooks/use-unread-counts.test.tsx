import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import type { StreamMember, WorkspaceBootstrap } from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { useUnreadCounts } from "./use-unread-counts"

const mockMarkAsRead = vi.fn<(workspaceId: string, streamId: string, lastEventId: string) => Promise<StreamMember>>()

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: {
          streams: {
            markAsRead: mockMarkAsRead,
          } as unknown as StreamService,
        },
        children,
      })
    )
  }
}

function makeBootstrap(): WorkspaceBootstrap {
  return {
    workspace: {
      id: "ws_1",
      name: "Workspace",
      slug: "workspace",
      createdBy: "member_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    users: [],
    streams: [],
    streamMemberships: [
      {
        streamId: "stream_1",
        memberId: "member_1",
        pinned: false,
        pinnedAt: null,
        notificationLevel: "everything",
        lastReadEventId: "event_old",
        lastReadAt: null,
        joinedAt: new Date().toISOString(),
      },
    ],
    dmPeers: [],
    personas: [],
    bots: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: { stream_1: 2 },
    mentionCounts: { stream_1: 0 },
    activityCounts: { stream_1: 0 },
    unreadActivityCount: 0,
    mutedStreamIds: [],
    viewerPermissions: [],
    userPreferences: {
      workspaceId: "ws_1",
      userId: "member_1",
      theme: "system",
      messageSendMode: "enter",
      messageDisplay: "comfortable",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24h",
      timezone: "UTC",
      language: "en",
      notificationLevel: "all",
      sidebarCollapsed: false,
      linkPreviewDefault: "open",
      scratchpadCustomPrompt: null,
      codeBlockCollapseThreshold: 10,
      blockquoteCollapseThreshold: 6,
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      accessibility: {
        fontSize: "medium",
        fontFamily: "system",
        reducedMotion: false,
        highContrast: false,
      },
      keyboardShortcuts: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

describe("useUnreadCounts", () => {
  beforeEach(async () => {
    mockMarkAsRead.mockReset()
    await clearAllCachedData()
  })

  it("updates the membership read pointer in IndexedDB when marking a stream as read", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())

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
      pinned: false,
      pinnedAt: null,
      notificationLevel: "everything",
      lastReadEventId: "event_old",
      lastReadAt: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })
    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 2 },
      mentionCounts: { stream_1: 0 },
      activityCounts: { stream_1: 0 },
      unreadActivityCount: 0,
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    mockMarkAsRead.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      pinned: false,
      pinnedAt: null,
      notificationLevel: "everything",
      lastReadEventId: "event_new",
      lastReadAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    })

    const { result } = renderHook(() => useUnreadCounts("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    act(() => {
      result.current.markAsRead("stream_1", "event_new")
    })

    await waitFor(async () => {
      await expect(db.streamMemberships.get("ws_1:stream_1")).resolves.toMatchObject({
        lastReadEventId: "event_new",
      })
    })

    expect(await db.streams.get("stream_1")).toMatchObject({ lastReadEventId: "event_new" })
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamMemberships.find((membership) => membership.streamId === "stream_1")?.lastReadEventId).toBe(
      "event_new"
    )
  })
})
