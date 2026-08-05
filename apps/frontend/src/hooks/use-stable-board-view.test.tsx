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
  type BoardSeedState,
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
    unread: null,
    drafts: null,
    showArchived: false,
    archivedRootIds: new Set<string>(),
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

function unreadFilter(streamIds: string[]): BoardViewFilter {
  return filterOf({ unread: { key: "true", streamIds: new Set(streamIds) } })
}

function draftsFilter(conversationIds: string[], subtopicMessageIds: string[] = []): BoardViewFilter {
  return filterOf({
    drafts: {
      key: "true",
      conversationIds: new Set(conversationIds),
      subtopicMessageIds: new Set(subtopicMessageIds),
    },
  })
}

/** A post whose conversation carries these message ids (sub-topic draft match). */
function messagesPost(id: string, activityMs: number, messageIds: string[]): CachedBoardPost {
  const base = post(id, activityMs)
  return { ...base, conversation: { ...base.conversation, messageIds } } as unknown as CachedBoardPost
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

/** The viewer's own optimistic post — `_status: "pending"`, as `putOptimisticBoardPost` writes it. */
function pendingPost(id: string, activityMs: number): CachedBoardPost {
  return { ...post(id, activityMs), _status: "pending" } as unknown as CachedBoardPost
}

/** A post carrying the fields `matchesBoardLens` reads, for cross-lens tests. */
function lensPost(
  id: string,
  activityMs: number,
  opts: {
    status?: "active" | "stalled" | "resolved"
    completenessScore?: number
    isMine?: boolean
  }
): CachedBoardPost {
  const base = post(id, activityMs)
  return {
    ...base,
    isMine: opts.isMine ?? false,
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
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    expect(result.current.isLoading).toBe(true)
    act(() => mockLive([]))
    rerender()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.posts).toEqual([])
  })

  it("holds order frozen and surfaces a fresh arrival as the new count", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
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

  it("reveals the viewer's own pending post at top the moment it lands", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    act(() => mockLive(feed(pendingPost("mine", 600), post("a", 300))))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(0)
  })

  it("reveals a pending post that materializes arbitrarily later (a queued scratchpad send), no arm window", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    // An unrelated arrival buffers first; then, much later (past any old 8s arm),
    // the viewer's own scratchpad card finally lands from the drain.
    act(() => mockLive(feed(post("other", 500), post("a", 300))))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect(result.current.newCount).toBe(1)
    act(() => mockLive(feed(pendingPost("mine", 900), post("other", 500), post("a", 300))))
    rerender()
    // The own card reveals at top; the unrelated arrival stays behind the pill.
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(1)
  })

  it("reveals ONLY the viewer's own pending card, leaving other users' arrivals buffered", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    // Two unrelated new conversations accumulate, then the viewer posts.
    act(() => mockLive(feed(pendingPost("mine", 900), post("x", 700), post("y", 600), post("a", 300))))
    rerender()
    // Posting doesn't flush x/y — they stay behind the pill; only "mine" surfaces.
    expect(result.current.posts.map((p) => p.id)).toEqual(["mine", "a"])
    expect(result.current.newCount).toBe(2)
  })

  it("marks a committed card that left the raw feed as removed, keeping its slot until the next commit", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    // "b" is merged away / emptied — its IDB row is gone.
    act(() => mockLive(feed(post("a", 300))))
    rerender()
    // Still occupying its slot, so nothing below it shifts, but marked so the
    // feed draws a stub instead of an interactive card.
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect([...result.current.removedIds]).toEqual(["b"])
    // A commit drops it.
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect([...result.current.removedIds]).toEqual([])
  })

  it("resolves the successor holding a removed card's opening message", () => {
    const ghost = {
      ...post("b", 200),
      openingMessage: { id: "m_open" },
    } as unknown as CachedBoardPost
    mockLive(feed(post("a", 300), ghost))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    // "b" merged into "c", which now carries its opening message.
    const successor = {
      ...post("c", 400),
      conversation: {
        id: "c",
        lastActivityAt: new Date(400).toISOString(),
        messageIds: ["m_open"],
        topicSummary: "Deploy plan",
      },
    } as unknown as CachedBoardPost
    act(() => mockLive(feed(post("a", 300), successor)))
    rerender()
    expect([...result.current.removedIds]).toEqual(["b"])
    expect(result.current.removedSuccessorById.get("b")).toEqual({
      conversationId: "c",
      topicSummary: "Deploy plan",
    })
  })

  it("reports no successor when nothing holds the removed card's opening message", () => {
    const ghost = { ...post("b", 200), openingMessage: { id: "m_open" } } as unknown as CachedBoardPost
    mockLive(feed(post("a", 300), ghost))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    act(() => mockLive(feed(post("a", 300))))
    rerender()
    expect([...result.current.removedIds]).toEqual(["b"])
    expect(result.current.removedSuccessorById.get("b")).toBeNull()
  })

  it("does not mark a committed card that is merely filtered out of the live subset", () => {
    const mine = { ...post("m", 300), isMine: true } as CachedBoardPost
    const plain = { ...post("a", 200), isMine: true } as CachedBoardPost
    mockLive(feed(mine, plain))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", lensFilter("mine"), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["m", "a"])
    // "a" stops matching the lens but its row is still in the raw feed.
    act(() => mockLive(feed(mine, { ...plain, isMine: false } as CachedBoardPost)))
    rerender()
    expect(result.current.posts.map((p) => p.id)).toEqual(["m", "a"])
    expect([...result.current.removedIds]).toEqual([])
  })

  it("resets the committed view when the workspace changes", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(({ ws }) => useStableBoardView(ws, ALL, undefined, undefined), {
      initialProps: { ws: "ws_1" },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    act(() => mockLive(feed(post("z", 900))))
    rerender({ ws: "ws_2" })
    // Fresh snapshot for the new workspace, not the old order.
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("shows only the lens's matching cards — mine keeps the viewer's own posts", () => {
    const mine = { ...post("m", 300), isMine: true } as CachedBoardPost
    const other = { ...post("n", 200), isMine: false } as CachedBoardPost
    mockLive(feed(mine, other))
    const { result } = renderHook(() => useStableBoardView("ws_1", lensFilter("mine"), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })

  it("resets the committed view when the lens changes", () => {
    const mine = { ...post("m", 300), isMine: true } as CachedBoardPost
    const plain = { ...post("a", 250), isMine: false } as CachedBoardPost
    mockLive(feed(mine, plain))
    const { result, rerender } = renderHook(
      ({ lens }) => useStableBoardView("ws_1", lensFilter(lens), undefined, undefined),
      {
        initialProps: { lens: "all" as BoardLens },
      }
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["m", "a"])
    rerender({ lens: "mine" })
    // Fresh frozen view for the new lens — only the viewer's own card, not the
    // previous lens's committed order.
    expect(result.current.posts.map((p) => p.id)).toEqual(["m"])
  })

  it("commits the new view's feed wholesale across disjoint subsets — no stranding behind the pill", () => {
    // The bug this guards: switching between two views with disjoint subsets where
    // a fresh card of the new view sits ABOVE the old view's committed floor. `s`
    // is the only Mine card (floor 300, in chan_a); `d` sits above it (400) in
    // chan_b and isn't a Mine card. Reconciling `d` against the stale `{s}`
    // committed strands it behind an empty "N new" pill; folding the reset into
    // the reconcile input commits `d` immediately instead.
    const mine = { ...lensPost("s", 300, { isMine: true }), rootStreamId: "chan_a" } as CachedBoardPost
    const other = { ...lensPost("d", 400, {}), rootStreamId: "chan_b" } as CachedBoardPost
    mockLive(feed(mine, other))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: lensFilter("mine") },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])
    rerender({ filter: scopeFilter(["chan_b"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["d"])
    expect(result.current.newCount).toBe(0)
  })

  it("buffers a fresh new-view arrival after a mixing-prone switch — no phantom absorption", () => {
    // Guards the "mixing ids" path the fix names: on the switch a new-view card
    // sits BELOW the old view's floor, so reconciling against the STALE committed
    // (the pre-fix bug) mixes the old id into `committed.order`. That phantom id
    // then silently absorbs the SAME conversation when it later qualifies for the
    // new view (classified "already committed"), so its fresh arrival never shows
    // behind the "N new" pill. Feeding the reset (EMPTY_VIEW) into the reconcile
    // leaves no phantom, so the later arrival buffers. Fails on the pre-fix code.
    const scoped = { ...lensPost("s", 300, {}), rootStreamId: "chan_a" } as CachedBoardPost // chan_a only
    const mineLow = { ...lensPost("x", 200, { isMine: true }), rootStreamId: "chan_b" } as CachedBoardPost // mine, below s's floor
    mockLive(feed(scoped, mineLow))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: scopeFilter(["chan_a"]) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])

    rerender({ filter: lensFilter("mine") })
    expect(result.current.posts.map((p) => p.id)).toEqual(["x"])

    // The viewer is `@`-mentioned on `s` with fresh activity — a genuine new
    // arrival on Mine.
    const nowMine = { ...lensPost("s", 500, { isMine: true }), rootStreamId: "chan_a" } as CachedBoardPost
    act(() => mockLive(feed(nowMine, mineLow)))
    rerender({ filter: lensFilter("mine") })
    // The fresh `s` waits behind the pill; it is not absorbed in-place.
    expect(result.current.newCount).toBe(1)
    expect(result.current.posts.map((p) => p.id)).toEqual(["x"])
  })

  it("keeps an acted-on card in place when it stops matching the lens (never yanked)", () => {
    // The steer this encodes: a card can stop MATCHING the lens after an update
    // (here the mention that made it the viewer's is deleted, so it leaves Mine)
    // — but a filter must never yank what's on screen. The committed card keeps
    // rendering (retained) until the viewer commits a fresh view themselves.
    const mine = lensPost("s", 300, { isMine: true })
    const idle = lensPost("i", 200, { isMine: true })
    mockLive(feed(mine, idle))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", lensFilter("mine"), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["s", "i"])

    // The mention on `s` is deleted with fresh activity — it no longer matches.
    act(() => mockLive(feed(lensPost("s", 900, { isMine: false }), idle)))
    rerender()
    // Still rendered in place, and not counted as "new".
    expect(result.current.posts.map((p) => p.id)).toEqual(["s", "i"])
    expect(result.current.newCount).toBe(0)

    // An explicit commit re-snapshots the lens's own subset.
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["i"])
  })

  it("reveals the viewer's own pending post after a filter reset (posting from a filtered view)", () => {
    // Posting from a filtered board navigates back to the All home (the new post
    // might not match the filter); the pending optimistic card reveals itself at
    // top there via reconcile, no arm to carry across the reset.
    const mine = lensPost("s", 300, { isMine: true })
    mockLive(feed(mine))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: lensFilter("mine") },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["s"])

    // Navigate to All, then the authored card lands after the fresh view's commit.
    rerender({ filter: ALL })
    act(() => mockLive(feed(pendingPost("own", 900), mine)))
    rerender({ filter: ALL })
    expect(result.current.posts.map((p) => p.id)).toEqual(["own", "s"])
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
    const { result } = renderHook(() => useStableBoardView("ws_1", scopeFilter(["stream_root"]), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "t"])
  })

  it("falls back to the anchor stream id for cached rows without rootStreamId", () => {
    const legacy = {
      ...post("l", 300),
      conversation: { ...post("l", 300).conversation, streamId: "stream_root" },
    } as CachedBoardPost
    mockLive(feed(legacy))
    const { result } = renderHook(() => useStableBoardView("ws_1", scopeFilter(["stream_root"]), undefined, undefined))
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
    const { result } = renderHook(() => useStableBoardView("ws_1", typesFilter(["channel"]), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["c", "t"])
  })

  it("fails open for cached rows without rootStreamType — the board surfaces, never hides", () => {
    const legacy = post("l", 300) // no rootStreamType field
    mockLive(feed(legacy))
    const { result } = renderHook(() => useStableBoardView("ws_1", typesFilter(["dm"]), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["l"])
  })

  it("resets the committed view when the type scope changes", () => {
    const channelPost = typedPost("c", 300, "channel")
    const dmPost = typedPost("d", 400, "dm")
    mockLive(feed(channelPost, dmPost))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
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
      threadsByAnchorId: new Map([["m1", threadRow]]),
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
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
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
      threadsByAnchorId: new Map([["m1", threadRow]]),
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
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["child"])
  })

  it("resets the committed view when the scope changes, not when it is re-created equal", () => {
    const a = scopedPost("a", 300, "stream_one")
    const b = scopedPost("b", 400, "stream_two")
    mockLive(feed(a, b))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
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
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", excludeStreamsFilter(["stream_gh"]), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("vetoes by ANCHOR — one thread can be excluded without dropping its channel", () => {
    const inChannel = anchoredPost("a", 300, "stream_c", "stream_c")
    const inThread = anchoredPost("t", 250, "thread_1", "stream_c")
    mockLive(feed(inChannel, inThread))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", excludeStreamsFilter(["thread_1"]), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("exclusion wins over an include scope naming the same stream", () => {
    const a = anchoredPost("a", 300, "stream_x", "stream_x")
    mockLive(feed(a))
    const filter = filterOf({
      scope: { key: "stream_x", ids: new Set(["stream_x"]) },
      excludeStreams: { key: "stream_x", ids: new Set(["stream_x"]) },
    })
    const { result } = renderHook(() => useStableBoardView("ws_1", filter, undefined, undefined))
    expect(result.current.posts).toEqual([])
  })

  it("vetoes by ROOT type, failing open for cached rows without rootStreamType", () => {
    const dmPost = { ...post("d", 400), rootStreamType: "dm" } as CachedBoardPost
    const channelPost = { ...post("c", 300), rootStreamType: "channel" } as CachedBoardPost
    const legacy = post("l", 200) // no rootStreamType
    mockLive(feed(dmPost, channelPost, legacy))
    const filter = filterOf({ excludeTypes: { key: "dm", ids: new Set<BoardScopeStreamType>(["dm"]) } })
    const { result } = renderHook(() => useStableBoardView("ws_1", filter, undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["c", "l"])
  })

  it("label scope keeps only posts whose anchor or root carries the label", () => {
    const onLabeledRoot = anchoredPost("a", 300, "thread_1", "stream_lab")
    const onLabeledAnchor = anchoredPost("b", 250, "stream_lab2", "stream_lab2")
    const unlabeled = anchoredPost("z", 400, "stream_plain", "stream_plain")
    mockLive(feed(onLabeledRoot, onLabeledAnchor, unlabeled))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", labelsFilter("label_x", ["stream_lab", "stream_lab2"]), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("a label scope that resolves to no streams matches NOTHING, not everything", () => {
    mockLive(feed(post("a", 300)))
    const { result } = renderHook(() => useStableBoardView("ws_1", labelsFilter("label_x", []), undefined, undefined))
    expect(result.current.posts).toEqual([])
    expect(result.current.hasRawPosts).toBe(true)
  })

  it("label veto drops labeled streams' posts and keeps the rest", () => {
    const labeled = anchoredPost("a", 300, "stream_code", "stream_code")
    const other = anchoredPost("z", 400, "stream_ok", "stream_ok")
    mockLive(feed(labeled, other))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", excludeLabelsFilter("label_code", ["stream_code"]), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["z"])
  })

  it("a label re-resolution (same selection) never resets the frozen view — the committed card is retained", () => {
    const a = anchoredPost("a", 300, "stream_a", "stream_a")
    const b = anchoredPost("b", 200, "stream_b", "stream_b")
    mockLive(feed(a, b))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
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

  /** A card cached while its root was still active — the stale-flag shape. */
  function staleActivePost(id: string, activityMs: number, rootStreamId: string): CachedBoardPost {
    return { ...streamPost(id, activityMs, rootStreamId), rootArchived: false } as unknown as CachedBoardPost
  }

  const NO_EXCL = exclOf()

  it("drops a hidden card immediately — even after it was committed and retained (the crux)", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ excl }) => useStableBoardView("ws_1", ALL, excl, undefined), {
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
    const { result, rerender } = renderHook(({ e }) => useStableBoardView("ws_1", ALL, e, undefined), {
      initialProps: { e: excl },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual([])

    act(() => mockLive(feed(post("a", 500))))
    rerender({ e: excl })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("drops a muted stream's cards when mute is active", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", ALL, exclOf({ muted: new Set(["stream_x"]) }), undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("keeps a muted stream's cards when mute is inactive (an explicit ?in= scope)", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", ALL, exclOf({ muted: new Set(["stream_x"]), muteActive: false }), undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("drops a `rootArchived` card while showArchived is off", () => {
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("keeps a `rootArchived` card once showArchived opts in", () => {
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", filterOf({ showArchived: true }), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("re-hides a `rootArchived` card the instant showArchived toggles back off — even once committed", () => {
    // The crux of the archived filter: a card seeded under `?archived=true` is
    // committed and retained; toggling archived off must drop it NOW (the server
    // won't re-seed it to evict it from IDB), driven purely by `post.rootArchived`.
    mockLive(feed(archivedPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: filterOf({ showArchived: true }) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    rerender({ filter: ALL })
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("vetoes a stale card whose root is archived in the local stream index", () => {
    // `rootArchived: undefined` (cached before the flag existed) and
    // `rootArchived: false` (cached before the root was archived) both fail open
    // on the per-card flag alone — the server never re-seeds an archived
    // conversation, so the veto has to come from the fresher stream index.
    mockLive(
      feed(streamPost("a", 300, "stream_x"), staleActivePost("b", 200, "stream_y"), streamPost("c", 100, "stream_z"))
    )
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", filterOf({ archivedRootIds: new Set(["stream_x", "stream_y"]) }), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["c"])
  })

  it("keeps stale-flag cards whose root is archived once showArchived opts in", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), staleActivePost("b", 200, "stream_y")))
    const { result } = renderHook(() =>
      useStableBoardView(
        "ws_1",
        filterOf({ showArchived: true, archivedRootIds: new Set(["stream_x", "stream_y"]) }),
        undefined,
        undefined
      )
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
  })

  it("keeps a `rootArchived: false` card whose root is not in the archived index", () => {
    mockLive(feed(staleActivePost("a", 300, "stream_x")))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", filterOf({ archivedRootIds: new Set(["stream_other"]) }), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("drops a committed card the instant its root joins the archived index", () => {
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: filterOf() },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // A fresh arrival waits behind the "N new" pill — the reader's view is frozen.
    act(() =>
      mockLive(
        feed(streamPost("new", 500, "stream_y"), streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y"))
      )
    )
    rerender({ filter: filterOf() })
    expect(result.current.newCount).toBe(1)

    rerender({ filter: filterOf({ archivedRootIds: new Set(["stream_x"]) }) })
    // Dropped instantly, and the frozen view is NOT reset: the buffered card is
    // still behind the pill (a view-key reset would have committed it).
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
    expect(result.current.newCount).toBe(1)
  })

  it("reports hasRawPosts when the feed is seeded but every card is excluded (empty view, not loading)", () => {
    // Hiding the only card → posts empty, but the raw IDB feed is seeded, so the
    // board can show its empty state instead of a perpetual seed skeleton.
    mockLive(feed(post("a", 300)))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", ALL, exclOf({ hidden: new Map([["a", 400]]) }), undefined)
    )
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.hasRawPosts).toBe(true)
  })
})

describe("useStableBoardView — unread filter", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }
  afterEach(() => vi.restoreAllMocks())

  it("shows only posts on an unread root stream, falling back to the anchor stream id without one", () => {
    // No `rootStreamId` — falls back to `conversation.streamId` (the anchor).
    const legacy = {
      ...post("c", 100),
      conversation: { ...post("c", 100).conversation, streamId: "stream_anchor" },
    } as CachedBoardPost
    mockLive(feed(streamPost("a", 300, "stream_unread"), streamPost("b", 200, "stream_read"), legacy))
    const { result } = renderHook(() =>
      useStableBoardView("ws_1", unreadFilter(["stream_unread", "stream_anchor"]), undefined, undefined)
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "c"])
  })

  it("drops a card immediately once its stream leaves the unread set — even after commit (the crux)", () => {
    // Mirrors the hide/mute crux: a committed, retained card must not linger
    // just because it's no longer in `live` — reading it while sitting on
    // `?unread=true` is a voluntary action, same class as hide/mute.
    mockLive(feed(streamPost("a", 300, "stream_x"), streamPost("b", 200, "stream_y")))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: unreadFilter(["stream_x", "stream_y"]) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // "stream_x" gets read — its id drops out of the live unread set. No commit.
    rerender({ filter: unreadFilter(["stream_y"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
  })

  it("a live unread re-resolution (same `?unread=true` selection) never resets the frozen view", () => {
    mockLive(feed(streamPost("a", 300, "stream_x")))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: unreadFilter(["stream_x"]) },
    })
    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])

    // A second, unread-adjacent stream becoming unread doesn't touch "a"'s
    // committed position — the `key` (not the resolved ids) is the view-reset
    // key, mirroring the label-scope re-resolution guarantee.
    rerender({ filter: unreadFilter(["stream_x", "stream_other"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })
})

describe("useStableBoardView — drafts filter", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }
  afterEach(() => vi.restoreAllMocks())

  it("shows only conversations carrying a draft", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result } = renderHook(() => useStableBoardView("ws_1", draftsFilter(["a"]), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("matches a conversation whose message carries a sub-topic draft", () => {
    mockLive(feed(messagesPost("a", 300, ["msg_1", "msg_2"]), messagesPost("b", 200, ["msg_3"])))
    const { result } = renderHook(() => useStableBoardView("ws_1", draftsFilter([], ["msg_2"]), undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
  })

  it("renders a resolved-draft card with the removal treatment in place, then drops it on the next commit", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: draftsFilter(["a", "b"]) },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // "a"'s draft resolves DURING the send: it sheds immediately, but through
    // the removal path — the row keeps its slot and its mounted subtree (the
    // composer that is still sending) instead of vanishing mid-send. "b" still
    // carries a draft and stays live.
    rerender({ filter: draftsFilter(["b"]) })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect([...result.current.removedIds]).toEqual(["a"])
    expect([...result.current.draftResolvedIds]).toEqual(["a"])
    // Still in the raw feed, so no merge successor is claimed for it.
    expect(result.current.removedSuccessorById.has("a")).toBe(false)

    act(() => result.current.commit())
    expect(result.current.posts.map((p) => p.id)).toEqual(["b"])
    expect(result.current.removedIds.size).toBe(0)
  })

  it("a drafts re-resolution (same `?drafts=true` selection) never resets the frozen view", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(({ filter }) => useStableBoardView("ws_1", filter, undefined, undefined), {
      initialProps: { filter: draftsFilter(["a"]) },
    })
    act(() => result.current.commit())

    act(() => mockLive(feed(post("new", 500), post("a", 300))))
    rerender({ filter: draftsFilter(["a", "new"]) })
    // Still frozen: the newcomer waits behind the pill instead of a view reset
    // committing it wholesale.
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect(result.current.newCount).toBe(1)
  })
})

describe("useStableBoardView seed gate", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }

  afterEach(() => vi.restoreAllMocks())

  it("holds the stale feed until the seeded rows LAND in the feed, not merely until the query settles", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ seed }) => useStableBoardView("ws_1", ALL, undefined, seed), {
      initialProps: { seed: { settled: false, newest: { id: "conv_fresh", activityMs: 900 } } },
    })
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(true)
    expect(result.current.newCount).toBe(0)
    expect(result.current.hasRawPosts).toBe(true)

    // Query settled, but the un-awaited bulkPut + liveQuery re-emission haven't
    // landed yet: the feed is still last session's. Committing here is the bug.
    rerender({ seed: { settled: true, newest: { id: "conv_fresh", activityMs: 900 } } })
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(true)
    expect(result.current.newCount).toBe(0)

    act(() => mockLive(feed(post("conv_fresh", 900), post("a", 300), post("b", 200))))
    rerender({ seed: { settled: true, newest: { id: "conv_fresh", activityMs: 900 } } })
    expect(result.current.posts.map((p) => p.id)).toEqual(["conv_fresh", "a", "b"])
    expect(result.current.newCount).toBe(0)
    expect(result.current.isLoading).toBe(false)
  })

  it("holds when the seed's newest is a reply to an ALREADY-CACHED conversation, until its bumped activity lands", () => {
    // Stale IDB: Y exists at its old activity. The workspace's newest activity is
    // a reply to Y, so the seed's newest id is already present — id-presence alone
    // would open the gate on the stale order.
    mockLive(feed(post("x", 400), post("y", 200)))
    const { result, rerender } = renderHook(({ seed }) => useStableBoardView("ws_1", ALL, undefined, seed), {
      initialProps: { seed: { settled: true, newest: { id: "y", activityMs: 900 } } },
    })
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(true)
    expect(result.current.newCount).toBe(0)

    // The bulkPut lands: y carries the bumped activity.
    act(() => mockLive(feed(post("y", 900), post("x", 400))))
    rerender({ seed: { settled: true, newest: { id: "y", activityMs: 900 } } })
    expect(result.current.posts.map((p) => p.id)).toEqual(["y", "x"])
    expect(result.current.newCount).toBe(0)
    expect(result.current.isLoading).toBe(false)
  })

  it("the offline/timeout escape hatch commits what it has, and buffers arrivals after it", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ seed }) => useStableBoardView("ws_1", ALL, undefined, seed), {
      initialProps: { seed: { settled: true, newest: null } },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    act(() => mockLive(feed(post("fresh", 900), post("a", 300), post("b", 200))))
    rerender({ seed: { settled: true, newest: null } })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect(result.current.newCount).toBe(1)
  })

  it("commits the LATEST live feed when the gate opens, not the snapshot it held", () => {
    mockLive(feed(post("a", 300)))
    const { result, rerender } = renderHook(({ seed }) => useStableBoardView("ws_1", ALL, undefined, seed), {
      initialProps: { seed: { settled: false, newest: { id: "c", activityMs: 500 } } },
    })
    act(() => mockLive(feed(post("b", 400))))
    rerender({ seed: { settled: false, newest: { id: "c", activityMs: 500 } } })
    expect(result.current.posts).toEqual([])

    act(() => mockLive(feed(post("c", 500), post("b", 400))))
    rerender({ seed: { settled: true, newest: { id: "c", activityMs: 500 } } })
    expect(result.current.posts.map((p) => p.id)).toEqual(["c", "b"])
    expect(result.current.newCount).toBe(0)
  })

  it("a workspace switch re-arms the gate — the previous workspace's cached rows never commit", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(({ ws, seed }) => useStableBoardView(ws, ALL, undefined, seed), {
      initialProps: { ws: "ws_1", seed: { settled: true, newest: null } },
    })
    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])

    // ws_2's query is still loading; the liveQuery still returns ws_1's rows.
    rerender({ ws: "ws_2", seed: { settled: false, newest: null } })
    expect(result.current.posts).toEqual([])
    expect(result.current.isLoading).toBe(true)
    expect(result.current.newCount).toBe(0)
  })

  it("commits a filter switch instantly once this workspace has committed (the gate is per-workspace)", () => {
    mockLive(
      feed(
        lensPost("decided", 300, { isMine: true }),
        lensPost("plain", 200, { status: "active", completenessScore: 5 })
      )
    )
    const { result, rerender } = renderHook(
      ({ lens, seed }) => useStableBoardView("ws_1", lensFilter(lens), undefined, seed),
      { initialProps: { lens: "all" as BoardLens, seed: { settled: true, newest: null } as BoardSeedState } }
    )
    expect(result.current.posts.map((p) => p.id)).toEqual(["decided", "plain"])

    // The new lens's query is still fetching — the lens must still switch now.
    rerender({ lens: "mine" as BoardLens, seed: { settled: false, newest: { id: "x", activityMs: 1 } } })
    expect(result.current.posts.map((p) => p.id)).toEqual(["decided"])
    expect(result.current.isLoading).toBe(false)
  })

  it("no seed argument means no gating (existing call sites commit immediately)", () => {
    mockLive(feed(post("a", 300)))
    const { result } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))
    expect(result.current.posts.map((p) => p.id)).toEqual(["a"])
    expect(result.current.isLoading).toBe(false)
  })
})

describe("useStableBoardView — existing-card activity", () => {
  let liveValue: CachedBoardPost[] | undefined
  function mockLive(value: CachedBoardPost[] | undefined) {
    liveValue = value
    vi.spyOn(boardStoreModule, "useBoardPosts").mockImplementation(() => liveValue)
  }

  afterEach(() => vi.restoreAllMocks())

  it("counts only new conversations, never activity on an already-committed card", () => {
    mockLive(feed(post("a", 300), post("b", 200)))
    const { result, rerender } = renderHook(() => useStableBoardView("ws_1", ALL, undefined, undefined))

    act(() => mockLive(feed(post("b", 900), post("new", 700), post("a", 300))))
    rerender()

    expect(result.current.posts.map((p) => p.id)).toEqual(["a", "b"])
    expect(result.current.newCount).toBe(1)
  })
})
