import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query"
import { createElement, type ReactNode } from "react"
import { db } from "@/db"
import * as contextsModule from "@/contexts"
import * as syncEngineModule from "@/sync/sync-engine"
import { scheduledKeys, useScheduledList } from "./use-scheduled"

const WORKSPACE_ID = "ws_test"

describe("useScheduledList refetchOnReconnect (sync mode gate)", () => {
  let listFn: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    onlineManager.setOnline(true)
    await db.scheduledMessages.clear()
    listFn = vi.fn().mockResolvedValue({ scheduled: [], nextCursor: null })
    vi.spyOn(contextsModule, "useScheduledService").mockReturnValue({
      list: listFn,
    } as unknown as contextsModule.ScheduledService)
  })

  function mockEngine(present: boolean) {
    vi.spyOn(syncEngineModule, "useOptionalSyncEngine").mockReturnValue(
      present ? ({} as unknown as syncEngineModule.SyncEngine) : null
    )
  }

  /**
   * Mounts the list, lets the initial fetch land, then marks the query
   * invalidated while the browser is offline. `staleTime: Infinity` means the
   * reconnect refetch only ever fires for an invalidated query, so this is
   * the state that distinguishes `refetchOnReconnect` true from false on the
   * online flip.
   */
  async function mountInvalidatedOffline() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    renderHook(() => useScheduledList(WORKSPACE_ID, "pending"), { wrapper })
    // Wait for the fetch to SETTLE (not just for listFn to be called) — a
    // success landing after the invalidation would reset isInvalidated and
    // neutralise the reconnect refetch in every mode.
    await waitFor(() =>
      expect(queryClient.getQueryData(scheduledKeys.list(WORKSPACE_ID, "pending"))).toEqual({
        scheduled: [],
        nextCursor: null,
      })
    )
    await act(async () => {
      onlineManager.setOnline(false)
      await queryClient.invalidateQueries({
        queryKey: scheduledKeys.list(WORKSPACE_ID, "pending"),
        refetchType: "none",
      })
    })
  }

  it("skips the reconnect refetch when a sync engine is mounted (resume catch-up covers the online flip)", async () => {
    mockEngine(true)
    await mountInvalidatedOffline()

    await act(async () => {
      onlineManager.setOnline(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(listFn).toHaveBeenCalledTimes(1)
  })

  it("keeps the reconnect refetch without a sync engine", async () => {
    mockEngine(false)
    await mountInvalidatedOffline()

    act(() => {
      onlineManager.setOnline(true)
    })

    await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2))
  })
})
