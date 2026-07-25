import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_WORKSPACE_SETTINGS,
  type Activity,
  type StreamMember,
  type WorkspaceBootstrap,
} from "@threa/types"
import { SW_MSG_CLEAR_NOTIFICATIONS } from "@/lib/sw-messages"
import { workspaceKeys } from "./use-workspaces"
import { useUnreadCounts } from "./use-unread-counts"

const mockMarkAsRead =
  vi.fn<(workspaceId: string, streamId: string, lastEventId: string) => Promise<StreamMember | null>>()
const mockMarkUnread =
  vi.fn<(workspaceId: string, streamId: string, messageId: string) => Promise<StreamMember | null>>()
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
            markUnread: mockMarkUnread,
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
      boardDefaultViewId: null,
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      voiceSteeringWords: [],
      statusPresets: [],
      workSchedule: null,
      defaultCompanionPersonaId: null,
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
    featureFlags: { workspace: {}, user: {} },
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
    mockMarkUnread.mockReset()
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

  it("clears activity without touching membership state when the read returns a null membership", async () => {
    // A viewer with inherited access but no membership row (INV-62: non-member
    // thread leg) gets an activity-only read: the server returns 200 with a
    // null membership. The held activity rows must clear, and no membership-
    // shaped write may happen (spreading null would junk the IDB row).
    const activity = (id: string, streamId: string): Activity => ({
      id,
      workspaceId: "ws_1",
      userId: "member_1",
      activityType: "message",
      streamId,
      messageId: `msg_${id}`,
      actorId: "persona_system_ariadne",
      actorType: "persona",
      context: {},
      readAt: null,
      createdAt: new Date().toISOString(),
      isSelf: false,
      emoji: null,
    })

    const queryClient = new QueryClient()
    const bootstrap = makeBootstrap()
    bootstrap.unreadActivities = [
      activity("act_1", "stream_thread"),
      activity("act_2", "stream_thread"),
      activity("act_3", "stream_2"),
    ]
    bootstrap.activityCounts = { stream_thread: 2, stream_2: 1 }
    bootstrap.unreadActivityCount = 3
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), bootstrap)

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
      unreadCounts: {},
      mentionCounts: {},
      activityCounts: { stream_thread: 2, stream_2: 1 },
      unreadActivityCount: 3,
      unreadActivities: [
        activity("act_1", "stream_thread"),
        activity("act_2", "stream_thread"),
        activity("act_3", "stream_2"),
      ],
      mutedStreamIds: [],
      _cachedAt: Date.now(),
    })

    mockMarkAsRead.mockResolvedValue(null)

    const { result } = renderHook(() => useUnreadCounts("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    act(() => {
      result.current.markAsRead("stream_thread", "event_new")
    })

    await waitFor(async () => {
      const state = await db.unreadState.get("ws_1")
      expect(state?.unreadActivities?.map((a) => a.id)).toEqual(["act_3"])
    })

    // No membership row created, no stream row touched, and unrelated
    // memberships stay put — but the standalone frontier DOES move: non-member
    // unlocks get the same optimistic divider advance as members.
    expect(await db.streamMemberships.get("ws_1:stream_thread")).toBeUndefined()
    expect(await db.streams.get("stream_thread")).toBeUndefined()
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "event_old" })
    expect(await db.streamReadState.get("ws_1:stream_thread")).toMatchObject({
      streamId: "stream_thread",
      lastReadEventId: "event_new",
    })

    const updated = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(updated?.unreadActivities?.map((a) => a.id)).toEqual(["act_3"])
    expect(updated?.activityCounts).toEqual({ stream_2: 1 })
    expect(updated?.unreadActivityCount).toBe(1)
    expect(updated?.streamMemberships.find((m) => m.streamId === "stream_1")?.lastReadEventId).toBe("event_old")
    expect(updated?.streamReadState?.stream_thread?.lastReadEventId).toBe("event_new")
  })

  it("markUnread with a membership mirrors the pointer into the membership row and the standalone frontier", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())
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

    mockMarkUnread.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_prev",
      lastReadAt: "2026-07-24T00:00:00.000Z",
      joinedAt: new Date().toISOString(),
    })

    const { result } = renderHook(() => useUnreadCounts("ws_1"), { wrapper: createWrapper(queryClient) })
    act(() => {
      result.current.markUnread("stream_1", "msg_target")
    })

    await waitFor(async () => {
      expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "event_prev" })
    })
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "event_prev" })
  })

  it("markUnread with a null membership writes nothing optimistically — the stream:read_set echo owns the frontier", async () => {
    // A non-member's unread succeeds with a null membership; the response
    // carries no watermark, so the optimistic path must not fabricate
    // membership-shaped rows — the echo SETs the standalone frontier.
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())

    mockMarkUnread.mockResolvedValue(null)

    const { result } = renderHook(() => useUnreadCounts("ws_1"), { wrapper: createWrapper(queryClient) })
    act(() => {
      result.current.markUnread("stream_thread", "msg_target")
    })

    await waitFor(() => expect(mockMarkUnread).toHaveBeenCalledWith("ws_1", "stream_thread", "msg_target"))
    expect(await db.streamMemberships.get("ws_1:stream_thread")).toBeUndefined()
    expect(await db.streamReadState.get("ws_1:stream_thread")).toBeUndefined()
  })

  // Ordering guard: the mutation captures its departure time; a read-state
  // write that lands while the request is in flight (the request's own socket
  // echo, or a LATER action) owns the stream, so the stale HTTP success is a
  // no-op. An old read must not erase a later explicit unread, and vice versa.
  function memberResponse(lastReadEventId: string): StreamMember {
    return {
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId,
      lastReadAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
    }
  }

  it("a delayed markAsRead success is a no-op when a later explicit unread touched the stream mid-flight", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_old",
      lastReadAt: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now() - 5000,
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
      _cachedAt: Date.now() - 5000,
    })

    let resolveRead!: (membership: StreamMember | null) => void
    mockMarkAsRead.mockReturnValue(new Promise((resolve) => (resolveRead = resolve)))

    const { result } = renderHook(() => useUnreadCounts("ws_1"), { wrapper: createWrapper(queryClient) })
    act(() => {
      result.current.markAsRead("stream_1", "evt_100")
    })
    await waitFor(() => expect(mockMarkAsRead).toHaveBeenCalledWith("ws_1", "stream_1", "evt_100"))

    // A LATER explicit unread lands while the read is in flight: its
    // stream:read_set echo SETs frontier + mirror back to evt_50 and stamps
    // the touched time.
    const touchedAt = Date.now()
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_50",
      lastReadSequence: "50",
      lastReadAt: new Date().toISOString(),
      _cachedAt: touchedAt,
    })
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "evt_50",
      lastReadAt: new Date().toISOString(),
      joinedAt: new Date().toISOString(),
      _cachedAt: touchedAt,
    })

    // The stale read response finally resolves — it must NOT restore evt_100.
    await act(async () => {
      resolveRead(memberResponse("evt_100"))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "evt_50" })
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "evt_50" })
    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    // The stale success wrote nothing: the cache still carries the seeded
    // mirror (not evt_100) and a full read would have zeroed the badge.
    expect(bootstrap?.streamMemberships.find((m) => m.streamId === "stream_1")?.lastReadEventId).toBe("event_old")
    expect(bootstrap?.unreadCounts.stream_1).toBe(2)
  })

  it("a delayed markUnread success is a no-op when a later read touched the stream mid-flight", async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeBootstrap())
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      notificationLevel: "everything",
      lastReadEventId: "event_old",
      lastReadAt: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now() - 5000,
    })

    let resolveUnread!: (membership: StreamMember | null) => void
    mockMarkUnread.mockReturnValue(new Promise((resolve) => (resolveUnread = resolve)))

    const { result } = renderHook(() => useUnreadCounts("ws_1"), { wrapper: createWrapper(queryClient) })
    act(() => {
      result.current.markUnread("stream_1", "msg_target")
    })
    await waitFor(() => expect(mockMarkUnread).toHaveBeenCalledWith("ws_1", "stream_1", "msg_target"))

    // A LATER read lands while the unread is in flight: its stream:read echo
    // advances the frontier to evt_150 and stamps the touched time.
    await db.streamReadState.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      lastReadEventId: "evt_150",
      lastReadSequence: "150",
      lastReadAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })

    // The stale unread response resolves — it must NOT regress the frontier.
    await act(async () => {
      resolveUnread(memberResponse("evt_50"))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(await db.streamReadState.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "evt_150" })
    // The stale success wrote nothing: the mirror keeps its seeded value.
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ lastReadEventId: "event_old" })
  })
})
