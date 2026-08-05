import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { __clearBoardDraftContextRegistry, useBoardDraftContext } from "./use-board-draft-context"

const workspaceId = "ws_ctx"

beforeEach(async () => {
  __clearBoardDraftContextRegistry()
  await db.conversations.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  __clearBoardDraftContextRegistry()
  vi.restoreAllMocks()
})

describe("useBoardDraftContext — shared subscription failure", () => {
  // Dexie drops a liveQuery rejection when the subscriber passes only a `next`
  // callback, AND a first-run rejection leaves the observable with no tracked
  // ranges, so it never re-queries. Without an error observer this registry
  // would serve an empty context for the page's lifetime with nothing logged —
  // every composer's pile silently collapsing to scope-exact (INV-11).
  it("logs and drops the entry when the query rejects, instead of serving empty forever", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(db.conversations, "bulkGet").mockRejectedValue(new Error("boom"))

    const { result } = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))

    await waitFor(() => expect(error).toHaveBeenCalled())
    expect(error.mock.calls[0]?.[0]).toContain("[draft-context] shared query failed")
    expect(result.current.boardPostMap.size).toBe(0)

    // The failed entry is gone rather than latched at empty, so the next
    // consumer rebuilds it instead of inheriting a dead subscription.
    vi.mocked(db.conversations.bulkGet).mockRestore()
    await db.conversations.put({
      id: "conv_1",
      workspaceId,
      _lastActivityMs: 1,
      _cachedAt: 1,
      conversation: { id: "conv_1", streamId: "stream_s", messageIds: ["msg_1"] },
      openingMessage: { id: "msg_1" },
      recentMessages: [],
    } as never)

    const second = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(second.result.current.boardPostMap.size).toBe(1))
  })
})

describe("useBoardDraftContext — shared subscription ref-counting", () => {
  // The error path deletes an entry and a later subscriber rebuilds it under the
  // same key. A cleanup that re-looked-up by key would then decrement the
  // REPLACEMENT, tearing it down while its own owner is still mounted — the
  // entry serves an empty context for the page's lifetime and every pile
  // silently collapses to scope-exact. Exactly the failure the error observer
  // exists to prevent, one layer down.
  it("an unmount after a failed query does not tear down the rebuilt entry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const bulkGet = vi.spyOn(db.conversations, "bulkGet").mockRejectedValue(new Error("boom"))

    const failed = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(error).toHaveBeenCalled())

    bulkGet.mockRestore()
    await db.conversations.put({
      id: "conv_1",
      workspaceId,
      _lastActivityMs: 1,
      _cachedAt: 1,
      conversation: { id: "conv_1", streamId: "stream_s", messageIds: ["msg_1"] },
      openingMessage: { id: "msg_1" },
      recentMessages: [],
    } as never)

    const rebuilt = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(rebuilt.result.current.boardPostMap.size).toBe(1))

    // The stale consumer goes away. Its cleanup must touch only the entry it
    // incremented, which is already orphaned.
    failed.unmount()

    // The live consumer's subscription must still be alive: a later write to the
    // row it watches has to reach it. If the stale cleanup tore down the rebuilt
    // entry, this value stays stale forever and nothing says so.
    await db.conversations.put({
      id: "conv_1",
      workspaceId,
      _lastActivityMs: 3,
      _cachedAt: 3,
      conversation: { id: "conv_1", streamId: "stream_moved", messageIds: ["msg_1"] },
      openingMessage: { id: "msg_1" },
      recentMessages: [],
    } as never)
    await waitFor(() =>
      expect(rebuilt.result.current.boardPostMap.get("conv_1")?.conversation.streamId).toBe("stream_moved")
    )
  })
})
