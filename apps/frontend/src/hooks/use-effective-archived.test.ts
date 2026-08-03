import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import type { CachedStream } from "@/db"
import * as streamStore from "@/stores/stream-store"
import { useEffectiveArchived } from "./use-effective-archived"

function seedRoot(root: Partial<CachedStream> | undefined) {
  vi.spyOn(streamStore, "useStreamFromStore").mockReturnValue(root as CachedStream | undefined)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useEffectiveArchived", () => {
  it("seals on the anchor stream's own archivedAt", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: "2026-01-01T00:00:00.000Z" },
        rootStreamId: null,
        fallbackRootArchived: false,
      })
    )
    expect(result.current).toEqual({ ownArchived: true, rootArchived: false, isArchived: true })
  })

  it("inherits from the root row in the stream cache", () => {
    seedRoot({ id: "stream_root", archivedAt: "2026-01-01T00:00:00.000Z" })
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        fallbackRootArchived: false,
      })
    )
    expect(result.current).toEqual({ ownArchived: false, rootArchived: true, isArchived: true })
  })

  it("a present, unarchived root row wins over a stale fallback", () => {
    seedRoot({ id: "stream_root", archivedAt: null })
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        fallbackRootArchived: true,
      })
    )
    expect(result.current).toEqual({ ownArchived: false, rootArchived: false, isArchived: false })
  })

  it("falls back to the cold-load verdict when the root row is absent", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        fallbackRootArchived: "2026-01-01T00:00:00.000Z",
      })
    )
    expect(result.current).toEqual({ ownArchived: false, rootArchived: true, isArchived: true })
  })

  it("is unarchived with no own state, no root row and no fallback", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        fallbackRootArchived: undefined,
      })
    )
    expect(result.current).toEqual({ ownArchived: false, rootArchived: false, isArchived: false })
  })

  it("ignores a root fallback when the surface has no root to inherit from", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({ stream: { archivedAt: null }, rootStreamId: null, fallbackRootArchived: true })
    )
    expect(result.current.isArchived).toBe(false)
  })
  it("applies the fallback when the anchor row itself is absent (chain unresolvable)", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({ stream: undefined, rootStreamId: null, fallbackRootArchived: true })
    )
    expect(result.current).toEqual({ ownArchived: false, rootArchived: true, isArchived: true })
  })

  it("stays unarchived with an absent anchor and no fallback verdict", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({ stream: undefined, rootStreamId: null, fallbackRootArchived: false })
    )
    expect(result.current.isArchived).toBe(false)
  })

  it("uses a caller-supplied root row instead of self-resolving", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        rootStream: { archivedAt: null },
        fallbackRootArchived: "2026-01-01T00:00:00.000Z",
      })
    )
    expect(result.current.isArchived).toBe(false)
    expect(streamStore.useStreamFromStore).toHaveBeenCalledWith(undefined)
  })

  it("a caller-supplied null root row means known-absent and takes the fallback", () => {
    seedRoot(undefined)
    const { result } = renderHook(() =>
      useEffectiveArchived({
        stream: { archivedAt: null },
        rootStreamId: "stream_root",
        rootStream: null,
        fallbackRootArchived: "2026-01-01T00:00:00.000Z",
      })
    )
    expect(result.current.rootArchived).toBe(true)
  })
})
