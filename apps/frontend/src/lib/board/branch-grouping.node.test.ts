import { describe, it, expect } from "vitest"
import type { RenderableMessage } from "@/components/message/message-item"
import { groupBranches, type BranchStreamNode, type BranchGrouping } from "./branch-grouping"
import { buildBranchedBoardRows } from "@/components/board/board-row-item"

function msg(id: string, streamId: string, minute: number, authorId = "u1"): RenderableMessage {
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

function stream(
  parentStreamId: string | null,
  rootStreamId: string | null,
  parentAnchorId: string | null
): BranchStreamNode {
  return { parentStreamId, rootStreamId, parentAnchorId }
}

describe("groupBranches", () => {
  it("renders a single-stream conversation flat", () => {
    const streams = new Map([["root", stream(null, null, null)]])
    const messages = [msg("m1", "root", 0), msg("m2", "root", 1)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "root" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "flat",
      roots: [
        {
          streamId: "root",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages,
          children: [],
        },
      ],
    })
  })

  it("classifies convert-to-thread (root→thread) as soft: one downward seam, no indent", () => {
    const streams = new Map([
      ["root", stream(null, null, null)],
      ["thread", stream("root", "root", "m2")],
    ])
    const messages = [msg("m1", "root", 0), msg("m2", "root", 1), msg("m3", "thread", 2), msg("m4", "thread", 3)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "root" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "soft",
      roots: [
        {
          streamId: "root",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: messages.slice(0, 2),
          children: [],
        },
        {
          streamId: "thread",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: messages.slice(2),
          children: [],
        },
      ],
      softSeam: { streamId: "thread", afterMessageId: "m2", direction: "down" },
    })
  })

  it("classifies the Slack case (thread→root) as soft with an upward seam", () => {
    const streams = new Map([
      ["thread", stream("root", "root", "p0")],
      ["root", stream(null, null, null)],
    ])
    const messages = [msg("m1", "thread", 0), msg("m2", "thread", 1), msg("m3", "root", 2), msg("m4", "root", 3)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "thread" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "soft",
      roots: [
        {
          streamId: "thread",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: messages.slice(0, 2),
          children: [],
        },
        {
          streamId: "root",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: messages.slice(2),
          children: [],
        },
      ],
      softSeam: { streamId: "root", afterMessageId: "m2", direction: "up" },
    })
  })

  it("classifies a non-monotonic two-stream bounce as spanning, not soft", () => {
    const streams = new Map([
      ["root", stream(null, null, null)],
      ["thread", stream("root", "root", "m1")],
    ])
    const messages = [msg("m1", "root", 0), msg("m2", "thread", 1), msg("m3", "root", 2)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "root" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "spanning",
      roots: [
        {
          streamId: "root",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: [messages[0], messages[2]],
          children: [
            {
              streamId: "thread",
              depth: 1,
              displayDepth: 1,
              overflow: false,
              forkMessageId: "m1",
              messages: [messages[1]],
              children: [],
            },
          ],
        },
      ],
    })
  })

  it("places a 3-stream spanning conversation as a nested tree at fork messages", () => {
    const streams = new Map([
      ["R", stream(null, null, null)],
      ["T1", stream("R", "R", "r2")],
      ["T2", stream("T1", "R", "t1a")],
    ])
    const messages = [
      msg("r1", "R", 0),
      msg("r2", "R", 1),
      msg("t1a", "T1", 2),
      msg("t1b", "T1", 3),
      msg("t2a", "T2", 4),
    ]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "R" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "spanning",
      roots: [
        {
          streamId: "R",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: [messages[0], messages[1]],
          children: [
            {
              streamId: "T1",
              depth: 1,
              displayDepth: 1,
              overflow: false,
              forkMessageId: "r2",
              messages: [messages[2], messages[3]],
              children: [
                {
                  streamId: "T2",
                  depth: 2,
                  displayDepth: 2,
                  overflow: false,
                  forkMessageId: "t1a",
                  messages: [messages[4]],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    })
  })

  it("marks a subtree past depth 2 as overflow", () => {
    const streams = new Map([
      ["R", stream(null, null, null)],
      ["T1", stream("R", "R", "r1")],
      ["T2", stream("T1", "R", "t1a")],
      ["T3", stream("T2", "R", "t2a")],
    ])
    const messages = [
      msg("r1", "R", 0),
      msg("t1a", "T1", 1),
      msg("t2a", "T2", 2),
      msg("t3a", "T3", 3),
      msg("r2", "R", 4),
    ]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "R" } })
    // Deep node T3 (relative depth 3) is capped at displayDepth 2 and flagged overflow.
    const t1 = grouping.roots[0].children[0]
    const t2 = t1.children[0]
    const t3 = t2.children[0]
    expect(t3).toEqual({
      streamId: "T3",
      depth: 3,
      displayDepth: 2,
      overflow: true,
      forkMessageId: "t2a",
      messages: [messages[3]],
      children: [],
    })
    // The overflow node collapses to a single continue-thread row carrying its subtree count.
    const rows = buildBranchedBoardRows(grouping, [], new Map())
    const overflow = rows.find((r) => r.kind === "continue-thread")
    expect(overflow).toEqual({
      kind: "continue-thread",
      key: "continue:T3",
      streamId: "T3",
      hiddenCount: 1,
      displayDepth: 2,
    })
  })

  it("renders an unresolvable parent chain at the base level without crashing", () => {
    const streams = new Map([
      ["root", stream(null, null, null)],
      // parentStreamId points at a stream absent from the cache.
      ["orphan", stream("missing", "root", "x")],
    ])
    const messages = [msg("m1", "root", 0), msg("m2", "orphan", 1), msg("m3", "root", 2)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "root" } })
    expect(grouping).toEqual<BranchGrouping>({
      kind: "spanning",
      roots: [
        {
          streamId: "root",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: [messages[0], messages[2]],
          children: [],
        },
        {
          streamId: "orphan",
          depth: 0,
          displayDepth: 0,
          overflow: false,
          forkMessageId: null,
          messages: [messages[1]],
          children: [],
        },
      ],
    })
  })

  it("anchors a child group chronologically when its fork message isn't rendered", () => {
    const streams = new Map([
      ["R", stream(null, null, null)],
      // T1 forks off r2, which is NOT among the rendered messages.
      ["T1", stream("R", "R", "r2")],
    ])
    const messages = [msg("r1", "R", 0), msg("t1a", "T1", 2), msg("r3", "R", 3)]
    const grouping = groupBranches(messages, { streams, conversation: { streamId: "R" } })
    // T1 still attaches under R (its occupied ancestor) with its true fork id.
    expect(grouping.roots[0].children[0]).toMatchObject({ streamId: "T1", forkMessageId: "r2", displayDepth: 1 })
    // The builder anchors it by its first message's time: r1, then t1a, then r3.
    const rows = buildBranchedBoardRows(grouping, [], new Map())
    expect(rows.map((r) => (r.kind === "message" ? { id: r.message.id, depth: r.displayDepth } : r.kind))).toEqual([
      { id: "r1", depth: 0 },
      { id: "t1a", depth: 1 },
      { id: "r3", depth: 0 },
    ])
  })
})
