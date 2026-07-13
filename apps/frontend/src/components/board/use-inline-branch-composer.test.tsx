import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactNode } from "react"
import { resetDraftStoreCache } from "@/stores/draft-store"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import { upsertLoadedDraft, purgeScopeDrafts } from "@/hooks/use-draft-message"
import { useInlineBranchComposer } from "./use-inline-branch-composer"
import type { ConversationGraph, StreamStructuralIndex } from "@/hooks/use-conversation-graph"

const workspaceId = "ws_1"
const PARENT_ID = "conv_parent"

// The branch thread forks off `msg_fork_b`, a member of the parent conversation
// — the structural parenthood `collectBranchThreadStreamIds` walks (sub-topic
// conversations carry no parentConversationId).
const index = {
  threadsByParentMessageId: new Map([["msg_fork_b", { id: "stream_thread_1" }]]),
} as unknown as StreamStructuralIndex

function makeGraph(): ConversationGraph {
  const branchPost = {
    id: "conv_branch",
    workspaceId,
    conversation: { id: "conv_branch", streamId: "stream_thread_1", messageIds: ["msg_branch_1"] },
  }
  return {
    conversationByAnchorStreamId: new Map([["stream_thread_1", branchPost]]),
    conversationIdByMemberMessageId: new Map([
      ["msg_fork", PARENT_ID],
      ["msg_fork_b", PARENT_ID],
    ]),
    conversationById: new Map([["conv_branch", branchPost]]),
  } as unknown as ConversationGraph
}

function wrapperWithStash(stashId: string) {
  return ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [`/?stash=${stashId}`] }, children)
}

async function seedDraft(scope: string): Promise<string> {
  const row = await upsertLoadedDraft(workspaceId, scope, {
    contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] },
    attachments: [],
  })
  return row.id
}

function mountHook(stashId: string) {
  return renderHook(
    () =>
      useInlineBranchComposer({
        workspaceId,
        conversationId: PARENT_ID,
        memberMessageIds: ["msg_fork", "msg_fork_b"],
        index,
        graph: makeGraph(),
      }),
    { wrapper: wrapperWithStash(stashId) }
  )
}

describe("useInlineBranchComposer ?stash= deep-link consumer", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    for (const scope of [
      "board:branch-reply:conv_branch",
      "board:subtopic:stream_9:msg_fork",
      `board:reply:${PARENT_ID}`,
    ]) {
      await purgeScopeDrafts(workspaceId, scope)
    }
    vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
      queueDraftMessage: vi.fn(),
      currentUserId: "usr_me",
    } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  })

  it("auto-opens the branch-tail composer for a branch-reply stash owned by one of its branches", async () => {
    const draftId = await seedDraft("board:branch-reply:conv_branch")
    const { result } = mountHook(draftId)
    await waitFor(() =>
      expect(result.current.openComposer).toEqual({
        kind: "branch-reply",
        conversationId: "conv_branch",
        threadStreamId: "stream_thread_1",
      })
    )
  })

  it("auto-opens the new-sub-topic composer for a subtopic stash forked from one of its member messages", async () => {
    const draftId = await seedDraft("board:subtopic:stream_9:msg_fork")
    const { result } = mountHook(draftId)
    await waitFor(() =>
      expect(result.current.openComposer).toEqual({ kind: "new-subtopic", streamId: "stream_9", messageId: "msg_fork" })
    )
  })

  it("ignores stash rows belonging to the panel's own reply scope", async () => {
    // A reply-scope stash is the conversation panel's to consume, not this
    // surface's branch/sub-topic composers.
    const draftId = await seedDraft(`board:reply:${PARENT_ID}`)
    const { result } = mountHook(draftId)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.openComposer).toBeNull()
  })
})
