import { describe, expect, it } from "bun:test"
import { sanitizeOrder } from "./reranker"
import { StubReranker } from "./reranker.stub"

describe("sanitizeOrder", () => {
  it("passes a valid full permutation through unchanged", () => {
    expect(sanitizeOrder([2, 0, 1], 3)).toEqual([2, 0, 1])
  })

  it("appends omitted indices in original order (recall protection)", () => {
    // Model only ranked 2 of 4 candidates; the rest must survive at the tail.
    expect(sanitizeOrder([3, 1], 4)).toEqual([3, 1, 0, 2])
  })

  it("drops duplicates, keeping the first occurrence", () => {
    expect(sanitizeOrder([1, 1, 0], 3)).toEqual([1, 0, 2])
  })

  it("ignores out-of-range and non-integer indices", () => {
    expect(sanitizeOrder([5, -1, 1.5, 2, 0], 3)).toEqual([2, 0, 1])
  })

  it("returns identity order for an empty proposal", () => {
    expect(sanitizeOrder([], 3)).toEqual([0, 1, 2])
  })

  it("never drops or adds candidates: output is always a full permutation", () => {
    const n = 6
    const result = sanitizeOrder([4, 4, 99, -3, 1], n)
    expect([...result].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe("StubReranker", () => {
  it("returns identity order (production fail-open behaviour)", async () => {
    const reranker = new StubReranker()
    const order = await reranker.rerank(
      "q",
      [
        { title: "a", abstract: "" },
        { title: "b", abstract: "" },
        { title: "c", abstract: "" },
      ],
      { workspaceId: "ws_1" }
    )
    expect(order).toEqual([0, 1, 2])
  })

  it("handles the empty candidate list", async () => {
    const reranker = new StubReranker()
    expect(await reranker.rerank("q", [], { workspaceId: "ws_1" })).toEqual([])
  })
})
