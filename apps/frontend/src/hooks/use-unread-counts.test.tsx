import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_WORKSPACE_SETTINGS,
  defaultFeatureFlags,
  type StreamMember,
  type WorkspaceBootstrap,
} from "@threa/types"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "@/lib/sw-messages"
import { workspaceKeys } from "./use-workspaces"
import { useUnreadCounts } from "./use-unread-counts"

const mockMarkAsRead = vi.fn<(workspaceId: string, streamId: string, lastEventId: string) => Promise<StreamMember>>()
const mockPostMessage = vi.fn()
const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")

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
    labels: [],
    labelAssignments: [],
    viewerPermissions: [],
    sidebarConfig: DEFAULT_SIDEBAR_CONFIG,
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
      labelRemoveOnMove: "ask",
      unreadOpenPosition: "latest",
      scratchpadCustomPrompt: null,
      codeBlockCollapseThreshold: 10,
      blockquoteCollapseThreshold: 6,
      messageCollapseEnabled: false,
      messageCollapseAtHeight: 420,
      messageCollapseToHeight: 240,
      messageCollapseThreshold: 16,
      boardCardCollapseEnabled: false,
      boardCardCollapseAtHeight: 600,
      boardCardCollapseToHeight: 320,
      boardCardCollapseThreshold: 600,
      boardDefaultLens: "all",
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      voiceSteeringWords: [],
      statusPresets: [],
      workSchedule: null,
      gettingStartedDismissed: false,
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
    featureFlags: defaultFeatureFlags(),
    workspaceSettings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      workspaceId: "ws_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

describe("useUnreadCounts", () => {
  beforeEach(async () => {
    mockMarkAsRead.mockReset()
    mockPostMessage.mockReset()
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { controller: { postMessage: mockPostMessage } },
    })
    await clearAllCachedData()
  })

  afterEach(() => {
    if (originalServiceWorker) {
      Object.defineProperty(navigator, "serviceWorker", originalServiceWorker)
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker")
    }
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
      unreadActivities: [],
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    mockMarkAsRead.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
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
    expect(bootstrap?.unreadCounts.stream_1).toBe(0)
  })

  it("advances the read pointer but keeps the unread badge on a partial read", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())

    await db.unreadState.put({
      id: "ws_1",
      workspaceId: "ws_1",
      unreadCounts: { stream_1: 2 },
      mentionCounts: { stream_1: 0 },
      activityCounts: { stream_1: 0 },
      unreadActivityCount: 0,
      unreadActivities: [],
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    mockMarkAsRead.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_mid",
      lastReadAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    })

    const { result } = renderHook(() => useUnreadCounts("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    act(() => {
      result.current.markAsRead("stream_1", "event_mid", { partial: true })
    })

    await waitFor(() => {
      const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
      expect(
        bootstrap?.streamMemberships.find((membership) => membership.streamId === "stream_1")?.lastReadEventId
      ).toBe("event_mid")
    })

    // Pointer advanced, but the badge is untouched — the server `stream:read`
    // round-trip owns the true remaining count (no sticky optimistic zero).
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.unreadCounts.stream_1).toBe(2)
    expect(await db.unreadState.get("ws_1")).toMatchObject({ unreadCounts: { stream_1: 2 } })
  })

  it("skips an optimistic temp_ read pointer but still sends a confirmed event id", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())

    mockMarkAsRead.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_new",
      lastReadAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    })

    const { result } = renderHook(() => useUnreadCounts("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    // A temp_ id is an unconfirmed optimistic event with no server stream_events
    // row; persisting it would pin the watermark to sequence 0 and report the whole
    // stream — including the user's own messages — as unread. The mutation is skipped.
    act(() => {
      result.current.markAsRead("stream_1", "temp_optimistic")
    })
    expect(mockMarkAsRead).not.toHaveBeenCalled()
    // No read advanced, so no notification is dismissed for the optimistic id.
    expect(mockPostMessage).not.toHaveBeenCalled()

    // The real event id (after the server echo swaps it in) is sent normally.
    act(() => {
      result.current.markAsRead("stream_1", "event_new")
    })
    await waitFor(() => expect(mockMarkAsRead).toHaveBeenCalledWith("ws_1", "stream_1", "event_new"))
  })

  it("dismisses the stream's push notification when advancing the read pointer", async () => {
    // Centralized clear: every read-advance funnels through markAsRead (auto-read,
    // manual "Mark as read", Escape), so reading a stream dismisses its push banner
    // locally on this device — not just on the auto-read path.
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())

    mockMarkAsRead.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
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

    expect(mockPostMessage).toHaveBeenCalledWith({ type: SW_MSG_CLEAR_NOTIFICATIONS, streamId: "stream_1" })
  })
})
