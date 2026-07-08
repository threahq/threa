import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { BoardLens, BoardScopeStreamType } from "@threa/types"
import * as boardStoreModule from "@/stores/board-store"
import * as graphModule from "./use-conversation-graph"
import type { CachedBoardPost } from "@/db"
import {
  reconcileStableView,
  useStableBoardView,
  type BoardExclusionState,
  type BoardViewFilter,
  type CommittedView,
} from "./use-stable-board-view"

/** Build a full filter from overrides — every axis off unless named. */
function filterOf(over: Partial<BoardViewFilter> = {}): BoardViewFilter {
  return {
    lens: "all",
    scope: null,
    types: null,
    excludeStreams: null,
    excludeTypes: null,
    labels: null,
    excludeLabels: null,
    showArchived: false,
    ...over,
  }
}

/** The default board view: everything, unscoped. */
const ALL: BoardViewFilter = filterOf()

function lensFilter(lens: BoardLens): BoardViewFilter {
  return filterOf({ lens })
}

function scopeFilter(ids: string[], lens: BoardLens = "all"): BoardViewFilter {
  return filterOf({ lens, scope: { key: [...ids].sort().join(","), ids: new Set(ids) } })
}

function typesFilter(types: BoardScopeStreamType[]): BoardViewFilter {
  return filterOf({ types: { key: [...types].sort().join(","), ids: new Set(types) } })
}

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

/** A post carrying the fields `matchesBoardLens` reads, for cross-lens tests. */
function lensPost(
  id: string,
  activityMs: number,
  opts: { status?: "active" | "stalled" | "resolved"; completenessScore?: number; hasCapturedMemo?: boolean }
): CachedBoardPost {
  const base = post(id, activityMs)
  return {
    ...base,
    hasCapturedMemo: opts.hasCapturedMemo ?? false,
    conversation: {
      ...base.conversation,
      status: opts.status ?? "active",
      completenessScore: opts.completenessScore ?? 5,
    },
  } as unknown as CachedBoardPost
}

/** A post anchored to a root stream, for mute tests. */
function streamPost(id: string, activityMs: number, rootStreamId: string): CachedBoardPost {
  return { ...post(id, activityMs), rootStreamId } as unknown as CachedBoardPost
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
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
    expect(result.current.isLoading).toBe(true)
    act(() => mockLive([]))
    rerender()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.posts).toEqual([])
  })

  it("holds order frozen and surfaces a fresh arrival as the new count", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
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
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
    act(() => result.current.revealNext())
    act(() => mockLive(feed(post("mine", 600), post("a", 300))))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(0)
  })

  it("reveals a post that already buffered before revealNext armed (the optimistic write landed first)", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
    // The optimistic IDB write lands and buffers BEFORE the send resolves and arms.
    act(() => mockLive(feed(post("mine", 600), post("a", 300))))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect(result.current.newCount).toBe(1)
    // Arming now flushes the already-buffered card instead of stranding it.
    act(() => result.current.revealNext())
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(0)
  })

  it("disarms revealNext after its window, so a later unrelated arrival buffers", () => {
    vi.useFakeTimers()
    try {
      mockLive(feed(post("a", 300)))
      const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
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
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL))
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
    const { result, rerender } = renderHook(({ ws }) => useStableBoardView(ws, ALL), {
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
    const { result } = renderHook(() => useStableBoardView("ws_1", lensFilter("decisions")))
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })

  it("resets the committed view when the lens changes", () => {
    const withMemo = { ...post("m", 300), hasCapturedMemo: true } as CachedBoardPost
    const plain = { ...post("a", 250), hasCapturedMemo: false } as CachedBoardPost
    mockLive(feed(withMemo, plain))
    const { result, rerender } = renderHook(({ lens }) => useStableBoardView("ws_1", lensFilter(lens)), {
      initialProps: { lens: "all" as BoardLens },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["m", "a"])
    rerender({ lens: "decisions" })
    // Fresh frozen view for the new lens — only the captured-memo card, not the
    // previous lens's committed order.
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })

  it("commits the new lens's feed wholesale across disjoint subsets — no stranding behind the pill", () => {
    // The bug this guards: switching between two lenses with disjoint subsets where
    // a fresh card of the new lens sits ABOVE the old lens's committed floor. `s`
    // is the only Needs-resolution card (floor 300); `d` is a Decisions card above
    // it (400) that isn't a Needs-resolution card. Reconciling `d` against the
    // stale `{s}` committed strands it behind an empty "N new" pill; folding the
    // reset into the reconcile input commits `d` immediately instead.
    const stalled = lensPost("s", 300, { status: "stalled" })
    const decision = lensPost("d", 400, { hasCapturedMemo: true })
    mockLive(feed(stalled, decision))
    const { result, rerender } = renderHook(({ lens }) => useStableBoardView("ws_1", lensFilter(lens)), {
      initialProps: { lens: "needs-resolution" as BoardLens },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])
    rerender({ lens: "decisions" })
    expect(result.current.posts.map((p) => p.id)).toEqual(["d"])
    expect(result.current.newCount).toBe(0)
  })

  it("buffers a fresh new-lens arrival after a mixing-prone switch — no phantom absorption", () => {
    // Guards the "mixing ids" path the fix names: on the switch a new-lens card
    // sits BELOW the old lens's floor, so reconciling against the STALE committed
    // (the pre-fix bug) mixes the old id into `committed.order`. That phantom id
    // then silently absorbs the SAME conversation when it later qualifies for the
    // new lens (classified "already committed"), so its fresh arrival never shows
    // behind the "N new" pill. Feeding the reset (EMPTY_VIEW) into the reconcile
    // leaves no phantom, so the later arrival buffers. Fails on the pre-fix code.
    const stalled = lensPost("s", 300, { status: "stalled" }) // needs-resolution only
    const decisionLow = lensPost("x", 200, { hasCapturedMemo: true }) // decisions, below s's floor
    mockLive(feed(stalled, decisionLow))
    const { result, rerender } = renderHook(({ lens }) => useStableBoardView("ws_1", lensFilter(lens)), {
      initialProps: { lens: "needs-resolution" as BoardLens },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])

    rerender({ lens: "decisions" })
    expect(result.current.posts.map((p) => p.id)).toEqual(["x"])

    // `s` gains a memo with fresh activity — a genuine new arrival on decisions.
    const stalledWithMemo = lensPost("s", 500, { status: "stalled", hasCapturedMemo: true })
    act(() => mockLive(feed(stalledWithMemo, decisionLow)))
    rerender({ lens: "decisions" })
    // The fresh `s` waits behind the pill; it is not absorbed in-place.
    expect(result.current.newCount).toBe(1)
    expect(result.current.posts.map((p) => p.id)).toEqual(["x"])
  })

  it("keeps an acted-on card in place when it stops matching the lens (never yanked)", () => {
    // The steer this encodes: replying to a Needs-resolution card makes it fresh,
    // so it stops MATCHING the lens — but a filter must never yank what's on
    // screen. The committed card keeps rendering (retained) until the viewer
    // commits a fresh view themselves.
    const stalled = lensPost("s", 300, { status: "stalled" })
    const idle = lensPost("i", 200, { status: "stalled" })
    mockLive(feed(stalled, idle))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", lensFilter("needs-resolution")))
    expect(result.current.posts.map((p) => p.id)).toEqual(["s", "i"])

    // The viewer replies to `s`: fresh activity, status back to active — it no
    // longer matches the lens.
    act(() => mockLive(feed(lensPost("s", 900, { status: "active" }), idle)))
    rerender()
    // Still rendered in place, and not counted as "new".
    expect(result.current.posts.map((p) => p.id)).toEqual(["s", "i"])
    expect(result.current.newCount).toBe(0)

    // An explicit commit re-snapshots the lens's own subset.
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["i"])
  })

  it("keeps the reveal arm across a filter reset — posting from a filtered view reveals on All", () => {
    // Posting from a filtered board navigates back to the All home (the new post
    // might not match the filter); the reveal armed by the post must survive that
    // reset so the authored card surfaces instead of hiding behind its own pill.
    const stalled = lensPost("s", 300, { status: "stalled" })
    mockLive(feed(stalled))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter), {
      initialProps: { filter: lensFilter("needs-resolution") },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])

    act(() => result.current.revealNext())
    rerender({ filter: ALL })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])

    // The authored post lands after the fresh view's wholesale commit.
    act(() => mockLive(feed(lensPost("mine", 900, { status: "active" }), stalled)))
    rerender({ filter: ALL })
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "s"])
    expect(result.current.newCount).toBe(0)
  })

  function scopedPost(id: string, activityMs: number, rootStreamId: string): CachedBoardPost {
    return { ...post(id, activityMs), rootStreamId } as CachedBoardPost
  }

  it("shows only posts whose root stream is in scope", () => {
    const inScope = scopedPost("a", 300, "stream_root")
    const threadUnderScope = scopedPost("t", 250, "stream_root")
    const outOfScope = scopedPost("z", 400, "stream_other")
    mockLive(feed(inScope, threadUnderScope, outOfScope))
    const { result } = renderHook(() => useStableBoardView("ws_1", scopeFilter(["stream_root"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "t"])
  })

  it("falls back to the anchor stream id for cached rows without rootStreamId", () => {
    const legacy = {
      ...post("l", 300),
      conversation: { ...post("l", 300).conversation, streamId: "stream_root" },
    } as CachedBoardPost
    mockLive(feed(legacy))
    const { result } = renderHook(() => useStableBoardView("ws_1", scopeFilter(["stream_root"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["l"])
  })

  function typedPost(id: string, activityMs: number, rootStreamType: BoardScopeStreamType): CachedBoardPost {
    return { ...post(id, activityMs), rootStreamType } as CachedBoardPost
  }

  it("shows only posts whose ROOT stream type is in the type scope", () => {
    const channelPost = typedPost("c", 300, "channel")
    // A thread-anchored conversation carries its root's type — never `thread`.
    const threadUnderChannel = typedPost("t", 250, "channel")
    const dmPost = typedPost("d", 400, "dm")
    mockLive(feed(channelPost, threadUnderChannel, dmPost))
    const { result } = renderHook(() => useStableBoardView("ws_1", typesFilter(["channel"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["c", "t"])
  })

  it("fails open for cached rows without rootStreamType — the board surfaces, never hides", () => {
    const legacy = post("l", 300) // no rootStreamType field
    mockLive(feed(legacy))
    const { result } = renderHook(() => useStableBoardView("ws_1", typesFilter(["dm"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["l"])
  })

  it("resets the committed view when the type scope changes", () => {
    const channelPost = typedPost("c", 300, "channel")
    const dmPost = typedPost("d", 400, "dm")
    mockLive(feed(channelPost, dmPost))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter), {
      initialProps: { filter: typesFilter(["channel"]) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["c"])
    rerender({ filter: typesFilter(["dm"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["d"])
    expect(result.current.newCount).toBe(0)
  })

  it("folds a branch conversation into its visible parent — one card, effective activity, folded streams", () => {
    // parent (anchor "root", member m1) is forked by child (anchor thread "t1"
    // off m1). The child is newer (900) than the unrelated "other" (500).
    const base = post("parent", 300)
    const parent = {
      ...base,
      streamIds: ["root"],
      conversation: { ...base.conversation, streamId: "root", messageIds: ["m1"] },
    } as CachedBoardPost
    const childBase = post("child", 900)
    const child = {
      ...childBase,
      streamIds: ["t1"],
      conversation: { ...childBase.conversation, streamId: "t1", messageIds: ["c1"] },
    } as CachedBoardPost
    const other = post("other", 500)

    const threadRow = { id: "t1", type: "thread", parentStreamId: "root", parentMessageId: "m1", rootStreamId: "root" }
    vi.spyOn(graphModule, "useStreamStructuralIndex").mockReturnValue({
      streamsById: new Map([["t1", threadRow]]),
      threadsByParentMessageId: new Map([["m1", threadRow]]),
    } as unknown as ReturnType<typeof graphModule.useStreamStructuralIndex>)
    vi.spyOn(graphModule, "useConversationGraph").mockReturnValue({
      conversationByAnchorStreamId: new Map([["t1", child]]),
      conversationIdByMemberMessageId: new Map([
        ["m1", "parent"],
        ["c1", "child"],
      ]),
      conversationById: new Map([
        ["parent", parent],
        ["child", child],
        ["other", other],
      ]),
    } as unknown as ReturnType<typeof graphModule.useConversationGraph>)

    mockLive(feed(child, other, parent))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL))
    // One card per root discussion: the child folds into the parent, whose
    // effective activity (900) now outranks "other" (500).
    expect(result.current.posts.map((p) => p.id)).toEqual(["parent", "other"])
    expect(result.current.newCount).toBe(0)
    // The rendered parent copy declares the folded child's streams (so the board
    // page's subscriptions still cover them) without mutating the cached post.
    expect(result.current.posts[0].streamIds).toEqual(expect.arrayContaining(["root", "t1"]))
    expect(parent.streamIds).toEqual(["root"])
    expect(parent._lastActivityMs).toBe(300)
  })

  it("keeps a branch standalone when its parent is filtered out of the view", () => {
    const childBase = post("child", 900)
    const child = {
      ...childBase,
      streamIds: ["t1"],
      conversation: { ...childBase.conversation, streamId: "t1", messageIds: ["c1"] },
    } as CachedBoardPost
    const base = post("parent", 300)
    const parent = {
      ...base,
      streamIds: ["root"],
      conversation: { ...base.conversation, streamId: "root", messageIds: ["m1"] },
    } as CachedBoardPost
    const threadRow = { id: "t1", type: "thread", parentStreamId: "root", parentMessageId: "m1", rootStreamId: "root" }
    vi.spyOn(graphModule, "useStreamStructuralIndex").mockReturnValue({
      streamsById: new Map([["t1", threadRow]]),
      threadsByParentMessageId: new Map([["m1", threadRow]]),
    } as unknown as ReturnType<typeof graphModule.useStreamStructuralIndex>)
    vi.spyOn(graphModule, "useConversationGraph").mockReturnValue({
      conversationByAnchorStreamId: new Map([["t1", child]]),
      conversationIdByMemberMessageId: new Map([
        ["m1", "parent"],
        ["c1", "child"],
      ]),
      conversationById: new Map([
        ["parent", parent],
        ["child", child],
      ]),
    } as unknown as ReturnType<typeof graphModule.useConversationGraph>)

    // The live feed holds only the child (its parent didn't match the filters):
    // never vanish content — the child stays a standalone card.
    mockLive(feed(child))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL))
    expect(result.current.posts.map((p) => p.id)).toEqual(["child"])
  })

  it("resets the committed view when the scope changes, not when it is re-created equal", () => {
    const a = scopedPost("a", 300, "stream_one")
    const b = scopedPost("b", 400, "stream_two")
    mockLive(feed(a, b))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter), {
      initialProps: { filter: scopeFilter(["stream_one"]) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])

    // A structurally-equal scope (same key, fresh Set identity) must NOT reset.
    act(() => mockLive(feed(scopedPost("a2", 500, "stream_one"), a, b)))
    rerender({ filter: scopeFilter(["stream_one"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect(result.current.newCount).toBe(1)

    // A different scope starts a fresh frozen view for its own subset.
    rerender({ filter: scopeFilter(["stream_two"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
    expect(result.current.newCount).toBe(0)
  })
})

describe("useStableBoardView — negative & label filters", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }
  afterEach(() => vi.restoreAllMocks())

  /** A post with distinct anchor and effective root, for anchor-or-root rules. */
  function anchoredPost(id: string, activityMs: number, anchorId: string, rootId: string): CachedBoardPost {
    const base = post(id, activityMs)
    return {
      ...base,
      rootStreamId: rootId,
      conversation: { ...base.conversation, streamId: anchorId },
    } as CachedBoardPost
  }

  function excludeStreamsFilter(ids: string[]): BoardViewFilter {
    return filterOf({ excludeStreams: { key: [...ids].sort().join(","), ids: new Set(ids) } })
  }

  function labelsFilter(key: string, streamIds: string[]): BoardViewFilter {
    return filterOf({ labels: { key, streamIds: new Set(streamIds) } })
  }

  function excludeLabelsFilter(key: string, streamIds: string[]): BoardViewFilter {
    return filterOf({ excludeLabels: { key, streamIds: new Set(streamIds) } })
  }

  it("vetoes by ROOT — a thread under an excluded channel drops with it", () => {
    const inChannel = anchoredPost("a", 300, "stream_gh", "stream_gh")
    const inThread = anchoredPost("t", 250, "thread_1", "stream_gh")
    const other = anchoredPost("z", 400, "stream_ok", "stream_ok")
    mockLive(feed(inChannel, inThread, other))
    const { result } = renderHook(() => useStableBoardView("ws_1", excludeStreamsFilter(["stream_gh"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("vetoes by ANCHOR — one thread can be excluded without dropping its channel", () => {
    const inChannel = anchoredPost("a", 300, "stream_c", "stream_c")
    const inThread = anchoredPost("t", 250, "thread_1", "stream_c")
    mockLive(feed(inChannel, inThread))
    const { result } = renderHook(() => useStableBoardView("ws_1", excludeStreamsFilter(["thread_1"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("exclusion wins over an include scope naming the same stream", () => {
    const a = anchoredPost("a", 300, "stream_x", "stream_x")
    mockLive(feed(a))
    const filter = filterOf({
      scope: { key: "stream_x", ids: new Set(["stream_x"]) },
      excludeStreams: { key: "stream_x", ids: new Set(["stream_x"]) },
    })
    const { result } = renderHook(() => useStableBoardView("ws_1", filter))
    expect(result.current.posts).toEqual([])
  })

  it("vetoes by ROOT type, failing open for cached rows without rootStreamType", () => {
    const dmPost = { ...post("d", 400), rootStreamType: "dm" } as CachedBoardPost
    const channelPost = { ...post("c", 300), rootStreamType: "channel" } as CachedBoardPost
    const legacy = post("l", 200) // no rootStreamType
    mockLive(feed(dmPost, channelPost, legacy))
    const filter = filterOf({ excludeTypes: { key: "dm", ids: new Set<BoardScopeStreamType>(["dm"]) } })
    const { result } = renderHook(() => useStableBoardView("ws_1", filter))
    expect(result.current.posts.map((p) => p.id)).toEqual(["c", "l"])
  })

  it("label scope keeps only posts whose anchor or root carries the label", () => {
    const onLabeledRoot = anchoredPost("a", 300, "thread_1", "stream_lab")
    const onLabeledAnchor = anchoredPost("b", 250, "stream_lab2", "stream_lab2")
    const unlabeled = anchoredPost("z", 400, "stream_plain", "stream_plain")
    mockLive(feed(onLabeledRoot, onLabeledAnchor, unlabeled))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", labelsFilter("label_x", ["stream_lab", "stream_lab2"]))
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("a label scope that resolves to no streams matches NOTHING, not everything", () => {
    mockLive(feed(post("a", 300)))
    const { result } = renderHook(() => useStableBoardView("ws_1", labelsFilter("label_x", [])))
    expect(result.current.posts).toEqual([])
    expect(result.current.hasRawPosts).toBe(true)
  })

  it("label veto drops labeled streams' posts and keeps the rest", () => {
    const labeled = anchoredPost("a", 300, "stream_code", "stream_code")
    const other = anchoredPost("z", 400, "stream_ok", "stream_ok")
    mockLive(feed(labeled, other))
    const { result } = renderHook(() => useStableBoardView("ws_1", excludeLabelsFilter("label_code", ["stream_code"])))
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("a label re-resolution (same selection) never resets the frozen view — the committed card is retained", () => {
    const a = anchoredPost("a", 300, "stream_a", "stream_a")
    const b = anchoredPost("b", 200, "stream_b", "stream_b")
    mockLive(feed(a, b))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter), {
      initialProps: { filter: excludeLabelsFilter("label_x", []) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // stream_a gets labeled while the view is open: same filter key, new
    // resolution. The card leaves the live feed but keeps rendering from the
    // retained committed view (filters narrow what surfaces, never yank), and
    // no pill appears.
    rerender({ filter: excludeLabelsFilter("label_x", ["stream_a"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect(result.current.newCount).toBe(0)

    // The next commit drops it.
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })
})

describe("useStableBoardView — hide & mute exclusions", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }
  afterEach(() => vi.restoreAllMocks())

  /** Build a full exclusion state from overrides — nothing excluded unless named. */
  function exclOf(over: Partial<BoardExclusionState> = {}): BoardExclusionState {
    return { hidden: new Map(), muted: new Set(), muteActive: true, ...over }
  }

  /** A post whose effective root the server flagged archived (`rootArchived`). */
  function archivedPost(id: string, activityMs: number, rootStreamId: string): CachedBoardPost {
    return { ...streamPost(id, activityMs, rootStreamId), rootArchived: true } as unknown as CachedBoardPost
  }

  const NO_EXCL = exclOf()

  it("drops a hidden card immediately — even after it was committed and retained (the crux)", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ excl }) => useStableBoardView("ws_1", ALL, excl), {
      initialProps: { excl: NO_EXCL },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // Hide "a" (watermark above its activity). It stays in the committed order and
    // in `retainedRef`, so a filter that only touched `live` would keep rendering
    // it — it must drop NOW, without a commit.
    rerender({ excl: exclOf({ hidden: new Map([["a", 400]]) }) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("revives a hidden card once its activity passes the watermark", () => {
    const excl = exclOf({ hidden: new Map([["a", 350]]) })
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(({ e }) => useStableBoardView("ws_1", ALL, e), {
      initialProps: { e: excl },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual([])

    act(() => mockLive(feed(post("a", 500))))
    rerender({ e: excl })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("drops a muted stream's cards when mute is active", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, exclOf({ muted: new Set(["stream_x"]) })))
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("keeps a muted stream's cards when mute is inactive (an explicit ?in= scope)", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", ALL, exclOf({ muted: new Set(["stream_x"]), muteActive: false }))
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("drops a `rootArchived` card while showArchived is off", () => {
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL))
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("keeps a `rootArchived` card once showArchived opts in", () => {
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() => useStableBoardView("ws_1", filterOf({ showArchived: true })))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("re-hides a `rootArchived` card the instant showArchived toggles back off — even once committed", () => {
    // The crux of the archived filter: a card seeded under `?archived=true` is
    // committed and retained; toggling archived off must drop it NOW (the server
    // won't re-seed it to evict it from IDB), driven purely by `post.rootArchived`.
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter), {
      initialProps: { filter: filterOf({ showArchived: true }) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    rerender({ filter: ALL })
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("reports hasRawPosts when the feed is seeded but every card is excluded (empty view, not loading)", () => {
    // Hiding the only card → posts empty, but the raw IDB feed is seeded, so the
    // board can show its empty state instead of a perpetual seed skeleton.
    mockLive(feed(post("a", 300)))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, exclOf({ hidden: new Map([["a", 400]]) })))
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.hasRawPosts).toBe(true)
  })
})
