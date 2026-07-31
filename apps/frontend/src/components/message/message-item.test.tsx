import { describe, it, expect } from "vitest"
import { isContinuation } from "@/lib/message-grouping"
import { type RenderableMessage } from "./message-item"

function message(overrides: Partial<RenderableMessage> = {}): RenderableMessage {
  return {
    id: "m1",
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: "hi",
    reactions: {},
    createdAt: "2026-07-28T10:00:00.000Z",
    ...overrides,
  }
}

describe("isContinuation", () => {
  it("groups a same-author message sent within the window", () => {
    expect(isContinuation(message(), message({ id: "m2", createdAt: "2026-07-28T10:01:00.000Z" }))).toBe(true)
  })

  it("a deleted row never continues a same-author run, and never lets one continue across it", () => {
    const live = message()
    const tombstone = message({
      id: "m2",
      contentMarkdown: "",
      createdAt: "2026-07-28T10:01:00.000Z",
      deletedAt: "2026-07-28T10:02:00.000Z",
    })
    const after = message({ id: "m3", createdAt: "2026-07-28T10:02:00.000Z" })
    expect({
      intoTombstone: isContinuation(live, tombstone),
      outOfTombstone: isContinuation(tombstone, after),
    }).toEqual({ intoTombstone: false, outOfTombstone: false })
  })
})
