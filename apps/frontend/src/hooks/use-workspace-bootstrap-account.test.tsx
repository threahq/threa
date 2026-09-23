import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import * as contexts from "@/contexts"
import * as auth from "@/auth"
import * as socketRoom from "@/lib/socket-room"
import { getActiveDb, setActiveDb, ThreaDatabase } from "@/db/database"
import { bumpAccountGeneration } from "@/db/event-writes"
import { asSocket, makeDeps, makeWorkspaceBootstrap, MockSocket } from "@/test/fixtures/sync-engine"
import { SyncEngine, SyncEngineContext } from "@/sync/sync-engine"
import { resetApplyWindow } from "@/stores/apply-window"
import { syncLogCursorKey } from "@/sync/sync-log-cursor"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { useWorkspaceBootstrap, workspaceKeys } from "./use-workspaces"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetWorkspaceStoreCache()
})

it.each([false, true])("should bind a delayed bootstrap to its originating account, switched=%s", async (switched) => {
  const previous = getActiveDb()
  const a = new ThreaDatabase("bootstrap_owner_a")
  const b = new ThreaDatabase("bootstrap_owner_b")
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const bootstrap = makeWorkspaceBootstrap()
  bootstrap.workspace.name = "Account A workspace"
  let release!: (value: typeof bootstrap) => void
  const fetchBootstrap = vi.fn(
    () =>
      new Promise<typeof bootstrap>((resolve) => {
        release = resolve
      })
  )
  vi.spyOn(contexts, "useSocket").mockReturnValue({} as ReturnType<typeof contexts.useSocket>)
  vi.spyOn(socketRoom, "joinRoomBestEffort").mockResolvedValue(undefined)
  vi.spyOn(contexts, "useWorkspaceService").mockReturnValue({ bootstrap: fetchBootstrap } as unknown as ReturnType<
    typeof contexts.useWorkspaceService
  >)
  vi.spyOn(auth, "useAccountScope").mockReturnValue({ activeWorkosUserId: "workos_a" } as ReturnType<
    typeof auth.useAccountScope
  >)
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  try {
    setActiveDb(a)
    const hook = renderHook(() => useWorkspaceBootstrap("ws_1"), { wrapper: Wrapper })
    await waitFor(() => expect(fetchBootstrap).toHaveBeenCalled())
    if (switched) {
      setActiveDb(b)
      bumpAccountGeneration()
    }
    await act(async () => {
      release(bootstrap)
    })
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe("idle"))
    expect({ a: (await a.workspaces.get("ws_1"))?.name, b: await b.workspaces.get("ws_1") }).toEqual({
      a: switched ? undefined : "Account A workspace",
      b: undefined,
    })
  } finally {
    cleanup()
    queryClient.clear()
    setActiveDb(previous)
    await a.delete()
    await b.delete()
  }
})

it.each([
  ["nothing local", {}, false],
  ["a cached workspace row", { workspace: true }, true],
  ["a persisted sync cursor", { cursor: true }, true],
] as const)("should bypass the service worker snapshot only when local state exists: %s", async (_, local, fresh) => {
  const previous = getActiveDb()
  const database = new ThreaDatabase("bootstrap_fresh_rule")
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const bootstrap = makeWorkspaceBootstrap()
  const fetchBootstrap = vi.fn(async () => bootstrap)
  vi.spyOn(contexts, "useSocket").mockReturnValue({} as ReturnType<typeof contexts.useSocket>)
  vi.spyOn(socketRoom, "joinRoomBestEffort").mockResolvedValue(undefined)
  vi.spyOn(contexts, "useWorkspaceService").mockReturnValue({ bootstrap: fetchBootstrap } as unknown as ReturnType<
    typeof contexts.useWorkspaceService
  >)
  vi.spyOn(auth, "useAccountScope").mockReturnValue({ activeWorkosUserId: "workos_a" } as ReturnType<
    typeof auth.useAccountScope
  >)
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  try {
    if ("workspace" in local) await database.workspaces.put({ ...bootstrap.workspace, _cachedAt: 1 })
    if ("cursor" in local) {
      await database.syncCursors.put({ key: syncLogCursorKey("ws_1"), cursor: "77", updatedAt: 1 })
    }
    setActiveDb(database)
    const hook = renderHook(() => useWorkspaceBootstrap("ws_1"), { wrapper: Wrapper })
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe("idle"))
    expect(fetchBootstrap.mock.calls).toEqual([["ws_1", { accountId: "workos_a", fresh }]])
  } finally {
    cleanup()
    queryClient.clear()
    setActiveDb(previous)
    await database.delete()
  }
})

it("should take the SyncEngine's first-connect snapshot instead of fetching a second one", async () => {
  const previous = getActiveDb()
  const database = new ThreaDatabase("bootstrap_engine_claim")
  const hookFetch = vi.fn(async () => makeWorkspaceBootstrap())
  vi.spyOn(contexts, "useSocket").mockReturnValue({} as ReturnType<typeof contexts.useSocket>)
  vi.spyOn(socketRoom, "joinRoomBestEffort").mockResolvedValue(undefined)
  vi.spyOn(contexts, "useWorkspaceService").mockReturnValue({ bootstrap: hookFetch } as unknown as ReturnType<
    typeof contexts.useWorkspaceService
  >)
  vi.spyOn(auth, "useAccountScope").mockReturnValue({ activeWorkosUserId: "workos_a" } as ReturnType<
    typeof auth.useAccountScope
  >)
  setActiveDb(database)
  const deps = makeDeps()
  const engine = new SyncEngine(deps)
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={deps.queryClient}>
        <SyncEngineContext.Provider value={engine}>{children}</SyncEngineContext.Provider>
      </QueryClientProvider>
    )
  }
  try {
    const hook = renderHook(() => useWorkspaceBootstrap("ws_1"), { wrapper: Wrapper })
    await act(async () => {
      await engine.onConnect(asSocket(new MockSocket()))
    })
    await waitFor(() => expect(hook.result.current.fetchStatus).toBe("idle"))
    expect({
      hookFetches: hookFetch.mock.calls.length,
      engineFetches: deps.workspaceService.bootstrap.mock.calls.length,
      workspaceId: hook.result.current.data?.workspace.id,
      sameAsCache: hook.result.current.data === deps.queryClient.getQueryData(workspaceKeys.bootstrap("ws_1")),
    }).toEqual({ hookFetches: 0, engineFetches: 1, workspaceId: "ws_1", sameAsCache: true })
  } finally {
    engine.destroy()
    cleanup()
    deps.queryClient.clear()
    resetApplyWindow()
    setActiveDb(previous)
    await database.delete()
  }
})
