import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { StreamTypes } from "@threa/types"
import type { CachedBoardPost, CachedStream } from "@/db"
import type { RenderableMessage } from "@/components/message/message-item"
import * as workspaceStore from "@/stores/workspace-store"
import {
  deriveBranchConversations,
  collectBranchThreadStreamIds,
  branchParentConversationId,
  useStreamStructuralIndex,
  type ConversationGraph,
  type StreamStructuralIndex,
} from "./use-conversation-graph"

function stream(id: string, type: string, parentMessageId: string | null = null): CachedStream {
  return {
    id,
    workspaceId: "ws_1",
    type,
    parentStreamId: null,
    parentMessageId,
    rootStreamId: type === StreamTypes.THREAD ? "root" : null,
  } as CachedStream
}

function post(
  id: string,
  anchorStreamId: string,
  messageIds: string[],
  topicSummary: string | null,
  parentConversationId: string | null = null
): CachedBoardPost {
  return {
    id,
    workspaceId: "ws_1",
    conversation: { id, streamId: anchorStreamId, messageIds, topicSummary, parentConversationId },
    rootStreamId: "root",
  } as unknown as CachedBoardPost
}

/** Build the two indices the pure helpers read, from plain fixtures. */
function fixtures(streams: CachedStream[], posts: CachedBoardPost[]) {
  const index: StreamStructuralIndex = {
    streamsById: new Map(streams.map((s) => [s.id, s])),
    threadsByAnchorId: new Map(
      streams.filter((s) => s.type === StreamTypes.THREAD && s.parentMessageId).map((s) => [s.parentMessageId!, s])
    ),
  }
  const graph: ConversationGraph = {
    conversationByAnchorStreamId: new Map(
      posts
        .filter((p) => p.conversation.streamId !== (p.rootStreamId ?? p.conversation.streamId))
        .map((p) => [p.conversation.streamId, p])
    ),
    conversationIdByMemberMessageId: new Map(
      posts.flatMap((p) => p.conversation.messageIds.map((m) => [m, p.id] as const))
    ),
    conversationById: new Map(posts.map((p) => [p.id, p])),
    storedParentConversationId: new Map(
      posts.flatMap((p) =>
        p.conversation.parentConversationId ? [[p.id, p.conversation.parentConversationId] as const] : []
      )
    ),
  }
  return { index, graph }
}

const resolveEmpty = () => ({ messages: [] as RenderableMessage[], hiddenCount: 0 })

describe("deriveBranchConversations", () => {
  // root conv (m1) → thread t1 anchors child (c1) → thread t2 anchors grandchild
  // (g1) → thread t3 anchors great-grandchild (gg1).
  const streams = [
    stream("root", StreamTypes.CHANNEL),
    stream("t1", StreamTypes.THREAD, "m1"),
    stream("t2", StreamTypes.THREAD, "c1"),
    stream("t3", StreamTypes.THREAD, "g1"),
  ]
  const posts = [
    post("conv_root", "root", ["m1"], "Root topic"),
    post("conv_child", "t1", ["c1"], "Child topic"),
    post("conv_grand", "t2", ["g1"], "Grand topic"),
    post("conv_great", "t3", ["gg1"], "Great topic"),
  ]

  it("discovers branches recursively with normalized depth, capping visible depth at 2", () => {
    const { index, graph } = fixtures(streams, posts)
    const branches = deriveBranchConversations({
      conversationId: "conv_root",
      memberMessageIds: ["m1"],
      index,
      graph,
      resolveMessages: resolveEmpty,
    })
    expect(branches).toHaveLength(1)
    const child = branches[0]
    expect(child).toMatchObject({
      conversationId: "conv_child",
      threadStreamId: "t1",
      forkMessageId: "m1",
      title: "Child topic",
      displayDepth: 1,
      overflow: false,
    })
    const grand = child.children[0]
    expect(grand).toMatchObject({ conversationId: "conv_grand", displayDepth: 2, forkMessageId: "c1" })
    // Depth 2 is the visible floor: the great-grandchild does not nest — the
    // grandchild flags overflow (its subtree continues in the panel) instead.
    expect(grand.children).toEqual([])
    expect(grand.overflow).toBe(true)
  })

  it("skips threads the parent conversation itself occupies (soft/spanning render inline)", () => {
    const { index, graph } = fixtures(streams, posts)
    const branches = deriveBranchConversations({
      conversationId: "conv_root",
      memberMessageIds: ["m1"],
      index,
      graph,
      resolveMessages: resolveEmpty,
      excludeThreadStreamIds: new Set(["t1"]),
    })
    expect(branches).toEqual([])
  })

  it("resolves branch bodies through the supplied resolver", () => {
    const { index, graph } = fixtures(streams, posts)
    const body = { id: "c1", streamId: "t1" } as RenderableMessage
    const branches = deriveBranchConversations({
      conversationId: "conv_root",
      memberMessageIds: ["m1"],
      index,
      graph,
      resolveMessages: (conversationId) =>
        conversationId === "conv_child" ? { messages: [body], hiddenCount: 3 } : { messages: [], hiddenCount: 0 },
    })
    expect(branches[0].messages).toEqual([body])
    expect(branches[0].hiddenCount).toBe(3)
  })
})

describe("collectBranchThreadStreamIds", () => {
  it("flattens every branch thread within the depth budget", () => {
    const streams = [
      stream("root", StreamTypes.CHANNEL),
      stream("t1", StreamTypes.THREAD, "m1"),
      stream("t2", StreamTypes.THREAD, "c1"),
      stream("t3", StreamTypes.THREAD, "g1"),
    ]
    const posts = [
      post("conv_root", "root", ["m1"], null),
      post("conv_child", "t1", ["c1"], null),
      post("conv_grand", "t2", ["g1"], null),
      post("conv_great", "t3", ["gg1"], null),
    ]
    const { index, graph } = fixtures(streams, posts)
    const ids = collectBranchThreadStreamIds({ conversationId: "conv_root", memberMessageIds: ["m1"], index, graph })
    // t3 sits past the depth budget — its subtree renders behind the overflow
    // link, so its rail isn't subscribed from this card.
    expect(ids.sort()).toEqual(["t1", "t2"])
  })
})

describe("useStreamStructuralIndex — anchor-keyed thread map", () => {
  afterEach(() => vi.restoreAllMocks())

  function threadStream(id: string, fields: Partial<CachedStream>): CachedStream {
    return {
      id,
      workspaceId: "ws_1",
      type: StreamTypes.THREAD,
      parentStreamId: "root",
      parentAnchorId: null,
      parentMessageId: null,
      rootStreamId: "root",
      ...fields,
    } as CachedStream
  }

  it("keys threads by anchor id across a mixed set, excluding card (event) anchors", () => {
    const streams: CachedStream[] = [
      { id: "root", workspaceId: "ws_1", type: StreamTypes.CHANNEL } as CachedStream,
      // New message anchor (dual-written) — indexed under the anchor id.
      threadStream("t_msg", { parentAnchorId: "msg_a", parentMessageId: "msg_a" }),
      // Legacy row with only parentMessageId — falls back, still indexed.
      threadStream("t_legacy", { parentAnchorId: null, parentMessageId: "msg_b" }),
      // Card anchor — a board branch never forks off a card, so it's excluded.
      threadStream("t_card", { parentAnchorId: "event_c", parentMessageId: null }),
    ]
    vi.spyOn(workspaceStore, "useWorkspaceStreams").mockReturnValue(streams)

    const { result } = renderHook(() => useStreamStructuralIndex("ws_1"))
    const map = result.current.threadsByAnchorId

    expect(map.get("msg_a")?.id).toBe("t_msg")
    expect(map.get("msg_b")?.id).toBe("t_legacy")
    expect(map.has("event_c")).toBe(false)
    expect(result.current.streamsById.get("t_card")?.id).toBe("t_card")
  })
})

describe("branchParentConversationId", () => {
  it("resolves the parent conversation a branch's anchor thread forks off", () => {
    const streams = [stream("root", StreamTypes.CHANNEL), stream("t1", StreamTypes.THREAD, "m1")]
    const posts = [post("conv_root", "root", ["m1"], null), post("conv_child", "t1", ["c1"], null)]
    const { index, graph } = fixtures(streams, posts)
    expect(branchParentConversationId("conv_child", index, graph)).toBe("conv_root")
    // A root-anchored conversation is no branch.
    expect(branchParentConversationId("conv_root", index, graph)).toBeNull()
    // An empty parent never counts (mirrors the board's cardinality filter).
    const emptied = posts.map((p) => (p.id === "conv_root" ? post("conv_root", "root", [], null) : p))
    const f2 = fixtures(streams, emptied)
    expect(branchParentConversationId("conv_child", f2.index, f2.graph)).toBeNull()
  })

  it("nests a card-anchored thread through the parent the server wrote down", () => {
    // A subagent's thread hangs off the `subagent:created` card, so the graph has
    // no member message to derive the fork from — without the stored parent this
    // conversation renders as its own top-level board card.
    const streams = [stream("root", StreamTypes.CHANNEL), stream("t_sub", StreamTypes.THREAD, "event_card")]
    const derived = [post("conv_root", "root", ["m1"], null), post("conv_sub", "t_sub", ["c1"], null)]
    const withoutStored = fixtures(streams, derived)
    expect(branchParentConversationId("conv_sub", withoutStored.index, withoutStored.graph)).toBeNull()

    const stored = fixtures(streams, [derived[0], post("conv_sub", "t_sub", ["c1"], null, "conv_root")])
    expect(branchParentConversationId("conv_sub", stored.index, stored.graph)).toBe("conv_root")
  })

  it("ignores a stored parent that is the conversation itself", () => {
    const streams = [stream("root", StreamTypes.CHANNEL), stream("t_sub", StreamTypes.THREAD, "event_card")]
    const { index, graph } = fixtures(streams, [
      post("conv_root", "root", ["m1"], null),
      post("conv_sub", "t_sub", ["c1"], null, "conv_sub"),
    ])
    expect(branchParentConversationId("conv_sub", index, graph)).toBeNull()
  })
})
