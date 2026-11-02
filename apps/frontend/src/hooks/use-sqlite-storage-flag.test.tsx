import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceBootstrap } from "@threahq/types"
import { getActiveDb } from "@/db"
import { readSqliteStorageMode } from "@/db/sqlite-mirror/lifecycle"
import { workspaceKeys } from "./use-workspaces"
import { useSqliteStorageFlag } from "./use-sqlite-storage-flag"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  sessionStorage.clear()
})

describe("useSqliteStorageFlag", () => {
  it("reloads no tab while two workspaces deliver different values, only once one's own value changes", async () => {
    const reload = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({ reload } as unknown as Location)
    const queryClient = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children)
    const deliver = (workspaceId: string, sqliteStorage: string) =>
      queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), {
        featureFlags: { workspace: {}, user: { sqliteStorage } },
      } as unknown as WorkspaceBootstrap)
    const requested = () => readSqliteStorageMode(getActiveDb().name)

    deliver("ws_on", "read-write")
    const enrolled = renderHook(() => useSqliteStorageFlag("ws_on"), { wrapper })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    enrolled.unmount()

    deliver("ws_off", "off")
    renderHook(
      () => {
        useSqliteStorageFlag("ws_on")
        useSqliteStorageFlag("ws_off")
      },
      { wrapper }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const bothMounted = { reloads: reload.mock.calls.length, requested: requested() }
    act(() => deliver("ws_on", "off"))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2))
    expect({ bothMounted, requested: requested() }).toEqual({
      bothMounted: { reloads: 1, requested: "read-write" },
      requested: "off",
    })
  })
})
