import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { spyOnExport } from "@/test"
import * as handoffModule from "@/hooks/use-aside-handoff"
import * as draftsModule from "./use-aside-drafts"
import { asideOpenDraft, openAside, resetAsideStoreCache } from "@/stores/aside-store"
import { useAsideDraftSurface } from "./use-aside-draft-surface"

const ASIDE = "stream_aside_1"
const params = {
  workspaceId: "ws_1",
  asideId: ASIDE,
  hostStreamId: "stream_host",
  originScope: "stream:stream_host",
}

beforeEach(() => {
  resetAsideStoreCache()
  openAside({
    hostKey: "/w/ws_1/s/stream_host",
    hostStreamId: "stream_host",
    asideId: ASIDE,
    originScope: "stream:stream_host",
  })
  spyOnExport(handoffModule, "useAsideHandoff").mockReturnValue((() => async () => null) as never)
})

afterEach(() => vi.restoreAllMocks())

describe("useAsideDraftSurface", () => {
  it("starts a draft in this aside's own scope and opens it", () => {
    const { result } = renderHook(() => useAsideDraftSurface(params))

    act(() => result.current.startDraft())

    expect(result.current.openScope).toMatch(/^aside:stream_aside_1:draft_/)
    expect(asideOpenDraft(ASIDE)).toBe(result.current.openScope)
  })

  it("closes the draft it is discarding BEFORE the purge, so the editor's teardown flush has nothing to re-save", async () => {
    const order: string[] = []
    const purge = vi.fn(async () => {
      order.push(`purged:${asideOpenDraft(ASIDE) ?? "closed"}`)
    })
    spyOnExport(draftsModule, "useDeleteAsideDraft").mockReturnValue((() => purge) as never)
    const { result } = renderHook(() => useAsideDraftSurface(params))
    act(() => result.current.openDraft("aside:stream_aside_1:draft_1"))

    await act(async () => result.current.discardDraft("aside:stream_aside_1:draft_1"))

    // The editor unmounts on the close; if the purge ran first its teardown
    // would find no loaded pointer and re-create the row it had just deleted.
    expect(order).toEqual(["purged:closed"])
    expect(purge).toHaveBeenCalledWith("aside:stream_aside_1:draft_1")
    expect(asideOpenDraft(ASIDE)).toBeNull()
  })

  it("leaves another draft open when a different one is discarded", async () => {
    spyOnExport(draftsModule, "useDeleteAsideDraft").mockReturnValue((() => async () => {}) as never)
    const { result } = renderHook(() => useAsideDraftSurface(params))
    act(() => result.current.openDraft("aside:stream_aside_1:draft_1"))

    await act(async () => result.current.discardDraft("aside:stream_aside_1:draft_2"))

    expect(asideOpenDraft(ASIDE)).toBe("aside:stream_aside_1:draft_1")
  })
})
