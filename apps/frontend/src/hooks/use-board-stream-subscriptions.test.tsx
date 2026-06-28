import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import type { ConversationWithStaleness } from "@threa/types"
import { SyncEngineContext, type SyncEngine } from "@/sync/sync-engine"
import { useBoardStreamSubscriptions } from "./use-board-stream-subscriptions"
import type { BoardViewPost } from "./use-stable-board-view"

function makePost(conversationId: string, streamId: string): BoardViewPost {
  return {
    conversation: { id: conversationId, streamId, messageIds: [] } as unknown as ConversationWithStaleness,
    openingMessage: null,
    recentMessages: [],
    totalReplies: 0,
  } as unknown as BoardViewPost
}

function harness() {
  const setBoardStreamIds = vi.fn()
  const engine = { setBoardStreamIds } as unknown as SyncEngine
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SyncEngineContext.Provider value={engine}>{children}</SyncEngineContext.Provider>
  )
  return { setBoardStreamIds, wrapper }
}

describe("useBoardStreamSubscriptions", () => {
  it("declares each on-screen card's stream to the engine, deduped", () => {
    const { setBoardStreamIds, wrapper } = harness()
    const posts = [makePost("conv_1", "stream_a"), makePost("conv_2", "stream_b"), makePost("conv_3", "stream_a")]

    renderHook(() => useBoardStreamSubscriptions(posts), { wrapper })

    expect(setBoardStreamIds).toHaveBeenCalledWith(["stream_a", "stream_b"])
  })

  it("re-declares only when the visible stream set changes, not on every commit", () => {
    const { setBoardStreamIds, wrapper } = harness()
    const initial = [makePost("conv_1", "stream_a")]
    const { rerender } = renderHook(({ posts }) => useBoardStreamSubscriptions(posts), {
      wrapper,
      initialProps: { posts: initial },
    })
    expect(setBoardStreamIds).toHaveBeenCalledTimes(1)

    // A fresh array of the same streams (a frozen-view re-commit) — no re-declare.
    rerender({ posts: [makePost("conv_1", "stream_a")] })
    expect(setBoardStreamIds).toHaveBeenCalledTimes(1)

    // A genuinely new stream on screen — re-declare with the wider set.
    rerender({ posts: [makePost("conv_1", "stream_a"), makePost("conv_2", "stream_c")] })
    expect(setBoardStreamIds).toHaveBeenLastCalledWith(["stream_a", "stream_c"])
  })

  it("clears the declaration on unmount so a closed board doesn't widen the reconnect set", () => {
    const { setBoardStreamIds, wrapper } = harness()
    const { unmount } = renderHook(() => useBoardStreamSubscriptions([makePost("conv_1", "stream_a")]), { wrapper })

    setBoardStreamIds.mockClear()
    unmount()

    expect(setBoardStreamIds).toHaveBeenCalledWith([])
  })
})
