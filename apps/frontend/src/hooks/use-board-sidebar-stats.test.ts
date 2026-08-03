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
  it("tallies topics per effective root stream, whatever the conversation status", () => {
    const { byStream } = aggregateBoardSidebarStats([
      post("c1", { streamId: "chan_a", status: "active" }),
      post("c2", { streamId: "chan_a", status: "stalled" }),
      post("c3", { streamId: "chan_a", status: "resolved" }),
      post("c4", { streamId: "chan_b", status: "active" }),
    ])
    expect(byStream.get("chan_a")).toEqual({ topics: 3 })
    expect(byStream.get("chan_b")).toEqual({ topics: 1 })
  })

  it("resolves a thread-anchored conversation to its rootStreamId, not its anchor", () => {
    const { byStream } = aggregateBoardSidebarStats([
      post("c1", { streamId: "thread_x", rootStreamId: "chan_a" }),
      post("c2", { streamId: "chan_a" }),
    ])
    expect(byStream.get("chan_a")?.topics).toBe(2)
    expect(byStream.has("thread_x")).toBe(false)
  })

  it("falls back to the anchor streamId when rootStreamId is absent (pre-field row)", () => {
    const { byStream } = aggregateBoardSidebarStats([post("c1", { streamId: "chan_a" })])
    expect(byStream.get("chan_a")?.topics).toBe(1)
  })

  it("excludes emptied-shell conversations (no messages) — mirrors the board feed", () => {
    const { byStream, lensTotals } = aggregateBoardSidebarStats([
      post("c1", { streamId: "chan_a", messageIds: [] }),
      post("c2", { streamId: "chan_a", messageIds: ["m"] }),
    ])
    expect(byStream.get("chan_a")?.topics).toBe(1)
    expect(lensTotals.all).toBe(1)
  })

  it("excludes conversations whose root is archived", () => {
    const { byStream } = aggregateBoardSidebarStats([
      post("c1", { streamId: "chan_a", rootArchived: true }),
      post("c2", { streamId: "chan_a" }),
    ])
    expect(byStream.get("chan_a")?.topics).toBe(1)
  })

  it("excludes a stale card whose root is archived in the local stream index", () => {
    const { byStream, lensTotals } = aggregateBoardSidebarStats(
      [
        post("c1", { streamId: "chan_a", rootArchived: false }),
        post("c2", { streamId: "chan_b", rootArchived: false }),
      ],
      new Set(["chan_a"])
    )
    expect(byStream.get("chan_a")).toBeUndefined()
    expect(byStream.get("chan_b")?.topics).toBe(1)
    expect(lensTotals.all).toBe(1)
  })

  it("computes per-lens totals via matchesBoardLens, keyed by exactly the three lenses", () => {
    const { lensTotals } = aggregateBoardSidebarStats([
      post("c1", { streamId: "chan_a", status: "active", isMine: true }),
      post("c2", { streamId: "chan_a", status: "stalled", completenessScore: 1, idleHours: 0 }),
      post("c3", { streamId: "chan_a", status: "resolved", hasCapturedMemo: true }),
      post("c4", { streamId: "chan_b", status: "active", idleHours: 100, completenessScore: 1 }),
    ])
    expect(lensTotals).toEqual({ all: 4, decisions: 1, mine: 1 })
  })

  it("returns empty tallies for an empty feed", () => {
    const { byStream, lensTotals } = aggregateBoardSidebarStats([])
    expect(byStream.size).toBe(0)
    expect(lensTotals).toEqual({ all: 0, decisions: 0, mine: 0 })
  })
})
