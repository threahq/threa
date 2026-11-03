import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkspaceBootstrap } from "@threahq/types"
import { getActiveDb } from "@/db"
import {
  isStorageRestartPending,
  readSqliteStorageMode,
  resetStorageRestartForTests,
} from "@/db/sqlite-mirror/storage-mode"
import { workspaceKeys } from "./use-workspaces"
import { useSqliteStorageFlag } from "./use-sqlite-storage-flag"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const key of Object.keys(localStorage)) if (key.startsWith("threa:sqlite")) localStorage.removeItem(key)
  sessionStorage.clear()
  resetStorageRestartForTests()
})

describe("useSqliteStorageFlag", () => {
  it("asks for a restart only once a workspace's own value changes, never while two deliver different values", async () => {
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
    await waitFor(() => expect(isStorageRestartPending()).toBe(true))
    enrolled.unmount()
    resetStorageRestartForTests()

    deliver("ws_off", "off")
    renderHook(
      () => {
        useSqliteStorageFlag("ws_on")
        useSqliteStorageFlag("ws_off")
      },
      { wrapper }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const bothMounted = { asked: isStorageRestartPending(), requested: requested() }
    act(() => deliver("ws_on", "off"))
    await waitFor(() => expect(isStorageRestartPending()).toBe(true))
    expect({ bothMounted, requested: requested(), reloads: reload.mock.calls.length }).toEqual({
      bothMounted: { asked: false, requested: "read-write" },
      requested: "off",
      reloads: 0,
    })
  })
})
