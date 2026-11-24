import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { VideoStoryboard } from "@threahq/types"
import { attachmentsApi } from "@/api"
import { pendingGalleryId } from "@/components/gallery/pending-gallery-id"
import { useStoryboard } from "./use-storyboard"

const ready: VideoStoryboard = {
  status: "ready",
  columns: 10,
  rows: 3,
  tileCount: 24,
  intervalMs: 500,
  tileWidth: 240,
  tileHeight: 180,
}

function renderStoryboard(attachmentId: string | null) {
  const client = new QueryClient()
  return renderHook(() => useStoryboard("ws_1", attachmentId), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

let loadImages = true

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  loadImages = true
  vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (this: HTMLImageElement) {
    if (loadImages) queueMicrotask(() => this.dispatchEvent(new Event("load")))
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useStoryboard", () => {
  it("polls while pending and returns the storyboard once ready and its sprite loaded", async () => {
    const ensure = vi
      .spyOn(attachmentsApi, "ensureStoryboard")
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue(ready)
    const { result } = renderStoryboard("vid_1")

    await advance(0)
    const whilePending = result.current
    await advance(6_000)
    await advance(30_000)

    expect({ whilePending, calls: ensure.mock.calls.length, storyboard: result.current }).toEqual({
      whilePending: null,
      calls: 3,
      storyboard: { ...ready, spriteUrl: "/api/workspaces/ws_1/attachments/vid_1/storyboard/sprite" },
    })
  })

  it("stops polling after an unavailable answer", async () => {
    const ensure = vi.spyOn(attachmentsApi, "ensureStoryboard").mockResolvedValue({ status: "unavailable" })
    const { result } = renderStoryboard("vid_1")

    await advance(30_000)
    expect({ calls: ensure.mock.calls.length, storyboard: result.current }).toEqual({ calls: 1, storyboard: null })
  })

  it("gives up polling after 40 pending answers", async () => {
    const ensure = vi.spyOn(attachmentsApi, "ensureStoryboard").mockResolvedValue({ status: "pending" })
    renderStoryboard("vid_1")

    await advance(200_000)
    expect(ensure.mock.calls.length).toBe(40)
  })

  it("stays null when the sprite never loads", async () => {
    loadImages = false
    vi.spyOn(attachmentsApi, "ensureStoryboard").mockResolvedValue(ready)
    const { result } = renderStoryboard("vid_1")

    await advance(1_000)
    expect(result.current).toBeNull()
  })

  it("never asks for a pending gallery item or no attachment", async () => {
    const ensure = vi.spyOn(attachmentsApi, "ensureStoryboard").mockResolvedValue(ready)
    renderStoryboard(pendingGalleryId("local-1"))
    renderStoryboard(null)

    await advance(10_000)
    expect(ensure).not.toHaveBeenCalled()
  })
})
