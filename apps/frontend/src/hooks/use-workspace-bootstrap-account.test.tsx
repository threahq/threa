import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import * as contexts from "@/contexts"
import * as auth from "@/auth"
import * as socketRoom from "@/lib/socket-room"
import { getActiveDb, setActiveDb, ThreaDatabase } from "@/db/database"
import { bumpAccountGeneration } from "@/db/event-writes"
import { makeWorkspaceBootstrap } from "@/test/fixtures/sync-engine"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { useWorkspaceBootstrap } from "./use-workspaces"

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
