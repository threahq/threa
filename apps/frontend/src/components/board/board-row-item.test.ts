import { describe, it, expect } from "vitest"
import type { RenderableMessage } from "@/components/message/message-item"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { buildBoardRows, buildBranchedBoardRows } from "./board-row-item"
import { groupBranches, type BranchStreamNode, type BranchStub } from "@/lib/board/branch-grouping"

function msg(id: string, authorId: string, minute: number, streamId?: string): RenderableMessage {
  return {
    id,
    streamId,
    authorId,
    authorType: "user",
    contentMarkdown: id,
    reactions: {},
    createdAt: `2026-07-04T10:${String(minute).padStart(2, "0")}:00Z`,
  }
}

// The builders only read `kind` / `key` / `sortMs` / `streamId`, so the `event`
// field is a stub — kept off `@/db` to leave this a pure-logic test (no
// persistence import).
function memoEventRow(key: string, minute: number, streamId = "root"): BoardEventRow {
  const createdAt = `2026-07-04T10:${String(minute).padStart(2, "0")}:00Z`
  return {
    kind: "memo",
    key,
    sortMs: new Date(createdAt).getTime(),
    streamId,
    event: { id: key, createdAt },
  } as BoardEventRow
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

describe("buildBranchedBoardRows continuation", () => {
  function streamNode(
    parentStreamId: string | null,
    rootStreamId: string | null,
    parentMessageId: string | null
  ): BranchStreamNode {
    return { parentStreamId, rootStreamId, parentMessageId }
  }

  it("a soft seam breaks a same-author continuation run", () => {
    // Same author within the grouping window, but split across a soft thread
    // boundary: the seam sits between the runs and the second run doesn't group.
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "a")],
    ])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u1", 1, "thread")], {
      streams,
      conversation: { streamId: "root" },
    })
    const rows = buildBranchedBoardRows(grouping, [], new Map())
    expect(rows.map((r) => r.kind)).toEqual(["message", "seam", "message"])
    const second = rows[2]
    expect(second.kind === "message" && second.continuation).toBe(false)
  })

  it("a branch stub breaks a same-author continuation run", () => {
    // Two same-author messages that WOULD group, with a true-thread stub anchored
    // to the first — the stub resets continuation exactly like an event row.
    const streams = new Map([["root", streamNode(null, null, null)]])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u1", 1, "root")], {
      streams,
      conversation: { streamId: "root" },
    })
    const stub: BranchStub = {
      forkMessageId: "a",
      childConversationId: "conv_child",
      threadStreamId: "thread_x",
      title: "GPU budget",
    }
    const rows = buildBranchedBoardRows(grouping, [], new Map([["a", [stub]]]))
    expect(rows.map((r) => r.kind)).toEqual(["message", "branch-stub", "message"])
    const second = rows[2]
    expect(second.kind === "message" && second.continuation).toBe(false)
  })

  it("an event on a stream with no rendered group joins the base run chronologically", () => {
    // A memo capture landed on a member stream whose messages sit in the hidden
    // middle (or outside the occupied set entirely). It must still render — at
    // the base level, in time order — not silently vanish.
    const streams = new Map([["root", streamNode(null, null, null)]])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u1", 4, "root")], {
      streams,
      conversation: { streamId: "root" },
    })
    const rows = buildBranchedBoardRows(grouping, [memoEventRow("evt", 2, "other_stream")], new Map())
    expect(rows.map((r) => (r.kind === "message" ? r.message.id : r.kind))).toEqual(["a", "event", "b"])
    const orphanRow = rows[1]
    expect(orphanRow.kind === "event" && orphanRow.displayDepth).toBe(0)
  })

  it("splits orphan events across a soft seam by time", () => {
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "a")],
    ])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u2", 4, "thread")], {
      streams,
      conversation: { streamId: "root" },
    })
    const rows = buildBranchedBoardRows(
      grouping,
      [memoEventRow("early", 1, "elsewhere"), memoEventRow("late", 5, "elsewhere")],
      new Map()
    )
    expect(rows.map((r) => (r.kind === "event" ? r.row.key : r.kind))).toEqual([
      "message",
      "early",
      "seam",
      "message",
      "late",
    ])
  })
})
