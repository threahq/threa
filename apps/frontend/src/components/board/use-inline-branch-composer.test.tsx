import { describe, it, expect, vi, beforeEach } from "vitest"
import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactNode } from "react"
import { resetDraftStoreCache } from "@/stores/draft-store"
import * as queueDraftModule from "@/hooks/use-queue-draft-message"
import { upsertLoadedDraft, purgeScopeDrafts, stashLoadedDraft } from "@/hooks/use-draft-message"
import { useScopeDraftPreview } from "@/hooks"
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
      "board:subtopic:stream_9:msg_fork_b",
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

  it("marks a fork message carrying an unsent sub-topic draft and reopens the gesture with a restore", async () => {
    const draftId = await seedDraft("board:subtopic:stream_9:msg_fork")
    // Detach the loaded pointer — the row is a stash (roamed-draft shape), so
    // reopening must carry it for an explicit check-out.
    await stashLoadedDraft(workspaceId, "board:subtopic:stream_9:msg_fork")
    const { result } = mountHook("draft_none")

    // The indicator renders under the fork message once the index resolves.
    await waitFor(() => expect(result.current.renderAfterMessage("msg_fork")).not.toBeNull())
    render(<MemoryRouter>{result.current.renderAfterMessage("msg_fork")}</MemoryRouter>)
    fireEvent.click(screen.getByText("hi"))

    await waitFor(() =>
      expect(result.current.openComposer).toEqual({
        kind: "new-subtopic",
        streamId: "stream_9",
        messageId: "msg_fork",
        restoreStashedId: draftId,
      })
    )
  })

  it("migrates a sub-topic draft onto the branch once it materializes, and never shows the indicator beside it", async () => {
    // A draft to CREATE a sub-conversation under msg_fork_b, whose branch
    // already exists (the fixture graph renders it) — the exact stash-before-
    // materialize state from Kris's screenshots.
    await seedDraft("board:subtopic:stream_9:msg_fork_b")
    const { result } = mountHook("draft_none")

    // The draft follows the branch onto its tail scope…
    const probe = renderHook(() => useScopeDraftPreview(workspaceId, "board:branch-reply:conv_branch"), {
      wrapper: wrapperWithStash("draft_none"),
    })
    await waitFor(() => expect(probe.result.current?.preview).toBe("hi"))
    // …and the fork message renders no "create a sub-conversation" affordance.
    expect(result.current.renderAfterMessage("msg_fork_b")).toBeNull()
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
