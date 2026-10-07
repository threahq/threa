import { describe, expect, it } from "bun:test"
import { segmentConversations, type BenchMessage } from "./dataset"

const message = (node: string, minute: number, topic = "t"): BenchMessage => ({
  node,
  author: "a",
  content: node,
  createdAt: new Date(Date.UTC(2025, 6, 1, 9, minute)),
  replyTo: null,
  topic,
  phase: "p",
})

const nodes = (conversations: BenchMessage[][]) => conversations.map((c) => c.map((m) => m.node))

describe("segmentConversations", () => {
  it("keeps a stream's messages in time order across topics, ending a conversation at a long gap or the size cap", () => {
    const messages = [message("a", 0), message("b", 30, "other"), message("c", 61), message("d", 62), message("e", 63)]

    expect(nodes(segmentConversations(messages, 2, 30 * 60_000))).toEqual([["a", "b"], ["c", "d"], ["e"]])
  })
})
