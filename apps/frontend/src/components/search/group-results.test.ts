import { describe, it, expect } from "vitest"
import { buildStreamPath, groupResultsByStream, type GroupableStream } from "./group-results"
import type { SearchResultItem } from "@/api"

function stream(id: string, createdAt: string, parentStreamId: string | null = null): GroupableStream {
  return { id, createdAt, parentStreamId }
}

function result(id: string, streamId: string): SearchResultItem {
  return {
    id,
    streamId,
    content: "content",
    authorId: "member_1",
    authorType: "user",
    createdAt: "2026-01-01T00:00:00Z",
    rank: 0,
  } as SearchResultItem
}

// Tree: #general → threadA (older) → nested; #general → threadB (newer)
const STREAMS = new Map(
  [
    stream("general", "2026-01-01T00:00:00Z"),
    stream("threadA", "2026-01-02T00:00:00Z", "general"),
    stream("nested", "2026-01-03T00:00:00Z", "threadA"),
    stream("threadB", "2026-01-04T00:00:00Z", "general"),
    stream("other", "2026-01-01T12:00:00Z"),
  ].map((s) => [s.id, s])
)

describe("buildStreamPath", () => {
  it("walks from the root down to the stream", () => {
    expect(buildStreamPath("nested", STREAMS)).toEqual(["general", "threadA", "nested"])
  })

  it("stops at streams missing from the cache", () => {
    const partial = new Map([["nested", stream("nested", "2026-01-03T00:00:00Z", "threadA")]])
    expect(buildStreamPath("nested", partial)).toEqual(["threadA", "nested"])
  })

  it("survives a parent cycle", () => {
    const cyclic = new Map([
      ["a", stream("a", "2026-01-01T00:00:00Z", "b")],
      ["b", stream("b", "2026-01-01T00:00:00Z", "a")],
    ])
    expect(buildStreamPath("a", cyclic)).toEqual(["b", "a"])
  })
})

describe("groupResultsByStream", () => {
  it("orders a root's threads depth-first by creation, parent before children", () => {
    // Relevance order deliberately scrambled: nested ranks above its parents
    const results = [result("m1", "nested"), result("m2", "threadB"), result("m3", "general"), result("m4", "threadA")]

    const groups = groupResultsByStream(results, STREAMS)
    expect(groups.map((g) => g.streamId)).toEqual(["general", "threadA", "nested", "threadB"])
  })

  it("keeps distinct roots in relevance order", () => {
    const results = [result("m1", "other"), result("m2", "general"), result("m3", "threadA")]

    const groups = groupResultsByStream(results, STREAMS)
    expect(groups.map((g) => g.streamId)).toEqual(["other", "general", "threadA"])
  })

  it("collects all results of a stream into one group preserving rank order", () => {
    const results = [result("m1", "general"), result("m2", "threadA"), result("m3", "general")]

    const groups = groupResultsByStream(results, STREAMS)
    expect(groups[0].results.map((r) => r.id)).toEqual(["m1", "m3"])
  })

  it("exposes the full ancestor path on each group", () => {
    const groups = groupResultsByStream([result("m1", "nested")], STREAMS)
    expect(groups[0].path).toEqual(["general", "threadA", "nested"])
  })
})
