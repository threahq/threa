import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, act } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import type { CreateStreamInput } from "@/api"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_WORKSPACE_SETTINGS,
  type Stream,
  type StreamMember,
  type WorkspaceBootstrap,
} from "@threa/types"
import { workspaceKeys } from "./use-workspaces"
import { useCreateStream, usePinStream } from "./use-streams"
import * as syncEngineModule from "@/sync/sync-engine"

const mockCreate = vi.fn<(workspaceId: string, data: CreateStreamInput) => Promise<Stream>>()
const mockPin = vi.fn<(workspaceId: string, streamId: string, pinned: boolean) => Promise<StreamMember>>()
const mockSubscribeStream = vi.fn<(streamId: string) => Promise<void>>()

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: {
          streams: {
            create: mockCreate,
            pin: mockPin,
          } as unknown as StreamService,
        },
        children,
      })
    )
  }
}

function makeWorkspaceBootstrap(): WorkspaceBootstrap {
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
    streamMemberships: [],
    dmPeers: [],
    personas: [],
    bots: [],
    emojis: [],
    emojiWeights: {},
    commands: [],
    unreadCounts: {},
    mentionCounts: {},
    activityCounts: {},
    unreadActivityCount: 0,
    mutedStreamIds: [],
    labels: [],
    labelMemberships: [],
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
      scratchpadCustomPrompt: null,
      codeBlockCollapseThreshold: 10,
      blockquoteCollapseThreshold: 6,
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      workSchedule: null,
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
    workspaceSettings: {
      ...DEFAULT_WORKSPACE_SETTINGS,
      workspaceId: "ws_1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

describe("useCreateStream", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    mockCreate.mockReset()
    mockSubscribeStream.mockReset()
    vi.spyOn(syncEngineModule, "useSyncEngine").mockReturnValue({
      subscribeStream: mockSubscribeStream,
    } as unknown as ReturnType<typeof syncEngineModule.useSyncEngine>)
    await clearAllCachedData()
  })

  it("persists the creator membership to IndexedDB and subscribes immediately", async () => {
    const queryClient = new QueryClient()
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), makeWorkspaceBootstrap())

    const createdAt = new Date().toISOString()
    mockCreate.mockResolvedValue({
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
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
    })

    const { result } = renderHook(() => useCreateStream("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    await act(async () => {
      await result.current.mutateAsync({
        type: "channel",
        slug: "engineering",
        visibility: "public",
      })
    })

    expect(mockSubscribeStream).toHaveBeenCalledWith("stream_new")
    expect(await db.streams.get("stream_new")).toBeDefined()
    expect(await db.streamMemberships.get("ws_1:stream_new")).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_new",
      memberId: "member_1",
    })

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streams.map((stream) => stream.id)).toEqual(["stream_new"])
    expect(bootstrap?.streamMemberships.map((membership) => membership.streamId)).toEqual(["stream_new"])
  })
})

describe("usePinStream", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    mockPin.mockReset()
    await clearAllCachedData()
  })

  async function seedMembership(pinned: boolean) {
    await db.streamMemberships.put({
      id: "ws_1:stream_1",
      workspaceId: "ws_1",
      streamId: "stream_1",
      memberId: "member_1",
      pinned,
      pinnedAt: pinned ? new Date().toISOString() : null,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: new Date().toISOString(),
      _cachedAt: Date.now(),
    })
  }

  it("writes the pin to IndexedDB and reconciles the server pinnedAt", async () => {
    await seedMembership(false)
    const serverPinnedAt = "2026-04-05T12:00:00.000Z"
    mockPin.mockResolvedValue({
      streamId: "stream_1",
      memberId: "member_1",
      pinned: true,
      pinnedAt: serverPinnedAt,
      notificationLevel: null,
      lastReadEventId: null,
      lastReadAt: null,
      joinedAt: new Date(),
    } as unknown as StreamMember)

    const queryClient = new QueryClient()
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
      ...makeWorkspaceBootstrap(),
      streamMemberships: [{ streamId: "stream_1", pinned: false, pinnedAt: null } as unknown as StreamMember],
    })

    const { result } = renderHook(() => usePinStream("ws_1"), { wrapper: createWrapper(queryClient) })

    await act(async () => {
      await result.current.mutateAsync({ streamId: "stream_1", pinned: true })
    })

    expect(mockPin).toHaveBeenCalledWith("ws_1", "stream_1", true)
    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ pinned: true, pinnedAt: serverPinnedAt })

    const bootstrap = queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap("ws_1"))
    expect(bootstrap?.streamMemberships[0]).toMatchObject({ pinned: true, pinnedAt: serverPinnedAt })
  })

  it("reverts the optimistic IndexedDB write when the request fails", async () => {
    await seedMembership(false)
    mockPin.mockRejectedValue(new Error("network"))

    const queryClient = new QueryClient()
    const { result } = renderHook(() => usePinStream("ws_1"), { wrapper: createWrapper(queryClient) })

    await act(async () => {
      await expect(result.current.mutateAsync({ streamId: "stream_1", pinned: true })).rejects.toThrow("network")
    })

    expect(await db.streamMemberships.get("ws_1:stream_1")).toMatchObject({ pinned: false, pinnedAt: null })
  })
})
