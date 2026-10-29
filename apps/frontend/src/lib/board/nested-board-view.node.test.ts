import { describe, it, expect } from "vitest"
import type { CachedBoardPost } from "@/db"
import { projectNestedBoardView } from "./nested-board-view"

function post(id: string, activityMs: number, streamIds: string[] = [`stream_${id}`]): CachedBoardPost {
  return {
    id,
    workspaceId: "ws_1",
    _lastActivityMs: activityMs,
    _cachedAt: activityMs,
    streamIds,
    conversation: { id, streamId: streamIds[0], lastActivityAt: new Date(activityMs).toISOString() },
    openingMessage: null,
    recentMessages: [],
    totalReplies: 0,
  } as unknown as CachedBoardPost
}

/** Parent map → the graph-only resolver shape `projectNestedBoardView` consumes. */
function parents(map: Record<string, string>): (id: string) => string | null {
  return (id) => map[id] ?? null
}

describe("projectNestedBoardView", () => {
  it("suppresses a child whose parent is present in the same list", () => {
    const posts = [post("parent", 300), post("child", 200)]
    const out = projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(out.map((p) => p.conversation.id)).toEqual(["parent"])
  })

  it("keeps a child standalone when its parent is filtered out / inaccessible", () => {
    // "child"'s parent resolves to "parent", but "parent" isn't in the filtered list.
    const posts = [post("child", 200)]
    const out = projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(out.map((p) => p.conversation.id)).toEqual(["child"])
  })

  it("folds a grandchild transitively to the nearest present ancestor", () => {
    // parent present, child present (suppressed), grandchild present → both fold into parent.
    const posts = [post("parent", 300), post("child", 250), post("grandchild", 200)]
    const out = projectNestedBoardView(posts, parents({ child: "parent", grandchild: "child" }))
    expect(out.map((p) => p.conversation.id)).toEqual(["parent"])
  })

  it("folds a grandchild's activity and streams to the SURVIVOR, not its suppressed middle parent", () => {
    // Full present chain A ← B ← C where C has the latest activity: B's card never
    // renders, so C's bump and stream declarations must land on A — folding them
    // into suppressed B would silently drop both.
    const posts = [post("A", 300), post("B", 250), post("C", 400)]
    const out = projectNestedBoardView(posts, parents({ B: "A", C: "B" }))
    expect(
      out.map((p) => ({ id: p.conversation.id, ms: p._lastActivityMs, streams: [...(p.streamIds ?? [])].sort() }))
    ).toEqual([{ id: "A", ms: 400, streams: ["stream_A", "stream_B", "stream_C"] }])
  })

  it("folds a grandchild to the nearest VISIBLE ancestor when the middle parent is absent", () => {
    // child (the middle) is filtered out; grandchild folds to parent (present), and
    // child itself survives because its own parent is present.
    const posts = [post("parent", 300), post("grandchild", 200)]
    const out = projectNestedBoardView(posts, parents({ grandchild: "child", child: "parent" }))
    // grandchild's nearest present ancestor is parent → suppressed; parent survives.
    expect(out.map((p) => p.conversation.id)).toEqual(["parent"])
  })

  it("bumps a surviving parent to its folded child's later activity", () => {
    const posts = [post("parent", 300), post("child", 900)]
    const out = projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(out.map((p) => p.conversation.id)).toEqual(["parent"])
    expect(out[0]._lastActivityMs).toBe(900)
    expect(Date.parse(out[0].conversation.lastActivityAt)).toBe(900)
  })

  it("re-sorts a bumped parent above a sibling by effective activity", () => {
    // "other" (500) sorts above "parent" (300) by own activity, but parent's child
    // (900) bumps parent's effective activity above it.
    const posts = [post("other", 500), post("parent", 300), post("child", 900)]
    const out = projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(out.map((p) => p.conversation.id)).toEqual(["parent", "other"])
  })

  it("folds a suppressed child's streams into the surviving parent's declared set", () => {
    const posts = [post("parent", 300, ["stream_parent"]), post("child", 200, ["thread_child", "thread_child_2"])]
    const out = projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(new Set(out[0].streamIds)).toEqual(new Set(["stream_parent", "thread_child", "thread_child_2"]))
  })

  it("does not mutate the input posts", () => {
    const posts = [post("parent", 300, ["stream_parent"]), post("child", 900, ["thread_child"])]
    const parentBefore = { ...posts[0], conversation: { ...posts[0].conversation }, streamIds: [...posts[0].streamIds] }
    projectNestedBoardView(posts, parents({ child: "parent" }))
    expect(posts[0]._lastActivityMs).toBe(parentBefore._lastActivityMs)
    expect(posts[0].conversation.lastActivityAt).toBe(parentBefore.conversation.lastActivityAt)
    expect(posts[0].streamIds).toEqual(parentBefore.streamIds)
  })

  it("is a no-op when nothing has a branch parent", () => {
    const posts = [post("a", 300), post("b", 200)]
    const out = projectNestedBoardView(posts, () => null)
    expect(out.map((p) => p.conversation.id)).toEqual(["a", "b"])
  })

  it("terminates on a cyclic parent chain (no infinite walk)", () => {
    // The real resolver can't emit a cycle (thread hierarchy is a DAG, and it
    // guards `parent === self`); the walk's cycle guard is purely defensive.
    const posts = [post("a", 300), post("b", 200)]
    const out = projectNestedBoardView(posts, parents({ a: "b", b: "a" }))
    expect(Array.isArray(out)).toBe(true)
  })
})
