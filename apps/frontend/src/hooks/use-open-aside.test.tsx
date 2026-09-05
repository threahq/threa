import { describe, expect, it, beforeEach, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import type { ReactNode } from "react"
import { spyOnExport } from "@/test"
import * as streamsModule from "./use-streams"
import { getAsideState, resetAsideStoreCache } from "@/stores/aside-store"
import { useOpenAside } from "./use-open-aside"
import * as analyticsModule from "@/lib/analytics/posthog"

const HOST_PATH = "/w/ws_1/s/stream_host"

function wrapper(children: ReactNode) {
  return (
    <MemoryRouter initialEntries={[HOST_PATH]}>
      <Routes>
        <Route path="/w/:workspaceId/s/:streamId" element={<>{children}</>} />
      </Routes>
    </MemoryRouter>
  )
}

let resolveCreate: (stream: { id: string }) => void
let mutateAsync: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetAsideStoreCache()
  mutateAsync = vi.fn(
    () =>
      new Promise<{ id: string }>((resolve) => {
        resolveCreate = resolve
      })
  )
  // `spyOnExport` replaces the module getter, so the value IS the hook.
  spyOnExport(streamsModule, "useCreateStream").mockReturnValue((() => ({ mutateAsync })) as never)
})

describe("useOpenAside", () => {
  it("shows the surface when the create lands while its host is still mounted", async () => {
    const { result } = renderHook(() => useOpenAside("ws_1"), { wrapper: ({ children }) => wrapper(children) })

    const opening = result.current({ kind: "stream", hostStreamId: "stream_host" })
    resolveCreate({ id: "stream_aside" })
    await opening

    expect(getAsideState()).toMatchObject({ hostKey: HOST_PATH, asideId: "stream_aside" })
  })

  it("drops a create that lands after its host is gone, so it cannot resurface on return", async () => {
    const { result, unmount } = renderHook(() => useOpenAside("ws_1"), { wrapper: ({ children }) => wrapper(children) })

    const opening = result.current({ kind: "stream", hostStreamId: "stream_host" })
    unmount()
    resolveCreate({ id: "stream_aside" })
    await opening

    expect(getAsideState()).toBeNull()
  })

  it("should capture aside_opened with the origin kind when the hook is called", async () => {
    const capture = vi.spyOn(analyticsModule, "capture").mockImplementation(() => {})
    const { result } = renderHook(() => useOpenAside("ws_1"), { wrapper: ({ children }) => wrapper(children) })

    const opening = result.current({ kind: "stream", hostStreamId: "stream_host" })
    resolveCreate({ id: "stream_aside" })
    await opening

    expect(capture.mock.calls[0]).toEqual(["aside_opened", { kind: "stream" }])
  })
})
