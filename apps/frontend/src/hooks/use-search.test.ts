import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import * as apiModule from "@/api"
import type { SearchResponse, SearchResultItem } from "@/api"
import { useSearch } from "./use-search"

function searchResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return { results: [], clusters: [], memos: [], queryLogId: null, refine: null, ...overrides }
}

function hit(id: string): SearchResultItem {
  return {
    id,
    streamId: "stream_channel1",
    content: "Hello from the search results",
    authorId: "member_1",
    authorType: "user",
    createdAt: "2026-01-15T10:00:00Z",
    rank: 0,
  }
}

interface Deferred {
  promise: Promise<SearchResponse>
  resolve: (response: SearchResponse) => void
}

function deferred(): Deferred {
  let resolve!: (response: SearchResponse) => void
  const promise = new Promise<SearchResponse>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const REFINED = ["only decisions"]
const REFINED_REQUEST = { query: "hello", filters: undefined, phrases: [], refine: REFINED, limit: undefined }

describe("useSearch", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("retries a failed refinement once, with the same request, and keeps the second outcome", async () => {
    const searchMessages = vi
      .spyOn(apiModule, "searchMessages")
      .mockResolvedValueOnce(searchResponse({ refine: { applied: false, note: null } }))
      .mockResolvedValueOnce(searchResponse({ results: [hit("msg_1")], refine: { applied: true, note: "Kept two." } }))

    const { result } = renderHook(() => useSearch({ workspaceId: "workspace_1" }))
    await act(async () => {
      await result.current.search("hello", undefined, [], REFINED)
    })

    expect(searchMessages.mock.calls).toEqual([
      ["workspace_1", REFINED_REQUEST],
      ["workspace_1", REFINED_REQUEST],
    ])
    expect(result.current.refine).toEqual({ applied: true, note: "Kept two." })
    expect(result.current.results.map((r) => r.id)).toEqual(["msg_1"])
    expect(result.current.isLoading).toBe(false)
  })

  it("surfaces the failure after the retry fails too", async () => {
    const searchMessages = vi
      .spyOn(apiModule, "searchMessages")
      .mockResolvedValue(searchResponse({ results: [hit("msg_1")], refine: { applied: false, note: null } }))

    const { result } = renderHook(() => useSearch({ workspaceId: "workspace_1" }))
    await act(async () => {
      await result.current.search("hello", undefined, [], REFINED)
    })

    expect(searchMessages).toHaveBeenCalledTimes(2)
    expect(result.current.refine).toEqual({ applied: false, note: null })
    expect(result.current.results.map((r) => r.id)).toEqual(["msg_1"])
  })

  it("does not retry a request that carried no refinement", async () => {
    const searchMessages = vi
      .spyOn(apiModule, "searchMessages")
      .mockResolvedValue(searchResponse({ refine: { applied: false, note: null } }))

    const { result } = renderHook(() => useSearch({ workspaceId: "workspace_1" }))
    await act(async () => {
      await result.current.search("hello")
    })

    expect(searchMessages).toHaveBeenCalledTimes(1)
  })

  it("lets a newer search win over an in-flight retry", async () => {
    const pending: Deferred[] = []
    const searchMessages = vi.spyOn(apiModule, "searchMessages").mockImplementation(() => {
      const next = deferred()
      pending.push(next)
      return next.promise
    })

    const { result } = renderHook(() => useSearch({ workspaceId: "workspace_1" }))
    act(() => {
      void result.current.search("hello", undefined, [], REFINED)
    })
    await waitFor(() => expect(pending).toHaveLength(1))

    await act(async () => {
      pending[0]!.resolve(searchResponse({ refine: { applied: false, note: null } }))
    })
    await waitFor(() => expect(pending).toHaveLength(2))

    act(() => {
      void result.current.search("newer")
    })
    await waitFor(() => expect(pending).toHaveLength(3))

    await act(async () => {
      pending[2]!.resolve(searchResponse({ results: [hit("msg_newer")] }))
      pending[1]!.resolve(searchResponse({ results: [hit("msg_stale")], refine: { applied: true, note: "Stale." } }))
    })

    expect(result.current.results.map((r) => r.id)).toEqual(["msg_newer"])
    expect(result.current.refine).toBeNull()
    expect(result.current.isLoading).toBe(false)
    expect(searchMessages).toHaveBeenCalledTimes(3)
  })
})
