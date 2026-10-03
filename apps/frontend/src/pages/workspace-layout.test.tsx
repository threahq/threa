import { StrictMode, useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { act, render } from "@testing-library/react"
import * as authModule from "@/auth"
import * as accountScopeModule from "@/auth/account-scope"
import * as contextsModule from "@/contexts"
import { ServicesProvider } from "@/contexts"
import * as unreadCountsModule from "@/hooks/use-unread-counts"
import { useSyncEngine, type SyncEngine } from "@/sync/sync-engine"
import { SyncStatusContext, SyncStatusStore } from "@/sync/sync-status"
import { WorkspaceSyncHandler } from "./workspace-layout"

const WORKSPACE_ID = "ws_a"

function EngineProbe({ capture }: { capture: { engine: SyncEngine | null } }) {
  const engine = useSyncEngine()
  useEffect(() => {
    capture.engine ??= engine
  }, [capture, engine])
  return null
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe("WorkspaceSyncHandler", () => {
  beforeEach(() => {
    vi.spyOn(contextsModule, "useSocket").mockReturnValue(null)
    vi.spyOn(contextsModule, "useSocketStatus").mockReturnValue("disconnected")
    vi.spyOn(contextsModule, "useSocketReconnectCount").mockReturnValue(0)
    vi.spyOn(authModule, "useAuth").mockReturnValue({
      user: { id: "usr_1" },
      login: vi.fn(),
    } as unknown as ReturnType<typeof authModule.useAuth>)
    vi.spyOn(accountScopeModule, "useAccountScope").mockReturnValue({
      activeWorkosUserId: "workos_A",
      switchAccount: vi.fn(),
    } as unknown as ReturnType<typeof accountScopeModule.useAccountScope>)
    vi.spyOn(unreadCountsModule, "useUnreadCounts").mockReturnValue({
      markAsRead: vi.fn(),
    } as unknown as ReturnType<typeof unreadCountsModule.useUnreadCounts>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("should destroy the sync engine when the handler unmounts but not when StrictMode re-runs its effects", async () => {
    const capture: { engine: SyncEngine | null } = { engine: null }
    const queryClient = new QueryClient()
    const syncStatus = new SyncStatusStore()

    // StrictMode must be the root wrapper: React only re-runs a mount's effects when
    // the root-placed fiber is itself inside StrictMode.
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/w/${WORKSPACE_ID}`]}>
          <SyncStatusContext.Provider value={syncStatus}>
            <ServicesProvider>
              <Routes>
                <Route
                  path="/w/:workspaceId"
                  element={
                    <WorkspaceSyncHandler workspaceId={WORKSPACE_ID} visibleStreamIds={[]}>
                      <EngineProbe capture={capture} />
                    </WorkspaceSyncHandler>
                  }
                />
              </Routes>
            </ServicesProvider>
          </SyncStatusContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
      { wrapper: StrictMode }
    )
    await flushMicrotasks()
    const engine = capture.engine
    const afterMount = engine?.isDestroyed

    unmount()
    await flushMicrotasks()
    const afterUnmount = engine?.isDestroyed

    expect({ afterMount, afterUnmount }).toEqual({ afterMount: false, afterUnmount: true })
  })
})
