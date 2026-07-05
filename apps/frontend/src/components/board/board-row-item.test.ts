import { describe, it, expect } from "vitest"
import type { RenderableMessage } from "@/components/message/message-item"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { buildBoardRows } from "./board-row-item"

function msg(id: string, authorId: string, minute: number): RenderableMessage {
  return {
    id,
    authorId,
    authorType: "user",
    contentMarkdown: id,
    reactions: {},
    createdAt: `2026-07-04T10:${String(minute).padStart(2, "0")}:00Z`,
  }
}

// buildBoardRows only reads `kind` / `key` / `sortMs`, so the `event` field is a
// stub — kept off `@/db` to leave this a pure-logic test (no persistence import).
function memoEventRow(key: string, minute: number): BoardEventRow {
  const createdAt = `2026-07-04T10:${String(minute).padStart(2, "0")}:00Z`
  return { kind: "memo", key, sortMs: new Date(createdAt).getTime(), event: { id: key, createdAt } } as BoardEventRow
}

describe("buildBoardRows", () => {
  it("groups consecutive same-author messages as continuations", () => {
    const rows = buildBoardRows([msg("a", "u1", 0), msg("b", "u1", 1), msg("c", "u2", 2)], [])
    expect(rows.map((r) => (r.kind === "message" ? r.continuation : "event"))).toEqual([false, true, false])
  })

  it("an interleaved event row breaks a same-author continuation run", () => {
    // Two same-author messages that WOULD group, with an event between them by time.
    const rows = buildBoardRows([msg("a", "u1", 0), msg("b", "u1", 2)], [memoEventRow("evt", 1)])
    expect(rows.map((r) => r.kind)).toEqual(["message", "event", "message"])
    // The second message follows an event row, so it is not a continuation.
    const secondMessage = rows[2]
    expect(secondMessage.kind === "message" && secondMessage.continuation).toBe(false)
  })

  it("drops an event that sorts before the first message (hidden middle)", () => {
    const rows = buildBoardRows([msg("a", "u1", 5)], [memoEventRow("evt", 1)])
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("message")
  })

  it("appends an event after the last message at the tail (the 'agent just triggered' case)", () => {
    const rows = buildBoardRows([msg("a", "u1", 0)], [memoEventRow("evt", 5)])
    expect(rows.map((r) => r.kind)).toEqual(["message", "event"])
  })

  it("places a message before an event that shares its exact timestamp", () => {
    const rows = buildBoardRows([msg("a", "u1", 3)], [memoEventRow("evt", 3)])
    expect(rows.map((r) => r.kind)).toEqual(["message", "event"])
  })
})
