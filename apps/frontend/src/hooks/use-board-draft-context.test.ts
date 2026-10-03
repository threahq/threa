import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import {
  draftScopesSignature,
  resetDraftContextCache,
  useBoardDraftContext,
  type BoardDraftContext,
} from "./use-board-draft-context"

const workspaceId = "ws_1"

async function seedConversation(
  conversationId: string,
  streamId: string,
  overrides: { workspaceId?: string; topicSummary?: string; messageIds?: string[] } = {}
) {
  await db.conversations.put({
    id: conversationId,
    workspaceId: overrides.workspaceId ?? workspaceId,
    _lastActivityMs: 1,
    _cachedAt: 1,
    conversation: {
      id: conversationId,
      streamId,
      topicSummary: overrides.topicSummary ?? null,
      messageIds: overrides.messageIds,
    },
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

  it("does not report a signature as loaded while its read is still in flight", async () => {
    // The live query keeps serving the previous signature's result until the new
    // one settles, so an unstamped read would call a context resolved for the
    // ids we just left "loaded" for the ids we are asking about now.
    const { result, rerender } = renderHook(({ signature }) => useBoardDraftContext(workspaceId, signature), {
      initialProps: { signature: "board:reply:conv_1" },
    })
    await waitFor(() => expect(result.current.loaded).toBe(true))

    rerender({ signature: "board:reply:conv_2" })
    expect({ loaded: result.current.loaded, holdsOldConversation: result.current.boardPostMap.has("conv_1") }).toEqual({
      loaded: false,
      holdsOldConversation: false,
    })

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.boardPostMap.has("conv_2")).toBe(true)
  })

  it("resolves to a fresh read for a signature it has not held", async () => {
    const { result } = renderHook(() => useBoardDraftContext(workspaceId, "board:reply:conv_2"))
    expect(result.current.loaded).toBe(false)
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.boardPostMap.has("conv_1")).toBe(false)
  })
})

describe("useBoardDraftContext workspace isolation", () => {
  beforeEach(async () => {
    resetDraftContextCache()
    await db.conversations.clear()
    await db.streams.clear()
  })

  async function seedThreadStream(streamWorkspaceId: string, parentAnchorId: string) {
    await db.streams.put({
      id: "thread_1",
      workspaceId: streamWorkspaceId,
      parentAnchorId,
    } as unknown as Parameters<typeof db.streams.put>[0])
  }

  function summarize(context: BoardDraftContext) {
    const post = (row: { workspaceId: string; conversation: { topicSummary: string | null } }) => ({
      workspaceId: row.workspaceId,
      topicSummary: row.conversation.topicSummary,
    })
    const posts = (map: Map<string, Parameters<typeof post>[0]>) =>
      Object.fromEntries([...map].map(([key, row]) => [key, post(row)]))
    return {
      loaded: context.loaded,
      boardPostMap: posts(context.boardPostMap),
      hostPostByMessageId: posts(context.hostPostByMessageId),
      parentPostByBranchConversationId: posts(context.parentPostByBranchConversationId),
    }
  }

  it("resolves each workspace's own conversations, hosts and branch parents when two workspaces hold the same ids", async () => {
    await seedConversation("conv_main", "stream_chan", {
      workspaceId: "ws_1",
      topicSummary: "main in ws_1",
      messageIds: ["m_fork", "m_anchor"],
    })
    await seedConversation("conv_branch", "thread_1", { workspaceId: "ws_1", topicSummary: "branch in ws_1" })
    await seedThreadStream("ws_1", "m_anchor")
    await seedConversation("conv_main", "stream_chan", {
      workspaceId: "ws_2",
      topicSummary: "main in ws_2",
      messageIds: ["m_fork", "m_anchor"],
    })
    await seedConversation("conv_branch", "thread_1", { workspaceId: "ws_2", topicSummary: "branch in ws_2" })
    await seedConversation("conv_other", "stream_other", {
      workspaceId: "ws_2",
      topicSummary: "other in ws_2",
      messageIds: ["m_anchor_other"],
    })
    await seedThreadStream("ws_2", "m_anchor_other")
    const signature = draftScopesSignature([
      "board:reply:conv_main",
      "board:branch-reply:conv_branch",
      "board:subtopic:stream_chan:m_fork",
    ])

    const inWs1 = renderHook(() => useBoardDraftContext("ws_1", signature))
    const inWs2 = renderHook(() => useBoardDraftContext("ws_2", signature))
    await waitFor(() => {
      expect(inWs1.result.current.loaded).toBe(true)
      expect(inWs2.result.current.loaded).toBe(true)
    })

    const main1 = { workspaceId: "ws_1", topicSummary: "main in ws_1" }
    const main2 = { workspaceId: "ws_2", topicSummary: "main in ws_2" }
    const other2 = { workspaceId: "ws_2", topicSummary: "other in ws_2" }
    expect({ ws_1: summarize(inWs1.result.current), ws_2: summarize(inWs2.result.current) }).toEqual({
      ws_1: {
        loaded: true,
        boardPostMap: {
          conv_main: main1,
          conv_branch: { workspaceId: "ws_1", topicSummary: "branch in ws_1" },
        },
        hostPostByMessageId: { m_fork: main1, m_anchor: main1 },
        parentPostByBranchConversationId: { conv_branch: main1 },
      },
      ws_2: {
        loaded: true,
        boardPostMap: {
          conv_main: main2,
          conv_branch: { workspaceId: "ws_2", topicSummary: "branch in ws_2" },
          conv_other: other2,
        },
        hostPostByMessageId: { m_fork: main2, m_anchor_other: other2 },
        parentPostByBranchConversationId: { conv_branch: other2 },
      },
    })
  })
})
