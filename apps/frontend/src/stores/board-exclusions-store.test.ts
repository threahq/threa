import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import {
  seedBoardExclusions,
  putHidden,
  deleteHidden,
  putMuted,
  deleteMuted,
  useBoardHiddenConversations,
  useBoardMutedStreamIds,
} from "./board-exclusions-store"

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

    expect((await db.boardHiddenConversations.get(["ws_1", "conv_1"]))?.hiddenAt).toBe(
      Date.parse("2026-07-05T00:00:00.000Z")
    )
    expect(await db.boardMutedStreams.get(["ws_1", "stream_1"])).toBeDefined()
    // Rows the server no longer returns are gone.
    expect(await db.boardHiddenConversations.get(["ws_1", "conv_stale"])).toBeUndefined()
    expect(await db.boardMutedStreams.get(["ws_1", "stream_stale"])).toBeUndefined()
  })

  it("round-trips optimistic put/delete for both grains", async () => {
    await putHidden("ws_1", "conv_1", 500)
    expect((await db.boardHiddenConversations.get(["ws_1", "conv_1"]))?.hiddenAt).toBe(500)
    await deleteHidden("ws_1", "conv_1")
    expect(await db.boardHiddenConversations.get(["ws_1", "conv_1"])).toBeUndefined()

    await putMuted("ws_1", "stream_1")
    expect(await db.boardMutedStreams.get(["ws_1", "stream_1"])).toBeDefined()
    await deleteMuted("ws_1", "stream_1")
    expect(await db.boardMutedStreams.get(["ws_1", "stream_1"])).toBeUndefined()
  })

  it("keeps a workspace's mute when the same stream id is unmuted or reseeded in another workspace", async () => {
    await putMuted("ws_a", "stream_shared")
    await putMuted("ws_b", "stream_shared")

    await deleteMuted("ws_a", "stream_shared")
    expect(await db.boardMutedStreams.toArray()).toEqual([
      expect.objectContaining({ workspaceId: "ws_b", id: "stream_shared" }),
    ])

    await putMuted("ws_a", "stream_shared")
    await seedBoardExclusions("ws_a", { hiddenConversations: [], mutedStreamIds: [] })
    expect(await db.boardMutedStreams.toArray()).toEqual([
      expect.objectContaining({ workspaceId: "ws_b", id: "stream_shared" }),
    ])
  })
})

describe("board-exclusions-store workspace isolation", () => {
  it("keeps a workspace's hide when the same conversation id is unhidden or reseeded in another workspace", async () => {
    await putHidden("ws_a", "conv_shared", 100)
    await putHidden("ws_b", "conv_shared", 200)

    await deleteHidden("ws_a", "conv_shared")
    expect(await db.boardHiddenConversations.toArray()).toEqual([
      expect.objectContaining({ workspaceId: "ws_b", id: "conv_shared", hiddenAt: 200 }),
    ])

    await putHidden("ws_a", "conv_shared", 300)
    await seedBoardExclusions("ws_a", { hiddenConversations: [], mutedStreamIds: [] })
    expect(await db.boardHiddenConversations.toArray()).toEqual([
      expect.objectContaining({ workspaceId: "ws_b", id: "conv_shared", hiddenAt: 200 }),
    ])
  })

  it("keeps each workspace's hide watermark when a copied conversation is seeded into both", async () => {
    await seedBoardExclusions("ws_a", {
      hiddenConversations: [{ conversationId: "conv_shared", hiddenAt: "2026-07-05T00:00:00.000Z" }],
      mutedStreamIds: [],
    })
    await seedBoardExclusions("ws_b", {
      hiddenConversations: [{ conversationId: "conv_shared", hiddenAt: "2026-07-06T00:00:00.000Z" }],
      mutedStreamIds: [],
    })

    expect(
      (await db.boardHiddenConversations.toArray()).map((row) => ({
        workspaceId: row.workspaceId,
        hiddenAt: row.hiddenAt,
      }))
    ).toEqual([
      { workspaceId: "ws_a", hiddenAt: Date.parse("2026-07-05T00:00:00.000Z") },
      { workspaceId: "ws_b", hiddenAt: Date.parse("2026-07-06T00:00:00.000Z") },
    ])
  })
})

describe("board-exclusions-store reads across a workspace switch", () => {
  it("should report no hidden conversations right after the workspace changes, then settle on the new workspace's", async () => {
    await putHidden("ws_a", "conv_a", 100)
    await putHidden("ws_b", "conv_b", 200)
    const { result, rerender } = renderHook(({ workspaceId }) => useBoardHiddenConversations(workspaceId), {
      initialProps: { workspaceId: "ws_a" },
    })
    await waitFor(() => expect(result.current).toEqual(new Map([["conv_a", 100]])))

    rerender({ workspaceId: "ws_b" })
    const rightAfterSwitch = result.current

    expect(rightAfterSwitch).toEqual(new Map())
    await waitFor(() => expect(result.current).toEqual(new Map([["conv_b", 200]])))
  })

  it("should report no muted streams right after the workspace changes, then settle on the new workspace's", async () => {
    await putMuted("ws_a", "stream_a")
    await putMuted("ws_b", "stream_b")
    const { result, rerender } = renderHook(({ workspaceId }) => useBoardMutedStreamIds(workspaceId), {
      initialProps: { workspaceId: "ws_a" },
    })
    await waitFor(() => expect(result.current).toEqual(new Set(["stream_a"])))

    rerender({ workspaceId: "ws_b" })
    const rightAfterSwitch = result.current

    expect(rightAfterSwitch).toEqual(new Set())
    await waitFor(() => expect(result.current).toEqual(new Set(["stream_b"])))
  })
})
