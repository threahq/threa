import { describe, it, expect, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import { spyOnExport } from "@/test"
import * as workspaceStore from "@/stores/workspace-store"
import type { CachedStream } from "@/stores/workspace-store"
import { useDocSuggestion } from "./use-doc-suggestion"

let streams: CachedStream[]

function stream(overrides: Partial<CachedStream> & { id: string }): CachedStream {
  return {
    workspaceId: "ws_1",
    type: "doc",
    displayName: null,
    slug: null,
    parentStreamId: "stream_elsewhere",
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  } as CachedStream
}

beforeEach(() => {
  streams = []
  spyOnExport(workspaceStore, "useWorkspaceStreamsSelect").mockReturnValue(((
    _workspaceId: string,
    select: (rows: CachedStream[]) => unknown
  ) => select(streams)) as never)
})

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/w/ws_1/s/stream_host"]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={children} />
      </Routes>
    </MemoryRouter>
  )
}

function suggest(query: string, hostStreamId?: string, excludeDocId?: string): string[] {
  const { result } = renderHook(() => useDocSuggestion(hostStreamId, excludeDocId), { wrapper })
  const items = result.current.suggestionConfig.items({ query }) as { id: string }[]
  return items.map((item) => item.id)
}

describe("useDocSuggestion", () => {
  it("should list the host's docs first and then the newest when the query is empty", () => {
    streams = [
      stream({ id: "stream_old_elsewhere", displayName: "Old", createdAt: "2026-09-01T00:00:00.000Z" }),
      stream({ id: "stream_new_elsewhere", displayName: "New", createdAt: "2026-10-20T00:00:00.000Z" }),
      stream({
        id: "stream_hosted",
        displayName: "Hosted",
        parentStreamId: "stream_host",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ]

    expect(suggest("", "stream_host")).toEqual(["stream_hosted", "stream_new_elsewhere", "stream_old_elsewhere"])
  })

  it("should keep only active docs whose title contains the query when one is typed", () => {
    streams = [
      stream({ id: "stream_match", displayName: "Launch Plan" }),
      stream({ id: "stream_other", displayName: "Retro notes" }),
      stream({ id: "stream_archived", displayName: "Old launch plan", archivedAt: "2026-10-02T00:00:00.000Z" }),
      stream({ id: "stream_channel", type: "channel", displayName: "launch plan" }),
    ]

    expect(suggest("  plan ")).toEqual(["stream_match"])
  })

  it("should cap the list at eight when more docs match", () => {
    streams = Array.from({ length: 10 }, (_, i) =>
      stream({ id: `stream_${i}`, displayName: `Doc ${i}`, createdAt: `2026-10-${String(i + 10)}T00:00:00.000Z` })
    )

    expect(suggest("doc")).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map((i) => `stream_${i}`))
  })

  it("should leave out the doc being edited when it is excluded", () => {
    streams = [
      stream({ id: "stream_self", displayName: "Plan" }),
      stream({ id: "stream_other", displayName: "Plan B" }),
    ]

    expect(suggest("plan", undefined, "stream_self")).toEqual(["stream_other"])
  })
})
