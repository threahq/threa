import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, act, waitFor } from "@testing-library/react"
import { createMockStream } from "@/test/fixtures"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ServicesProvider, type StreamService } from "@/contexts"
import { clearAllCachedData, db } from "@/db"
import type { CreateStreamInput } from "@/api"
import {
  DEFAULT_SIDEBAR_CONFIG,
  DEFAULT_WORKSPACE_SETTINGS,
  type Stream,
  type WorkspaceBootstrap,
} from "@threahq/types"
import { workspaceKeys } from "./use-workspaces"
import { streamKeys, useCreateStream, useUnarchiveStream } from "./use-streams"
import * as syncEngineModule from "@/sync/sync-engine"
import { seedWorkspaceCache } from "@/stores/workspace-store"

const mockCreate = vi.fn<(workspaceId: string, data: CreateStreamInput) => Promise<Stream>>()
const mockUnarchive = vi.fn<(workspaceId: string, streamId: string) => Promise<void>>()
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
            unarchive: mockUnarchive,
          } as unknown as StreamService,
        },
        children,
      })
    )
  }
}

function makeWorkspaceBootstrap(): WorkspaceBootstrap {
  return {
    analytics: null,
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
      mobileInlineAttachments: true,
      linkPreviewDefault: "open",
      labelRemoveOnMove: "ask",
      unreadOpenPosition: "latest",
      inboxClearMode: "interaction",
      pushActions: ["mark_read", "remind"],
      pushReminderMinutes: 5,
      pushQuickReaction: "👍",
      scratchpadCustomPrompt: null,
      codeBlockCollapseThreshold: 10,
      blockquoteCollapseThreshold: 6,
      codeBlockWrap: "scroll",
      codeBlockWrapOverrides: {},
      messageCollapseEnabled: false,
      messageCollapseAtHeight: 420,
      messageCollapseToHeight: 240,
      messageCollapseThreshold: 16,
      boardCardCollapseEnabled: false,
      boardCardCollapseAtHeight: 600,
      boardCardCollapseToHeight: 320,
      boardCardCollapseThreshold: 600,
      boardFullTailCount: 1,
      boardLedgerRows: 15,
      boardLeadLineLength: 110,
      boardMassBadge: "count",
      boardDefaultLens: "all",
      boardDefaultViewId: null,
      voiceTranscriptionModel: null,
      voicePolishLevel: "opinionated",
      voiceSteeringWords: [],
      subagentModels: [],
      statusPresets: [],
      workSchedule: null,
      defaultCompanionPersonaId: null,
      gettingStartedDismissed: false,
      performanceDiagnosticsOptIn: false,
      analyticsConsent: "unset",
      sessionReplayOptIn: false,
      accessibility: {
        fontSize: "medium",
        fontFamily: "system",
        reducedMotion: false,
        highContrast: false,
        composerActionSide: "right",
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

describe("useUnarchiveStream", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    mockUnarchive.mockReset()
    await clearAllCachedData()
  })

  it("should restore the cached stream immediately when the server unarchives it", async () => {
    const stream = createMockStream({
      id: "stream_archived",
      type: "channel",
      workspaceId: "ws_1",
      createdBy: "member_1",
      archivedAt: "2026-03-01T00:00:00.000Z",
    })
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: Date.now() })
    const queryClient = new QueryClient()
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", stream.id), { stream })
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    mockUnarchive.mockResolvedValue(undefined)

    const { result } = renderHook(() => useUnarchiveStream("ws_1"), { wrapper: createWrapper(queryClient) })
    await act(async () => {
      await result.current.mutateAsync({ streamId: stream.id, archivedAt: stream.archivedAt! })
    })

    expect({
      bootstrapArchivedAt: (queryClient.getQueryData(streamKeys.bootstrap("ws_1", stream.id)) as { stream: Stream })
        .stream.archivedAt,
      persistedArchivedAt: (await db.streams.get(stream.id))?.archivedAt,
    }).toEqual({ bootstrapArchivedAt: null, persistedArchivedAt: null })
  })

  it("should unarchive the shown generation even when the workspace fallback cache is stale", async () => {
    const archivedAt = "2026-03-01T00:00:00.000Z"
    const stream = createMockStream({
      id: "stream_stale_workspace_cache",
      type: "channel",
      workspaceId: "ws_1",
      archivedAt,
    })
    const workspace = makeWorkspaceBootstrap().workspace
    seedWorkspaceCache("ws_1", {
      workspace: { ...workspace, _cachedAt: Date.now() },
      users: [],
      streams: [{ ...stream, archivedAt: null, lastMessagePreview: null, _cachedAt: Date.now() }],
      memberships: [],
      dmPeers: [],
      personas: [],
      bots: [],
    })
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: Date.now() })
    const queryClient = new QueryClient()
    const key = streamKeys.bootstrap("ws_1", stream.id)
    queryClient.setQueryData(key, { stream })
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    mockUnarchive.mockResolvedValue(undefined)

    const { result } = renderHook(() => useUnarchiveStream("ws_1"), { wrapper: createWrapper(queryClient) })
    await act(async () => {
      await result.current.mutateAsync({ streamId: stream.id, archivedAt })
    })

    expect({
      bootstrapArchivedAt: (queryClient.getQueryData(key) as { stream: Stream }).stream.archivedAt,
      persistedArchivedAt: (await db.streams.get(stream.id))?.archivedAt,
    }).toEqual({ bootstrapArchivedAt: null, persistedArchivedAt: null })
  })

  it("should start the unarchive request before reading IndexedDB", async () => {
    const stream = createMockStream({
      id: "stream_request_first",
      type: "channel",
      workspaceId: "ws_1",
      archivedAt: "2026-03-01T00:00:00.000Z",
    })
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: Date.now() })
    const queryClient = new QueryClient()
    queryClient.setQueryData(streamKeys.bootstrap("ws_1", stream.id), { stream })
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    const readCachedRow = vi.spyOn(db.streams, "get")
    mockUnarchive.mockImplementationOnce(async () => {
      expect(readCachedRow).not.toHaveBeenCalled()
    })

    const { result } = renderHook(() => useUnarchiveStream("ws_1"), { wrapper: createWrapper(queryClient) })
    await act(async () => {
      await result.current.mutateAsync({ streamId: stream.id, archivedAt: stream.archivedAt! })
    })

    expect(mockUnarchive).toHaveBeenCalledWith("ws_1", stream.id)
  })

  it("should keep a newer socket archive when it arrives before the unarchive response", async () => {
    const stream = createMockStream({
      id: "stream_archived_again",
      type: "channel",
      workspaceId: "ws_1",
      archivedAt: "2026-03-01T00:00:00.000Z",
    })
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: Date.now() })
    const queryClient = new QueryClient()
    const key = streamKeys.bootstrap("ws_1", stream.id)
    queryClient.setQueryData(key, { stream })
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    let completeUnarchive!: () => void
    mockUnarchive.mockImplementationOnce(() => new Promise<void>((resolve) => (completeUnarchive = resolve)))

    const { result } = renderHook(() => useUnarchiveStream("ws_1"), { wrapper: createWrapper(queryClient) })
    let mutation!: ReturnType<typeof result.current.mutateAsync>
    act(() => {
      mutation = result.current.mutateAsync({ streamId: stream.id, archivedAt: stream.archivedAt! })
    })
    await waitFor(() => expect(mockUnarchive).toHaveBeenCalled())
    const newerArchive = { ...stream, archivedAt: "2026-04-01T00:00:00.000Z", updatedAt: "2026-04-01T00:00:00.000Z" }
    act(() => queryClient.setQueryData(key, { stream: newerArchive }))
    await db.streams.update(stream.id, { archivedAt: newerArchive.archivedAt, updatedAt: newerArchive.updatedAt })
    await act(async () => {
      completeUnarchive()
      await mutation
    })

    expect({
      bootstrapArchivedAt: (queryClient.getQueryData(key) as { stream: Stream }).stream.archivedAt,
      persistedArchivedAt: (await db.streams.get(stream.id))?.archivedAt,
    }).toEqual({ bootstrapArchivedAt: newerArchive.archivedAt, persistedArchivedAt: newerArchive.archivedAt })
  })

  it("should restore the archive state while preserving unrelated updates during the request", async () => {
    const stream = createMockStream({
      id: "stream_updated_while_unarchiving",
      type: "channel",
      workspaceId: "ws_1",
      archivedAt: "2026-03-01T00:00:00.000Z",
    })
    await db.streams.put({ ...stream, lastMessagePreview: null, _cachedAt: Date.now() })
    const queryClient = new QueryClient()
    const key = streamKeys.bootstrap("ws_1", stream.id)
    queryClient.setQueryData(key, { stream })
    vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue()
    let completeUnarchive!: () => void
    mockUnarchive.mockImplementationOnce(() => new Promise<void>((resolve) => (completeUnarchive = resolve)))

    const { result } = renderHook(() => useUnarchiveStream("ws_1"), { wrapper: createWrapper(queryClient) })
    let mutation!: ReturnType<typeof result.current.mutateAsync>
    act(() => {
      mutation = result.current.mutateAsync({ streamId: stream.id, archivedAt: stream.archivedAt! })
    })
    await waitFor(() => expect(mockUnarchive).toHaveBeenCalled())
    act(() => queryClient.setQueryData(key, { stream, readState: { lastReadSequence: "12" } }))
    await db.streams.update(stream.id, { displayName: "Updated name", updatedAt: "2026-03-02T00:00:00.000Z" })
    await act(async () => {
      completeUnarchive()
      await mutation
    })

    const bootstrap = queryClient.getQueryData(key) as { stream: Stream; readState: { lastReadSequence: string } }
    const persisted = await db.streams.get(stream.id)
    expect({
      bootstrapArchivedAt: bootstrap.stream.archivedAt,
      readState: bootstrap.readState,
      persistedArchivedAt: persisted?.archivedAt,
      persistedName: persisted?.displayName,
    }).toEqual({
      bootstrapArchivedAt: null,
      readState: { lastReadSequence: "12" },
      persistedArchivedAt: null,
      persistedName: "Updated name",
    })
  })
})

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
