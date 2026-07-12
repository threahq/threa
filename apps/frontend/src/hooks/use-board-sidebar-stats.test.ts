import { describe, expect, it } from "vitest"
import type { ConversationStatus } from "@threa/types"
import type { CachedBoardPost } from "@/db"
import { aggregateBoardSidebarStats } from "./use-board-sidebar-stats"

const NOW = Date.parse("2026-07-12T12:00:00Z")
const HOUR = 3_600_000

interface PostOpts {
  streamId: string
  rootStreamId?: string
  status?: ConversationStatus
  messageIds?: string[]
  hasCapturedMemo?: boolean
  isMine?: boolean
  rootArchived?: boolean
  completenessScore?: number
  idleHours?: number
}

function post(id: string, opts: PostOpts): CachedBoardPost {
  const lastActivityAt = new Date(NOW - (opts.idleHours ?? 0) * HOUR).toISOString()
  return {
    id,
    workspaceId: "ws_1",
    _lastActivityMs: Date.parse(lastActivityAt),
    _cachedAt: NOW,
    conversation: {
      id,
      streamId: opts.streamId,
      messageIds: opts.messageIds ?? ["msg_1"],
      status: opts.status ?? "active",
      lastActivityAt,
      completenessScore: opts.completenessScore ?? 5,
    },
    rootStreamId: opts.rootStreamId,
    rootArchived: opts.rootArchived,
    hasCapturedMemo: opts.hasCapturedMemo ?? false,
    isMine: opts.isMine ?? false,
    openingMessage: null,
    recentMessages: [],
    totalReplies: 0,
    streamIds: [opts.streamId],
  } as unknown as CachedBoardPost
}

describe("aggregateBoardSidebarStats", () => {
  it("tallies topics/active/needsResolution per effective root stream", () => {
    const { byStream } = aggregateBoardSidebarStats(
      [
        post("c1", { streamId: "chan_a", status: "active" }),
        post("c2", { streamId: "chan_a", status: "stalled" }),
        post("c3", { streamId: "chan_a", status: "resolved" }),
        post("c4", { streamId: "chan_b", status: "active" }),
      ],
      NOW
    )
    expect(byStream.get("chan_a")).toEqual({ topics: 3, active: 1, needsResolution: 1 })
    expect(byStream.get("chan_b")).toEqual({ topics: 1, active: 1, needsResolution: 0 })
  })

  it("resolves a thread-anchored conversation to its rootStreamId, not its anchor", () => {
    const { byStream } = aggregateBoardSidebarStats(
      [post("c1", { streamId: "thread_x", rootStreamId: "chan_a" }), post("c2", { streamId: "chan_a" })],
      NOW
    )
    expect(byStream.get("chan_a")?.topics).toBe(2)
    expect(byStream.has("thread_x")).toBe(false)
  })

  it("falls back to the anchor streamId when rootStreamId is absent (pre-field row)", () => {
    const { byStream } = aggregateBoardSidebarStats([post("c1", { streamId: "chan_a" })], NOW)
    expect(byStream.get("chan_a")?.topics).toBe(1)
  })

  it("excludes emptied-shell conversations (no messages) — mirrors the board feed", () => {
    const { byStream, lensTotals } = aggregateBoardSidebarStats(
      [post("c1", { streamId: "chan_a", messageIds: [] }), post("c2", { streamId: "chan_a", messageIds: ["m"] })],
      NOW
    )
    expect(byStream.get("chan_a")?.topics).toBe(1)
    expect(lensTotals.all).toBe(1)
  })

  it("excludes conversations whose root is archived", () => {
    const { byStream } = aggregateBoardSidebarStats(
      [post("c1", { streamId: "chan_a", rootArchived: true }), post("c2", { streamId: "chan_a" })],
      NOW
    )
    expect(byStream.get("chan_a")?.topics).toBe(1)
  })

  it("computes per-lens totals via matchesBoardLens (all five lenses)", () => {
    const { lensTotals } = aggregateBoardSidebarStats(
      [
        post("c1", { streamId: "chan_a", status: "active", isMine: true }),
        post("c2", { streamId: "chan_a", status: "stalled", completenessScore: 1, idleHours: 0 }),
        post("c3", { streamId: "chan_a", status: "resolved", hasCapturedMemo: true }),
        // Idle + incomplete → needs-resolution even though status is active.
        post("c4", { streamId: "chan_b", status: "active", idleHours: 100, completenessScore: 1 }),
      ],
      NOW
    )
    expect(lensTotals.all).toBe(4)
    expect(lensTotals.active).toBe(2) // c1, c4
    expect(lensTotals["needs-resolution"]).toBe(2) // c2 (stalled), c4 (idle+incomplete)
    expect(lensTotals.decisions).toBe(1) // c3
    expect(lensTotals.mine).toBe(1) // c1
  })

  it("returns empty tallies for an empty feed", () => {
    const { byStream, lensTotals } = aggregateBoardSidebarStats([], NOW)
    expect(byStream.size).toBe(0)
    expect(lensTotals).toEqual({ all: 0, active: 0, "needs-resolution": 0, decisions: 0, mine: 0 })
  })
})
