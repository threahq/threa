import { describe, expect, it } from "bun:test"
import type { JSONContent } from "@threa/types"

import { CONTAINER_NODE_TYPES, docContentSize, LEAF_NODE_TYPES, nodeSize, UnknownNodeTypeError } from "./positions"

const fixture: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "a" },
        { type: "mention", attrs: { id: "usr_1", slug: "alice", mentionType: "user" } },
        { type: "text", text: "b" },
      ],
    },
  ],
}

describe("nodeSize", () => {
  it("sizes a text node as its character length", () => {
    expect(nodeSize({ type: "text", text: "Hello" })).toBe(5)
    expect(nodeSize({ type: "text", text: "" })).toBe(0)
    expect(nodeSize({ type: "text", text: "a\u{1F600}b" })).toBe(4)
  })

  it("sizes every non-text leaf node as 1", () => {
    for (const type of LEAF_NODE_TYPES) {
      if (type === "text") continue
      expect([type, nodeSize({ type })]).toEqual([type, 1])
    }
  })

  it("sizes an empty container as 2, with or without a content key", () => {
    expect(nodeSize({ type: "paragraph" })).toBe(2)
    expect(nodeSize({ type: "paragraph", content: [] })).toBe(2)
  })

  it("sizes a container as 2 + its children", () => {
    expect(nodeSize(fixture.content![0])).toBe(13)
    expect(nodeSize(fixture.content![1])).toBe(5)
    expect(
      nodeSize({
        type: "bulletList",
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }],
      })
    ).toBe(8)
  })

  it("treats an unrecognised node with children as a container", () => {
    expect(nodeSize({ type: "future", content: [{ type: "text", text: "hi" }] })).toBe(4)
  })

  it("throws on an unrecognised childless node instead of guessing its size", () => {
    expect(() => nodeSize({ type: "future" })).toThrow(UnknownNodeTypeError)
  })

  it("keeps the leaf and container sets disjoint", () => {
    for (const type of LEAF_NODE_TYPES) {
      expect([type, CONTAINER_NODE_TYPES.has(type)]).toEqual([type, false])
    }
  })
})

describe("docContentSize", () => {
  it("sums the top-level children", () => {
    expect(docContentSize(fixture)).toBe(18)
  })

  it("is 0 for an empty document", () => {
    expect(docContentSize({ type: "doc", content: [] })).toBe(0)
    expect(docContentSize({ type: "doc" })).toBe(0)
  })
})
