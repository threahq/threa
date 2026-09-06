import { describe, expect, it } from "vitest"
import { createMockClusterConversation, createMockMemoResult, createMockSearchCluster } from "@/test/fixtures/search"
import { createMockSearchResult } from "@/test/fixtures/messages"
import type { SearchResultItem } from "@/api"
import { countClusterResults, groupClustersByStream } from "./group-clusters"

function hit(id: string, streamId: string): SearchResultItem {
  return createMockSearchResult({ id, streamId }) as SearchResultItem
}

describe("groupClustersByStream", () => {
  it("orders groups by their best cluster and keeps rank order inside", () => {
    const clusters = [
      createMockSearchCluster({ hits: [hit("msg_1", "stream_b")] }),
      createMockSearchCluster({ hits: [hit("msg_2", "stream_a")] }),
      createMockSearchCluster({ hits: [hit("msg_3", "stream_b")] }),
      createMockSearchCluster({ hits: [hit("msg_4", "stream_a")] }),
    ]

    const groups = groupClustersByStream(clusters, [])

    expect(
      groups.map((group) => ({
        streamId: group.streamId,
        hits: group.clusters.flatMap((cluster) => cluster.hits.map((h) => h.id)),
      }))
    ).toEqual([
      { streamId: "stream_b", hits: ["msg_1", "msg_3"] },
      { streamId: "stream_a", hits: ["msg_2", "msg_4"] },
    ])
  })

  it("gathers each stream's memos on its group, first reference first, without repeats", () => {
    const memos = [
      createMockMemoResult({ id: "memo_1", title: "Launch decision" }),
      createMockMemoResult({ id: "memo_2", title: "Rollout plan" }),
      createMockMemoResult({ id: "memo_3", title: "Pricing note" }),
    ]
    const clusters = [
      createMockSearchCluster({ hits: [hit("msg_1", "stream_a")], memoIds: ["memo_2", "memo_1"] }),
      createMockSearchCluster({ hits: [hit("msg_2", "stream_b")], memoIds: ["memo_3"] }),
      createMockSearchCluster({ hits: [hit("msg_3", "stream_a")], memoIds: ["memo_1"] }),
    ]

    const groups = groupClustersByStream(clusters, memos)

    expect(groups.map((group) => ({ streamId: group.streamId, memos: group.memos.map((m) => m.memo.id) }))).toEqual([
      { streamId: "stream_a", memos: ["memo_2", "memo_1"] },
      { streamId: "stream_b", memos: ["memo_3"] },
    ])
  })

  it("drops memo ids the response carries no memo for", () => {
    const clusters = [createMockSearchCluster({ hits: [hit("msg_1", "stream_a")], memoIds: ["memo_gone"] })]

    expect(groupClustersByStream(clusters, []).map((group) => group.memos)).toEqual([[]])
  })

  it("groups a hit-less topic row under its own stream", () => {
    const clusters = [
      createMockSearchCluster({
        conversation: createMockClusterConversation({ streamId: "stream_a" }),
        matchedVia: ["topic"],
        hits: [],
      }),
    ]

    const groups = groupClustersByStream(clusters, [])

    expect(groups).toHaveLength(1)
    expect(groups[0]!.streamId).toBe("stream_a")
    expect(countClusterResults(groups[0]!.clusters)).toBe(1)
  })
})

describe("countClusterResults", () => {
  it("counts every hit and a hit-less row as one", () => {
    const clusters = [
      createMockSearchCluster({ hits: [hit("msg_1", "stream_a"), hit("msg_2", "stream_a")] }),
      createMockSearchCluster({ conversation: createMockClusterConversation(), matchedVia: ["topic"], hits: [] }),
    ]

    expect(countClusterResults(clusters)).toBe(3)
  })
})
