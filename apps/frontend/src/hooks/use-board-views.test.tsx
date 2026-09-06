import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BoardView, WorkspaceBootstrap } from "@threahq/types"
import { ServicesProvider, type BoardViewService } from "@/contexts"
import { workspaceKeys } from "./use-workspaces"
import { useBoardViews } from "./use-board-views"

const mockList = vi.fn<BoardViewService["list"]>()

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ServicesProvider, {
        services: { boardViews: { list: mockList } as unknown as BoardViewService } as never,
        children,
      })
    )
  }
}

const view = (over: Partial<BoardView> = {}): BoardView => ({
  id: "boardview_1",
  name: "Design work",
  baseLens: "mine",
  scopeStreamIds: [],
  scopeStreamTypes: [],
  scopeLabelIds: [],
  excludeStreamIds: [],
  excludeStreamTypes: [],
  excludeLabelIds: [],
  sortOrder: 0,
  ...over,
})

function seedBootstrap(queryClient: QueryClient, boardViews: BoardView[] | undefined) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { boardViews } as Partial<WorkspaceBootstrap>)
}

beforeEach(() => {
  mockList.mockReset()
})

describe("useBoardViews", () => {
  it("paints the saved lenses from the bootstrap payload without an on-mount fetch", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const seeded = [view(), view({ id: "boardview_2", name: "Mine" })]
    seedBootstrap(queryClient, seeded)

    const { result } = renderHook(() => useBoardViews("ws_1"), { wrapper: wrapper(queryClient) })

    expect(result.current.data).toEqual(seeded)
    expect(mockList).not.toHaveBeenCalled()
    // The seed inherits the bootstrap's fetch time, not the query's mount time,
    // so the staleTime window counts from the real fetch (guards INV-53).
    const bootstrapUpdatedAt = queryClient.getQueryState(workspaceKeys.bootstrap("ws_1"))?.dataUpdatedAt
    expect(result.current.dataUpdatedAt).toBe(bootstrapUpdatedAt)
  })

  it("falls through to the fetch when the bootstrap snapshot lacks the field", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedBootstrap(queryClient, undefined)
    const fetched = [view({ id: "boardview_fetched" })]
    mockList.mockResolvedValue(fetched)

    const { result } = renderHook(() => useBoardViews("ws_1"), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.data).toEqual(fetched))
    expect(mockList).toHaveBeenCalledWith("ws_1")
  })
})
