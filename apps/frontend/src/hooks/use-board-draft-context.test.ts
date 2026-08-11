import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import { resetDraftContextCache, useBoardDraftContext } from "./use-board-draft-context"

const workspaceId = "ws_1"

async function seedConversation(conversationId: string, streamId: string) {
  await db.conversations.put({
    id: conversationId,
    workspaceId,
    _lastActivityMs: 1,
    _cachedAt: 1,
    conversation: { id: conversationId, streamId, topicSummary: null },
  } as unknown as Parameters<typeof db.conversations.put>[0])
}

describe("useBoardDraftContext retention", () => {
  beforeEach(async () => {
    resetDraftContextCache()
    await db.conversations.clear()
    await seedConversation("conv_1", "stream_1")
    await seedConversation("conv_2", "stream_2")
  })

  it("reports loaded on the first render after a remount", async () => {
    const first = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(first.result.current.loaded).toBe(true))
    first.unmount()

    // Without retention this starts at the empty default, and a consumer gating
    // its UI on `loaded` shows a loading state on every warm navigation.
    const again = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    expect(again.result.current.loaded).toBe(true)
    expect(again.result.current.boardPostMap.has("conv_1")).toBe(true)
  })

  it("keeps one consumer's value while another resolves a different signature", async () => {
    // The sidebar, the explorer and every mounted composer read this at once
    // with different signatures — retaining one entry per workspace had them
    // evict each other, so the blip came back whenever a composer was open.
    const explorer = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    await waitFor(() => expect(explorer.result.current.loaded).toBe(true))
    explorer.unmount()

    const composer = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_2"))
    await waitFor(() => expect(composer.result.current.loaded).toBe(true))

    const explorerAgain = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_1"))
    expect(explorerAgain.result.current.loaded).toBe(true)
    expect(explorerAgain.result.current.boardPostMap.has("conv_1")).toBe(true)
  })

  it("resolves to a fresh read for a signature it has not held", async () => {
    const { result } = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_2"))
    expect(result.current.loaded).toBe(false)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.boardPostMap.has("conv_1")).toBe(false)
  })
})
