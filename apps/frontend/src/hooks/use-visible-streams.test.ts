import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readVisibleStreams } from "@/lib/visible-streams"
import { installFakeCaches, uninstallFakeCaches } from "@/test/fake-caches"
import { useVisibleStreams } from "./use-visible-streams"

describe("useVisibleStreams", () => {
  beforeEach(() => {
    installFakeCaches()
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    uninstallFakeCaches()
  })

  it("should publish only the registering workspace's scoped key when ws_a shows stream_1", async () => {
    const { unmount } = renderHook(() => useVisibleStreams("ws_a", ["stream_1"]))

    await waitFor(async () => expect([...(await readVisibleStreams())]).toEqual(["ws_a/stream_1"]))

    unmount()
    await waitFor(async () => expect([...(await readVisibleStreams())]).toEqual([]))
  })

  it("should publish both scoped keys when two workspaces show the same stream id", async () => {
    const first = renderHook(() => useVisibleStreams("ws_a", ["stream_1"]))
    const second = renderHook(() => useVisibleStreams("ws_b", ["stream_1"]))

    await waitFor(async () => expect([...(await readVisibleStreams())]).toEqual(["ws_a/stream_1", "ws_b/stream_1"]))

    first.unmount()
    await waitFor(async () => expect([...(await readVisibleStreams())]).toEqual(["ws_b/stream_1"]))
    second.unmount()
  })
})
