import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { BoardLens } from "@threa/types"
import * as boardStoreModule from "@/stores/board-store"
import type { CachedBoardPost } from "@/db"
import { reconcileStableView, useStableBoardView, type CommittedView } from "./use-stable-board-view"

function post(id: string, activityMs: number): CachedBoardPost {
  return {
    id,
    workspaceId: "ws_1",
    _lastActivityMs: activityMs,
    _cachedAt: activityMs,
    conversation: { id, lastActivityAt: new Date(activityMs).toISOString() },
    openingMessage: null,
    recentMessages: [],
    totalReplies: 0,
  } as unknown as CachedBoardPost
}

/** Newest-first feed, matching what `useBoardPosts` returns. */
function feed(...posts: CachedBoardPost[]): CachedBoardPost[] {
  return [...posts].sort((a, b) => b._lastActivityMs - a._lastActivityMs)
}

function committedOf(...posts: CachedBoardPost[]): CommittedView {
  return {
    order: posts.map((p) => p.id),
    activityById: new Map(posts.map((p) => [p.id, p._lastActivityMs])),
  }
}

const EMPTY: CommittedView = { order: [], activityById: new Map() }

describe("reconcileStableView", () => {
  it("commits the live order wholesale on the first non-empty snapshot", () => {
    const live = feed(post("a", 300), post("b", 200))
    const { committed, buffered } = reconcileStableView(EMPTY, live)
    expect(committed.order).toEqual(["a", "b"])
    expect(buffered).toEqual([])
  })

  it("keeps the same empty reference for an empty feed (no churn)", () => {
    const result = reconcileStableView(EMPTY, [])
    expect(result.committed).toBe(EMPTY)
    expect(result.buffered).toEqual([])
  })

  it("buffers a fresh arrival above the floor instead of reordering", () => {
    const committed = committedOf(post("a", 300), post("b", 200))
    const live = feed(post("new", 500), post("a", 300), post("b", 200))
    const result = reconcileStableView(committed, live)
    // Order is frozen — the new card does NOT appear in it.
    expect(result.committed.order).toEqual(["a", "b"])
    expect(result.buffered).toEqual(["new"])
  })

  it("leaves a bumped seen card in place and out of the buffer", () => {
    const committed = committedOf(post("a", 300), post("b", 200))
    // "b" got bumped above "a" in the live feed, but it is already committed.
    const live = feed(post("b", 900), post("a", 300))
    const result = reconcileStableView(committed, live)
    expect(result.committed.order).toEqual(["a", "b"])
    expect(result.buffered).toEqual([])
  })

  it("appends older rows paged in below the floor without a pill", () => {
    const committed = committedOf(post("a", 300), post("b", 200))
    const live = feed(post("a", 300), post("b", 200), post("old1", 150), post("old2", 100))
    const result = reconcileStableView(committed, live)
    expect(result.committed.order).toEqual(["a", "b", "old1", "old2"])
    expect(result.buffered).toEqual([])
    expect(result.committed.activityById.get("old1")).toBe(150)
  })

  it("splits a mixed update into buffer (new) and append (older)", () => {
    const committed = committedOf(post("a", 300), post("b", 200))
    const live = feed(post("new", 500), post("a", 300), post("b", 200), post("old", 100))
    const result = reconcileStableView(committed, live)
    expect(result.committed.order).toEqual(["a", "b", "old"])
    expect(result.buffered).toEqual(["new"])
  })
})

describe("useStableBoardView", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }

  afterEach(() => vi.restoreAllMocks())

  it("reports loading until the IDB read resolves, then the empty state", () => {
    mockLive(undefined)
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", "active"))
    expect(result.current.isLoading).toBe(true)
    act(() => mockLive([]))
    rerender()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.posts).toEqual([])
  })

  it("holds order frozen and surfaces a fresh arrival as the new count", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", "active"))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    act(() => mockLive(feed(post("new", 500), post("a", 300), post("b", 200))))
    rerender()
    // The card stays out of view; only the count moves.
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect(result.current.newCount).toBe(1)

    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["new", "a", "b"])
    expect(result.current.newCount).toBe(0)
  })

  it("auto-reveals on the next arrival when revealNext is armed (the viewer's own post)", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", "active"))
    act(() => result.current.revealNext())
    act(() => mockLive(feed(post("mine", 600), post("a", 300))))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(0)
  })

  it("disarms revealNext after its window, so a later unrelated arrival buffers", () => {
    vi.useFakeTimers()
    try {
      mockLive(feed(post("a", 300)))
      const { result, rerender } = renderHook(() => useStableBoardView("ws_1", "active"))
      act(() => result.current.revealNext())
      // Nothing arrived within the window; the arm expires.
      act(() => vi.advanceTimersByTime(8001))
      act(() => mockLive(feed(post("late", 600), post("a", 300))))
      rerender()
      // The stale arm did not fire — the late arrival waits behind the pill.
      expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
      expect(result.current.newCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a vanished committed card rendering in place until the next commit", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", "active"))
    // "b" loses access / is deleted — it drops out of the live feed.
    act(() => mockLive(feed(post("a", 300))))
    rerender()
    // Still rendered (last-known content), so nothing below it shifts.
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    // A commit drops it.
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("resets the committed view when the workspace changes", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(({ ws }) => useStableBoardView(ws, "active"), {
      initialProps: { ws: "ws_1" },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    act(() => mockLive(feed(post("z", 900))))
    rerender({ ws: "ws_2" })
    // Fresh snapshot for the new workspace, not the old order.
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("shows only the lens's matching cards — decisions keeps captured-memo posts", () => {
    const withMemo = { ...post("m", 300), hasCapturedMemo: true } as CachedBoardPost
    const without = { ...post("n", 200), hasCapturedMemo: false } as CachedBoardPost
    mockLive(feed(withMemo, without))
    const { result } = renderHook(() => useStableBoardView("ws_1", "decisions"))
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })

  it("resets the committed view when the lens changes", () => {
    const withMemo = { ...post("m", 300), hasCapturedMemo: true } as CachedBoardPost
    const plain = { ...post("a", 250), hasCapturedMemo: false } as CachedBoardPost
    mockLive(feed(withMemo, plain))
    const { result, rerender } = renderHook(({ lens }) => useStableBoardView("ws_1", lens), {
      initialProps: { lens: "active" as BoardLens },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["m", "a"])
    rerender({ lens: "decisions" })
    // Fresh frozen view for the new lens — only the captured-memo card, not the
    // previous lens's committed order.
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })
})
