import { describe, it, expect } from "vitest"
import type { RenderableMessage } from "@/components/message/message-item"
import type { BoardEventRow } from "@/lib/board/board-event-rows"
import { buildBoardRows, buildBranchedBoardRows } from "./board-row-item"
import { groupBranches, type BranchStreamNode, type BranchConversationView } from "@/lib/board/branch-grouping"

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
    // A flat two-message discussion migrated into a thread: the seam sits
    // between the runs and the post-seam message doesn't group.
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "b")],
    ])
    const grouping = groupBranches(
      [msg("a", "u1", 0, "root"), msg("b", "u1", 1, "root"), msg("c", "u1", 2, "thread")],
      { streams, conversation: { streamId: "root" } }
    )
    const rows = buildBranchedBoardRows(grouping, [], new Map())
    expect(rows.map((r) => r.kind)).toEqual(["message", "message", "seam", "message"])
    const afterSeam = rows[3]
    expect(afterSeam.kind === "message" && afterSeam.continuation).toBe(false)
  })

  it("a lone opener continuing into a thread renders seamlessly (convert-to-thread)", () => {
    // The first reply to a lone post files into a thread by design — the thread
    // IS the conversation, so no seam row and continuation flows across.
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "a")],
    ])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u1", 1, "thread")], {
      streams,
      conversation: { streamId: "root" },
    })
    const rows = buildBranchedBoardRows(grouping, [], new Map(), "a")
    expect(rows.map((r) => r.kind)).toEqual(["message", "message"])
    const reply = rows[1]
    expect(reply.kind === "message" && reply.continuation).toBe(true)
    expect(reply.kind === "message" && reply.displayDepth).toBe(0)
  })

  it("a converted opener stays seamless however large the thread grows", () => {
    // Not a size threshold: the pre-boundary run stays opener-only, so the
    // whole discussion renders as one flat run even with real back-and-forth.
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "a")],
    ])
    const grouping = groupBranches(
      [
        msg("a", "u1", 0, "root"),
        msg("b", "u2", 1, "thread"),
        msg("c", "u1", 2, "thread"),
        msg("d", "u2", 3, "thread"),
      ],
      { streams, conversation: { streamId: "root" } }
    )
    const rows = buildBranchedBoardRows(grouping, [], new Map(), "a")
    expect(rows.map((r) => r.kind)).toEqual(["message", "message", "message", "message"])
  })

  it("keeps the seam when the pre-boundary run is a single reply that isn't the opener (collapsed window)", () => {
    // A migrated flat discussion, collapsed so the flattener sees only a trailing
    // reply-only window that happens to start with one channel reply. The single
    // pre-boundary message is NOT the conversation opener, so this is the same
    // migration the expanded card seams — not a convert-to-thread. The seam must
    // survive the windowing (else it flickers between collapsed and expanded).
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", "r2")],
    ])
    const grouping = groupBranches([msg("r2", "u1", 5, "root"), msg("t1", "u1", 6, "thread")], {
      streams,
      conversation: { streamId: "root" },
    })
    // The real opener (`r1`) sits in the hidden middle, absent from the window.
    const rows = buildBranchedBoardRows(grouping, [], new Map(), "r1")
    expect(rows.map((r) => r.kind)).toEqual(["message", "seam", "message"])
  })

  it("without an opening id a lone down-crossing keeps its seam (no suppression hint)", () => {
    // The suppression is opt-in via the opener id; a caller that can't vouch the
    // run starts at the opener gets the conservative seam, never a dropped one.
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
  })

  it("an up-seam keeps its seam even when the first run is a single message", () => {
    // Thread→root: the lone-opener rule is the convert-to-thread signature,
    // which only exists on a down crossing — an up crossing always seams.
    const streams = new Map([
      ["root", streamNode(null, null, null)],
      ["thread", streamNode("root", "root", null)],
    ])
    const grouping = groupBranches([msg("a", "u1", 0, "thread"), msg("b", "u1", 1, "root")], {
      streams,
      conversation: { streamId: "thread" },
    })
    const rows = buildBranchedBoardRows(grouping, [], new Map())
    expect(rows.map((r) => r.kind)).toEqual(["message", "seam", "message"])
  })

  it("a branch group lands after its fork message and breaks a same-author continuation run", () => {
    // Two same-author messages that WOULD group, with a branch conversation
    // forked off the first — the group resets continuation like an event row.
    const streams = new Map([["root", streamNode(null, null, null)]])
    const grouping = groupBranches([msg("a", "u1", 0, "root"), msg("b", "u1", 1, "root")], {
      streams,
      conversation: { streamId: "root" },
    })
    const branch: BranchConversationView = {
      conversationId: "conv_child",
      threadStreamId: "thread_x",
      forkMessageId: "a",
      title: "GPU budget",
      displayDepth: 1,
      overflow: false,
      messages: [msg("c1", "u2", 2, "thread_x")],
      hiddenCount: 0,
      children: [],
    }
    const rows = buildBranchedBoardRows(grouping, [], new Map([["a", [branch]]]))
    expect(rows.map((r) => r.kind)).toEqual(["message", "branch-group", "message"])
    const second = rows[2]
    expect(second.kind === "message" && second.continuation).toBe(false)
  })

  it("appends a branch whose fork message isn't rendered (hidden middle) after the run", () => {
    const streams = new Map([["root", streamNode(null, null, null)]])
    const grouping = groupBranches([msg("b", "u1", 4, "root")], {
      streams,
      conversation: { streamId: "root" },
    })
    const branch: BranchConversationView = {
      conversationId: "conv_child",
      threadStreamId: "thread_x",
      forkMessageId: "hidden_msg",
      title: "GPU budget",
      displayDepth: 1,
      overflow: false,
      messages: [msg("c1", "u2", 2, "thread_x")],
      hiddenCount: 0,
      children: [],
    }
    const rows = buildBranchedBoardRows(grouping, [], new Map([["hidden_msg", [branch]]]))
    expect(rows.map((r) => r.kind)).toEqual(["message", "branch-group"])
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
      ["thread", streamNode("root", "root", "b")],
    ])
    const grouping = groupBranches(
      [msg("a", "u1", 0, "root"), msg("b", "u2", 2, "root"), msg("c", "u2", 4, "thread")],
      { streams, conversation: { streamId: "root" } }
    )
    const rows = buildBranchedBoardRows(
      grouping,
      [memoEventRow("early", 1, "elsewhere"), memoEventRow("late", 5, "elsewhere")],
      new Map()
    )
    expect(rows.map((r) => (r.kind === "event" ? r.row.key : r.kind))).toEqual([
      "message",
      "early",
      "message",
      "seam",
      "message",
      "late",
    ])
  })
})
