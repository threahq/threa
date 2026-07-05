import { beforeEach, describe, expect, it } from "vitest"
import { db } from "@/db"
import { seedBoardExclusions, putHidden, deleteHidden, putMuted, deleteMuted } from "./board-exclusions-store"

beforeEach(async () => {
  await db.boardHiddenConversations.clear()
  await db.boardMutedStreams.clear()
})

describe("board-exclusions-store", () => {
  it("seeds hidden + muted rows and drops stale ones (bootstrap is authoritative)", async () => {
    await putHidden("ws_1", "conv_stale", 100)
    await putMuted("ws_1", "stream_stale")

    await seedBoardExclusions("ws_1", {
      hiddenConversations: [{ conversationId: "conv_1", hiddenAt: "2026-07-05T00:00:00.000Z" }],
      mutedStreamIds: ["stream_1"],
    })

    expect((await db.boardHiddenConversations.get("conv_1"))?.hiddenAt).toBe(Date.parse("2026-07-05T00:00:00.000Z"))
    expect(await db.boardMutedStreams.get("stream_1")).toBeDefined()
    // Rows the server no longer returns are gone.
    expect(await db.boardHiddenConversations.get("conv_stale")).toBeUndefined()
    expect(await db.boardMutedStreams.get("stream_stale")).toBeUndefined()
  })

  it("round-trips optimistic put/delete for both grains", async () => {
    await putHidden("ws_1", "conv_1", 500)
    expect((await db.boardHiddenConversations.get("conv_1"))?.hiddenAt).toBe(500)
    await deleteHidden("conv_1")
    expect(await db.boardHiddenConversations.get("conv_1")).toBeUndefined()

    await putMuted("ws_1", "stream_1")
    expect(await db.boardMutedStreams.get("stream_1")).toBeDefined()
    await deleteMuted("stream_1")
    expect(await db.boardMutedStreams.get("stream_1")).toBeUndefined()
  })
})
