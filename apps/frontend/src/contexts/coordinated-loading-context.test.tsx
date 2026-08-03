import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act } from "@testing-library/react"
import {
  CoordinatedLoadingProvider,
  CoordinatedLoadingGate,
  MainContentGate,
  useCoordinatedLoading,
} from "./coordinated-loading-context"
import { QUERY_LOAD_STATE, isQueryLoadStateLoading, type QueryLoadState } from "@/lib/query-load-state"
import { ApiError } from "@/api/client"
import * as syncStatusModule from "@/sync/sync-status"
import * as useCoordinatedStreamQueriesModule from "@/hooks/use-coordinated-stream-queries"
import * as usePreloadImagesModule from "@/hooks/use-preload-images"
import * as workspaceStoreModule from "@/stores/workspace-store"
import * as draftStoreModule from "@/stores/draft-store"
import * as loadingComponentsModule from "@/components/loading"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as e2eSessionModule from "@/stores/e2e-session-store"
import { clearStreamNameCache, primeStreamName, streamNameCacheKey } from "@/lib/crypto/stream-name-cache"
import { db } from "@/db"
import { applyWorkspaceBootstrap } from "@/sync/workspace-sync"
import { resetRowConfirmations } from "@/sync/bootstrap-diff"
import { makeStreamBootstrap, makeWorkspaceBootstrap } from "@/test/fixtures/sync-engine"
import type { WorkspaceBootstrap } from "@threa/types"

type MockQueryResult = {
  status: "pending" | "success" | "error"
  fetchStatus: "idle" | "fetching" | "paused"
  isLoading: boolean
  isError: boolean
  error: Error | null
  data?: { stream?: { id: string } }
}

let mockWorkspaceLoadState: QueryLoadState = QUERY_LOAD_STATE.PENDING
let mockStreamsLoadState: QueryLoadState = QUERY_LOAD_STATE.PENDING
let mockStreamResults: MockQueryResult[] = []
let mockSeedCacheFromIdbResult = false
let mockHasSeededWorkspaceCache = false
let mockWorkspace: { id: string } | undefined
let mockUsers: Array<{ id: string; avatarUrl: string | null }> = []
let mockStreams: Array<{
  id: string
  lastMessagePreview?: { createdAt: string } | null
  e2eEnabled?: boolean
  sealedNameCiphertext?: string | null
  sealedNameEnvelope?: unknown
}> = []
let mockE2eSessionStatus: e2eSessionModule.E2eSessionStatus = "no-key"
let mockMemberships: Array<{ streamId: string }> = []
let mockDmPeers: Array<{ streamId: string; userId: string }> = []
let mockPersonas: Array<{ id: string }> = []
let mockBots: Array<{ id: string }> = []
let mockUnreadState: { id: string } | undefined
let mockMetadata: { id: string } | undefined
let mockSidebarConfig: { id: string } | undefined
let mockHasSeededDraftCache = false
let mockSyncStatuses = new Map<string, string>()
let mockSyncErrors = new Map<string, { status: number | null; error: Error }>()

function installSpies() {
  vi.spyOn(syncStatusModule, "useSyncStatus").mockImplementation(() => {
    if (mockWorkspaceLoadState === QUERY_LOAD_STATE.PENDING || mockWorkspaceLoadState === QUERY_LOAD_STATE.FETCHING)
      return "syncing"
    if (mockWorkspaceLoadState === QUERY_LOAD_STATE.ERROR) return "error"
    return "synced"
  })
  vi.spyOn(syncStatusModule, "useSyncSnapshot").mockImplementation(() => ({
    statuses: mockSyncStatuses as ReadonlyMap<string, syncStatusModule.SyncStatus>,
    errors: mockSyncErrors as ReadonlyMap<string, syncStatusModule.SyncErrorRecord>,
  }))
  vi.spyOn(useCoordinatedStreamQueriesModule, "useCoordinatedStreamQueries").mockImplementation(
    () =>
      ({
        loadState: mockStreamsLoadState,
        isLoading: isQueryLoadStateLoading(mockStreamsLoadState),
        isError: false,
        errors: [],
        results: mockStreamResults,
      }) as unknown as ReturnType<typeof useCoordinatedStreamQueriesModule.useCoordinatedStreamQueries>
  )
  vi.spyOn(usePreloadImagesModule, "usePreloadImages").mockReturnValue(true)
  vi.spyOn(workspaceStoreModule, "seedCacheFromIdb").mockImplementation(async () => mockSeedCacheFromIdbResult)
  vi.spyOn(workspaceStoreModule, "hasSeededWorkspaceCache").mockImplementation(() => mockHasSeededWorkspaceCache)
  vi.spyOn(workspaceStoreModule, "useWorkspaceFromStore").mockImplementation(
    () => mockWorkspace as ReturnType<typeof workspaceStoreModule.useWorkspaceFromStore>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation(
    () => mockUsers as ReturnType<typeof workspaceStoreModule.useWorkspaceUsers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreams").mockImplementation(
    () => mockStreams as ReturnType<typeof workspaceStoreModule.useWorkspaceStreams>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceStreamMemberships").mockImplementation(
    () => mockMemberships as ReturnType<typeof workspaceStoreModule.useWorkspaceStreamMemberships>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceDmPeers").mockImplementation(
    () => mockDmPeers as ReturnType<typeof workspaceStoreModule.useWorkspaceDmPeers>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspacePersonas").mockImplementation(
    () => mockPersonas as ReturnType<typeof workspaceStoreModule.useWorkspacePersonas>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceBots").mockImplementation(
    () => mockBots as ReturnType<typeof workspaceStoreModule.useWorkspaceBots>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceUnreadState").mockImplementation(
    () => mockUnreadState as ReturnType<typeof workspaceStoreModule.useWorkspaceUnreadState>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceMetadata").mockImplementation(
    () => mockMetadata as ReturnType<typeof workspaceStoreModule.useWorkspaceMetadata>
  )
  vi.spyOn(workspaceStoreModule, "useWorkspaceSidebarConfig").mockImplementation(
    () => mockSidebarConfig as ReturnType<typeof workspaceStoreModule.useWorkspaceSidebarConfig>
  )
  vi.spyOn(draftStoreModule, "seedDraftCacheFromIdb").mockImplementation(async () => undefined)
  vi.spyOn(draftStoreModule, "hasSeededDraftCache").mockImplementation(() => mockHasSeededDraftCache)
  // The sealed-name reveal gate reads the current user's session; default to a
  // no-key (non-E2E) workspace so existing cases are unaffected.
  vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("user_1")
  vi.spyOn(e2eSessionModule, "useE2eSession").mockImplementation(
    () =>
      ({
        status: mockE2eSessionStatus,
        keyId: null,
        publicKey: null,
        privateKey: null,
        deviceTrusted: false,
        error: null,
      }) as e2eSessionModule.E2eSessionState
  )
  vi.spyOn(loadingComponentsModule, "StreamContentSkeleton").mockImplementation(() => (
    <div data-testid="stream-content-skeleton">Stream Content Skeleton</div>
  ))
}

function TestConsumer() {
  const { phase, getStreamState, hasErrors, showLoadingIndicator } = useCoordinatedLoading()
  return (
    <div>
      <span data-testid="phase">{phase}</span>
      <span data-testid="stream-state">{getStreamState("stream_1")}</span>
      <span data-testid="has-errors">{String(hasErrors)}</span>
      <span data-testid="show-loading-indicator">{String(showLoadingIndicator)}</span>
    </div>
  )
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
  })
}

function makeReadyWorkspaceState() {
  mockWorkspaceLoadState = QUERY_LOAD_STATE.READY
  mockStreamsLoadState = QUERY_LOAD_STATE.READY
  mockSeedCacheFromIdbResult = true
  mockHasSeededWorkspaceCache = true
  mockHasSeededDraftCache = true
  mockWorkspace = { id: "workspace_1" }
  mockUsers = [{ id: "user_1", avatarUrl: null }]
  mockStreams = [{ id: "stream_1" }]
  mockUnreadState = { id: "workspace_1" }
  mockMetadata = { id: "workspace_1" }
  mockSidebarConfig = { id: "workspace_1" }
}

describe("CoordinatedLoadingProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    mockWorkspaceLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamsLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamResults = []
    mockSeedCacheFromIdbResult = false
    mockHasSeededWorkspaceCache = false
    mockWorkspace = undefined
    mockUsers = []
    mockStreams = []
    mockMemberships = []
    mockDmPeers = []
    mockPersonas = []
    mockBots = []
    mockUnreadState = undefined
    mockMetadata = undefined
    mockSidebarConfig = undefined
    mockHasSeededDraftCache = false
    mockSyncStatuses = new Map()
    mockSyncErrors = new Map()
    mockE2eSessionStatus = "no-key"
    clearStreamNameCache()
    installSpies()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    clearStreamNameCache()
  })

  it("reports loading initially while initial data is unresolved", async () => {
    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("loading")
  })

  it("stays blank through a slightly-slow load and only shows the skeleton after 600ms", async () => {
    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()
    expect(screen.getByTestId("phase").textContent).toBe("loading")

    // A slightly-slow load (under 600ms) must not flash a skeleton.
    act(() => {
      vi.advanceTimersByTime(599)
    })
    expect(screen.getByTestId("phase").textContent).toBe("loading")

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByTestId("phase").textContent).toBe("skeleton")
  })

  it("holds the skeleton until ready instead of blanking when loading finishes first", async () => {
    // Flicker regression: online, the network query can flip `isLoading` false a
    // beat before the cached reveal settles `isReady`. The old gate reset the
    // skeleton on that transition, producing skeleton → blank → content. The
    // skeleton must stay up until the content is actually ready.
    mockHasSeededWorkspaceCache = true
    mockWorkspace = { id: "workspace_1" }
    mockUsers = [{ id: "user_1", avatarUrl: "https://cdn.example/avatar.png" }]
    mockStreams = [{ id: "stream_1" }]
    mockUnreadState = { id: "workspace_1" }
    mockMetadata = { id: "workspace_1" }
    mockSidebarConfig = { id: "workspace_1" }
    mockStreamsLoadState = QUERY_LOAD_STATE.READY
    // Not primed from a prior session and avatars still preloading, so the
    // reveal can't settle yet (revealReady stays false).
    mockSeedCacheFromIdbResult = false
    const preloadSpy = vi.spyOn(usePreloadImagesModule, "usePreloadImages").mockReturnValue(false)
    // Drafts still loading keeps the initial load going so the skeleton arms.
    mockHasSeededDraftCache = false

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(screen.getByTestId("phase").textContent).toBe("skeleton")

    // Loading finishes (drafts seeded) but the reveal still can't settle
    // (avatars not preloaded, cache not primed) — phase must hold on skeleton,
    // never regress to the blank "loading" phase.
    mockHasSeededDraftCache = true
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )
    await flushEffects()
    expect(screen.getByTestId("phase").textContent).toBe("skeleton")

    // Once the reveal can settle, it goes straight to content.
    preloadSpy.mockReturnValue(true)
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )
    await flushEffects()
    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("is ready when IDB is primed and stream record exists (no per-stream cache needed)", async () => {
    mockSeedCacheFromIdbResult = true
    mockHasSeededWorkspaceCache = true
    mockHasSeededDraftCache = true
    mockWorkspace = { id: "workspace_1" }
    mockUsers = [{ id: "user_1", avatarUrl: null }]
    mockStreams = [{ id: "stream_1" }]
    mockUnreadState = { id: "workspace_1" }
    mockMetadata = { id: "workspace_1" }
    mockSidebarConfig = { id: "workspace_1" }

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    // IDB primed + stream record exists = ready (useLiveQuery serves events from IDB)
    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("waits for workspace metadata before becoming ready", async () => {
    makeReadyWorkspaceState()
    mockMetadata = undefined
    mockSeedCacheFromIdbResult = true

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("loading")

    mockMetadata = { id: "workspace_1" }
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("waits for the sidebar config before becoming ready (no default-layout flash)", async () => {
    // Regression: the sidebar renders its DEFAULT layout when no config is
    // resolved, so revealing before the persisted config loaded flashed the
    // default sections for a frame before popping to the user's real layout.
    makeReadyWorkspaceState()
    mockSidebarConfig = undefined
    mockSeedCacheFromIdbResult = true

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("loading")

    mockSidebarConfig = { id: "workspace_1" }
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("waits for local draft cache before becoming ready", async () => {
    makeReadyWorkspaceState()
    mockHasSeededDraftCache = false
    mockSeedCacheFromIdbResult = true

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("loading")

    mockHasSeededDraftCache = true
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("is ready immediately when the cache already has the full visible read model", async () => {
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("trusts IDB when primed — does not wait for bootstrap even with stale preview", async () => {
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true
    mockStreams = [
      {
        id: "stream_1",
        lastMessagePreview: { createdAt: "2026-03-01T10:01:00Z" },
      },
    ]

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    // IDB is the source of truth — useLiveQuery serves events directly.
    // No need to wait for bootstrap to confirm preview alignment.
    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("reveals cached content immediately when IDB is primed even while avatars are still preloading", async () => {
    // Offline-first regression: a returning user's read model is fully in IDB,
    // but avatar preloading hits the network. On a flaky connection those image
    // requests hang until the 2s preload timeout, so gating the reveal on them
    // made the app slower "out and about" than offline (where they error
    // instantly). A primed cache must reveal immediately and let avatars stream
    // in afterward.
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true
    mockUsers = [{ id: "user_1", avatarUrl: "https://cdn.example/avatar.png" }]
    vi.spyOn(usePreloadImagesModule, "usePreloadImages").mockReturnValue(false)

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("still waits on avatar preload during a genuine cold load (nothing cached)", async () => {
    // Counterpart to the primed-cache case: with no IDB cache there is nothing
    // to reveal early, so the cold-load nicety of preloading avatars before the
    // first paint (avoiding an initials→avatar flash) still applies — the gate
    // holds until the preload resolves.
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = false // cache not primed
    mockUsers = [{ id: "user_1", avatarUrl: "https://cdn.example/avatar.png" }]
    const preloadSpy = vi.spyOn(usePreloadImagesModule, "usePreloadImages").mockReturnValue(false)

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    // Data is ready but avatars are not preloaded and the cache isn't primed —
    // the gate must not open yet.
    expect(screen.getByTestId("phase").textContent).not.toBe("ready")

    preloadSpy.mockReturnValue(true)
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("reports stream state as idle during the initial coordinated load", async () => {
    mockStreamResults = [{ status: "pending", fetchStatus: "fetching", isLoading: true, isError: false, error: null }]

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("stream-state").textContent).toBe("idle")
  })

  it("reports stream state as loading after the initial load has completed", async () => {
    makeReadyWorkspaceState()
    mockStreamResults = [{ status: "pending", fetchStatus: "fetching", isLoading: true, isError: false, error: null }]

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    mockStreamsLoadState = QUERY_LOAD_STATE.FETCHING
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
    expect(screen.getByTestId("stream-state").textContent).toBe("loading")
  })

  it("keeps the topbar indicator dark for the initial background sync that overlaps the first reveal", async () => {
    // Offline-first: a returning user reveals from IDB while the very first
    // workspace bootstrap is still syncing in the background. That initial sync
    // is a refresh of already-visible content, not a load, so the topbar
    // indicator must stay dark — surfacing it made online feel slower than
    // offline, which never syncs and so never shows it.
    makeReadyWorkspaceState()
    mockSyncStatuses = new Map([["workspace:workspace_1", "syncing"]])

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()
    // Revealed from IDB despite the in-flight sync...
    expect(screen.getByTestId("phase").textContent).toBe("ready")

    // ...and the indicator stays off even past the reveal delay.
    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })
    expect(screen.getByTestId("show-loading-indicator").textContent).toBe("false")
  })

  it("shows the delayed topbar indicator while reconnect sync is in progress after initial load", async () => {
    makeReadyWorkspaceState()

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()
    expect(screen.getByTestId("show-loading-indicator").textContent).toBe("false")

    mockSyncStatuses = new Map([["workspace:workspace_1", "syncing"]])
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    expect(screen.getByTestId("show-loading-indicator").textContent).toBe("true")
  })

  it("surfaces reconnect stream errors from sync status even when the query cache is still populated", async () => {
    makeReadyWorkspaceState()
    mockSyncErrors = new Map([
      [
        "stream:stream_1",
        {
          status: 404,
          error: new ApiError(404, "NOT_FOUND", "Not found"),
        },
      ],
    ])

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("stream-state").textContent).toBe("error")
    expect(screen.getByTestId("has-errors").textContent).toBe("true")
  })

  it("suppresses recoverable stream bootstrap errors when the cached stream is usable", async () => {
    makeReadyWorkspaceState()
    mockStreamResults = [
      {
        status: "error",
        fetchStatus: "idle",
        isLoading: false,
        isError: true,
        error: new ApiError(429, "RATE_LIMITED", "Too many requests"),
      },
    ]
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
    expect(screen.getByTestId("stream-state").textContent).toBe("idle")
    expect(screen.getByTestId("has-errors").textContent).toBe("false")
    warnSpy.mockRestore()
  })

  it("reveals an open plaintext stream immediately even when OTHER workspace streams have undecrypted sealed names", async () => {
    // Multi-second-blank regression: the reveal must scope the sealed-name wait to
    // the stream being shown, not the whole workspace. Opening a plaintext DM on a
    // workspace full of E2E scratchpads blanked the cached DM behind decrypting all
    // those unrelated names (each a network key-wrap fetch, re-run every refresh).
    // The open stream is plaintext (already has its name) → reveal now; the other
    // sealed streams resolve in the sidebar via their own per-row loader.
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true
    mockE2eSessionStatus = "unlocked"
    mockStreams = [
      { id: "stream_1" }, // the OPEN stream — plaintext, no sealed name
      // an unrelated E2E scratchpad whose name has NOT decrypted
      { id: "stream_sealed", e2eEnabled: true, sealedNameCiphertext: "ct_other", sealedNameEnvelope: { v: 1 } },
    ]

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    // The open plaintext stream does not wait on the other workspace stream's name.
    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("holds the reveal until an OPEN sealed stream's own name decrypts, then reveals", async () => {
    // The scoped wait is kept where it's legitimate: when the stream being opened
    // is itself sealed, hold briefly so its header paints the real name rather than
    // flashing the placeholder. Only its ONE name is awaited, never the workspace's.
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true
    mockE2eSessionStatus = "unlocked"
    mockStreams = [{ id: "stream_1", e2eEnabled: true, sealedNameCiphertext: "ct_1", sealedNameEnvelope: { v: 1 } }]

    const { rerender } = render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    // The open stream is sealed and its name hasn't decrypted → hold.
    expect(screen.getByTestId("phase").textContent).not.toBe("ready")

    // Its name lands (seeded into the shared cache) → reveal.
    act(() => {
      primeStreamName(streamNameCacheKey("workspace_1", "stream_1", "ct_1"), "Quarterly Plan")
    })
    rerender(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )
    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })

  it("does not wait on an open sealed stream while the session is locked (reveals with the placeholder)", async () => {
    makeReadyWorkspaceState()
    mockSeedCacheFromIdbResult = true
    mockE2eSessionStatus = "locked"
    // A sealed name that can never decrypt while locked must not deadlock the reveal.
    mockStreams = [{ id: "stream_1", e2eEnabled: true, sealedNameCiphertext: "ct_1", sealedNameEnvelope: { v: 1 } }]

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("phase").textContent).toBe("ready")
  })
})

describe("CoordinatedLoadingGate", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    mockWorkspaceLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamsLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamResults = []
    mockSeedCacheFromIdbResult = false
    mockHasSeededWorkspaceCache = false
    mockWorkspace = undefined
    mockUsers = []
    mockStreams = []
    mockUnreadState = undefined
    mockMetadata = undefined
    mockSidebarConfig = undefined
    installSpies()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("shows nothing during the blank loading phase", async () => {
    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <CoordinatedLoadingGate>
          <div data-testid="content">Actual Content</div>
        </CoordinatedLoadingGate>
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.queryByTestId("content")).not.toBeInTheDocument()
  })

  it("renders children during the skeleton phase", async () => {
    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <CoordinatedLoadingGate>
          <div data-testid="content">Actual Content</div>
        </CoordinatedLoadingGate>
      </CoordinatedLoadingProvider>
    )

    await flushEffects()
    act(() => {
      vi.advanceTimersByTime(600)
    })

    expect(screen.getByTestId("content")).toBeInTheDocument()
  })

  it("renders children immediately in the ready phase", async () => {
    makeReadyWorkspaceState()

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <CoordinatedLoadingGate>
          <div data-testid="content">Actual Content</div>
        </CoordinatedLoadingGate>
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("content")).toBeInTheDocument()
  })
})

describe("MainContentGate", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    mockWorkspaceLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamsLoadState = QUERY_LOAD_STATE.PENDING
    mockStreamResults = []
    mockSeedCacheFromIdbResult = false
    mockHasSeededWorkspaceCache = false
    mockWorkspace = undefined
    mockUsers = []
    mockStreams = []
    mockUnreadState = undefined
    mockMetadata = undefined
    mockSidebarConfig = undefined
    installSpies()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("shows the stream content skeleton during initial load", async () => {
    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <MainContentGate>
          <div data-testid="content">Actual Content</div>
        </MainContentGate>
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.getByTestId("stream-content-skeleton")).toBeInTheDocument()
    expect(screen.queryByTestId("content")).not.toBeInTheDocument()
  })

  it("shows children once the coordinated load is ready", async () => {
    makeReadyWorkspaceState()

    render(
      <CoordinatedLoadingProvider workspaceId="workspace_1" streamIds={["stream_1"]}>
        <MainContentGate>
          <div data-testid="content">Actual Content</div>
        </MainContentGate>
      </CoordinatedLoadingProvider>
    )

    await flushEffects()

    expect(screen.queryByTestId("stream-content-skeleton")).not.toBeInTheDocument()
    expect(screen.getByTestId("content")).toBeInTheDocument()
  })
})

describe("CoordinatedLoadingProvider store publication", () => {
  // The real workspace-store hooks, so the provider is woken (or not) by the
  // real publication signal — the 10-hook fan-out this gating exists to stop.
  const WS = "ws_clp"

  function installNonStoreSpies(): void {
    vi.spyOn(syncStatusModule, "useSyncStatus").mockReturnValue("synced")
    vi.spyOn(syncStatusModule, "useSyncSnapshot").mockReturnValue({
      statuses: new Map() as ReadonlyMap<string, syncStatusModule.SyncStatus>,
      errors: new Map() as ReadonlyMap<string, syncStatusModule.SyncErrorRecord>,
    })
    vi.spyOn(useCoordinatedStreamQueriesModule, "useCoordinatedStreamQueries").mockImplementation(
      () =>
        ({
          loadState: QUERY_LOAD_STATE.READY,
          isLoading: false,
          isError: false,
          errors: [],
          results: [],
        }) as unknown as ReturnType<typeof useCoordinatedStreamQueriesModule.useCoordinatedStreamQueries>
    )
    vi.spyOn(usePreloadImagesModule, "usePreloadImages").mockReturnValue(true)
    vi.spyOn(draftStoreModule, "seedDraftCacheFromIdb").mockImplementation(async () => undefined)
    vi.spyOn(draftStoreModule, "hasSeededDraftCache").mockReturnValue(true)
    vi.spyOn(useWorkspacesModule, "useWorkspaceUserId").mockReturnValue("user_1")
    vi.spyOn(e2eSessionModule, "useE2eSession").mockImplementation(
      () =>
        ({
          status: "no-key",
          keyId: null,
          publicKey: null,
          privateKey: null,
          deviceTrusted: false,
          error: null,
        }) as e2eSessionModule.E2eSessionState
    )
  }

  function diffBootstrap(): WorkspaceBootstrap {
    return structuredClone(bootstrapBase)
  }

  let bootstrapBase: WorkspaceBootstrap

  beforeEach(async () => {
    vi.restoreAllMocks()
    installNonStoreSpies()
    workspaceStoreModule.resetWorkspaceStoreCache()
    resetRowConfirmations()
    await Promise.all([
      db.workspaces.clear(),
      db.workspaceUsers.clear(),
      db.streams.clear(),
      db.streamMemberships.clear(),
      db.streamReadState.clear(),
      db.dmPeers.clear(),
      db.personas.clear(),
      db.bots.clear(),
      db.labels.clear(),
      db.labelAssignments.clear(),
      db.unreadState.clear(),
      db.userPreferences.clear(),
      db.sidebarConfigs.clear(),
      db.workspaceMetadata.clear(),
    ])
    const now = new Date().toISOString()
    bootstrapBase = {
      ...makeWorkspaceBootstrap(),
      workspace: { id: WS, name: "CLP", slug: "clp", createdBy: "user_1", createdAt: now, updatedAt: now },
      featureFlags: { workspace: { bootstrapDiff: "on" }, user: {} },
      users: [
        {
          id: "user_1",
          workspaceId: WS,
          workosUserId: "workos_1",
          email: "kris@example.com",
          role: "owner",
          slug: "kris",
          name: "Kris",
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
          joinedAt: now,
        },
      ] as unknown as WorkspaceBootstrap["users"],
      streams: [
        { ...makeStreamBootstrap("stream_clp1").stream, workspaceId: WS, lastMessagePreview: null },
      ] as unknown as WorkspaceBootstrap["streams"],
      streamMemberships: [
        { streamId: "stream_clp1", memberId: "user_1", notificationLevel: null, joinedAt: now },
      ] as unknown as WorkspaceBootstrap["streamMemberships"],
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("an unchanged bootstrap apply does not re-render the coordinated-loading provider", async () => {
    // One of the provider's 10 store hooks, wrapped rather than replaced: each
    // call is one provider render pass.
    const realUseWorkspaceUsers = workspaceStoreModule.useWorkspaceUsers
    let providerRenders = 0
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation((workspaceId) => {
      providerRenders += 1
      return realUseWorkspaceUsers(workspaceId)
    })

    await applyWorkspaceBootstrap(WS, diffBootstrap(), Date.now() - 5000)

    render(
      <CoordinatedLoadingProvider workspaceId={WS} streamIds={[]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )
    await act(async () => {
      await Promise.resolve()
    })
    const before = providerRenders

    await act(async () => {
      await applyWorkspaceBootstrap(WS, diffBootstrap(), Date.now())
    })

    expect(providerRenders).toBe(before)
  })

  it("a changed row re-renders the coordinated-loading provider exactly once", async () => {
    const realUseWorkspaceUsers = workspaceStoreModule.useWorkspaceUsers
    let providerRenders = 0
    vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockImplementation((workspaceId) => {
      providerRenders += 1
      return realUseWorkspaceUsers(workspaceId)
    })

    await applyWorkspaceBootstrap(WS, diffBootstrap(), Date.now() - 5000)

    render(
      <CoordinatedLoadingProvider workspaceId={WS} streamIds={[]}>
        <TestConsumer />
      </CoordinatedLoadingProvider>
    )
    await act(async () => {
      await Promise.resolve()
    })
    const before = providerRenders

    const changed = diffBootstrap()
    changed.users = changed.users.map((u) => ({ ...u, name: "Renamed" }))
    await act(async () => {
      await applyWorkspaceBootstrap(WS, changed, Date.now())
    })

    expect(providerRenders).toBe(before + 1)
  })
})
