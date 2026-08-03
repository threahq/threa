import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { createElement, type ReactElement, type ReactNode } from "react"
import { createDraftPanelId } from "@/contexts"
import type { BranchConversationView } from "@/lib/board/branch-grouping"
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
  threadsByAnchorId: new Map([["msg_fork_b", { id: "stream_thread_1" }]]),
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

  it("neither opens nor consumes a stash deep-link while the surface is archived", async () => {
    const draftId = await seedDraft("board:branch-reply:conv_branch")
    const { result, rerender } = renderHook(
      ({ archived }: { archived: boolean }) =>
        useInlineBranchComposer({
          workspaceId,
          conversationId: PARENT_ID,
          memberMessageIds: ["msg_fork", "msg_fork_b"],
          index,
          graph: makeGraph(),
          archived,
        }),
      { wrapper: wrapperWithStash(draftId), initialProps: { archived: true } }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(result.current.openComposer).toBeNull()

    // The param was never consumed, so unarchiving still honours the deep link.
    rerender({ archived: false })
    await waitFor(() =>
      expect(result.current.openComposer).toEqual({
        kind: "branch-reply",
        conversationId: "conv_branch",
        threadStreamId: "stream_thread_1",
      })
    )
  })

  it("drops an open inline composer when the surface becomes archived mid-session", async () => {
    const { result, rerender } = renderHook(
      ({ archived }: { archived: boolean }) =>
        useInlineBranchComposer({
          workspaceId,
          conversationId: PARENT_ID,
          memberMessageIds: ["msg_fork", "msg_fork_b"],
          index,
          graph: makeGraph(),
          archived,
        }),
      { wrapper: wrapperWithStash("draft_none"), initialProps: { archived: false } }
    )
    act(() => result.current.openNewSubtopic("stream_9", "msg_fork"))
    expect(result.current.extraDraftPanelIds).toEqual([createDraftPanelId("stream_9", "msg_fork")])

    rerender({ archived: true })
    // No stranded state: no open composer, and no dead draft-panel rail left
    // subscribed — so nothing stays force-pinned after an unarchive either.
    await waitFor(() => expect(result.current.openComposer).toBeNull())
    expect(result.current.extraDraftPanelIds).toEqual([])
    rerender({ archived: false })
    expect(result.current.openComposer).toBeNull()
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

describe("useInlineBranchComposer pending→real hand-off", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    await purgeScopeDrafts(workspaceId, "board:subtopic:stream_9:msg_new")
    vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
      queueDraftMessage: vi.fn().mockResolvedValue(undefined),
      currentUserId: "usr_me",
    } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  })

  const emptyIndex = { threadsByAnchorId: new Map() } as unknown as StreamStructuralIndex
  const emptyGraph = {
    conversationByAnchorStreamId: new Map(),
    conversationIdByMemberMessageId: new Map([["msg_new", PARENT_ID]]),
    conversationById: new Map(),
  } as unknown as ConversationGraph
  const materializedIndex = {
    threadsByAnchorId: new Map([["msg_new", { id: "stream_thread_new" }]]),
  } as unknown as StreamStructuralIndex
  const materializedGraph = {
    conversationByAnchorStreamId: new Map([
      [
        "stream_thread_new",
        { id: "conv_new", conversation: { id: "conv_new", streamId: "stream_thread_new", messageIds: ["m_real"] } },
      ],
    ]),
    conversationIdByMemberMessageId: new Map([["msg_new", PARENT_ID]]),
    conversationById: new Map(),
  } as unknown as ConversationGraph

  it("re-keys an open branch-tail composer onto the real conversation when the graph replaces the pending branch", async () => {
    const draftPanelId = createDraftPanelId("stream_9", "msg_new")
    const { result, rerender } = renderHook(
      ({ index: i, graph: g }: { index: StreamStructuralIndex; graph: ConversationGraph }) =>
        useInlineBranchComposer({
          workspaceId,
          conversationId: PARENT_ID,
          memberMessageIds: ["msg_new"],
          index: i,
          graph: g,
        }),
      { wrapper: wrapperWithStash("draft_none"), initialProps: { index: emptyIndex, graph: emptyGraph } }
    )

    // Send the sub-topic through the gesture's own form (its `onSubmit` is the
    // only path that registers the pending entry).
    act(() => result.current.openNewSubtopic("stream_9", "msg_new"))
    const form = result.current.renderAfterMessage("msg_new") as ReactElement<{
      onSubmit: (input: unknown) => Promise<void>
    }>
    await act(() => form.props.onSubmit({ contentJson: { type: "doc", content: [] } }))

    const optimistic = { id: "m_opt", streamId: draftPanelId, createdAt: "2026-07-28T10:00:00.000Z" }
    const pendingBranch = result.current.derivePendingBranches(
      new Map([["m_opt", optimistic as never]])
    )[0] as BranchConversationView
    expect(pendingBranch.pending).toBe(true)
    act(() => result.current.openBranchReply(pendingBranch))
    expect(result.current.openComposer).toMatchObject({ kind: "branch-reply", conversationId: draftPanelId })

    // The echo lands: the graph's real branch replaces the synthetic one.
    rerender({ index: materializedIndex, graph: materializedGraph })
    await waitFor(() =>
      expect(result.current.openComposer).toMatchObject({
        kind: "branch-reply",
        conversationId: "conv_new",
        threadStreamId: "stream_thread_new",
      })
    )
    // …and the real branch's tail still renders the mounted composer (the
    // affordance has no `onSubmit`), so the editor never unmounted.
    const tail = result.current.renderBranchTail({
      ...pendingBranch,
      conversationId: "conv_new",
      threadStreamId: "stream_thread_new",
      pending: false,
    }) as ReactElement<Record<string, unknown>>
    expect(tail.props).toHaveProperty("onSubmit")
  })
})

describe("useInlineBranchComposer panel arming (onArmBranchReply)", () => {
  let queueDraftMessage: ReturnType<typeof vi.fn>
  let onArmBranchReply: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.restoreAllMocks()
    resetDraftStoreCache()
    await purgeScopeDrafts(workspaceId, "board:branch-reply:conv_branch")
    queueDraftMessage = vi.fn().mockResolvedValue(undefined)
    onArmBranchReply = vi.fn()
    vi.spyOn(queueDraftModule, "useQueueDraftMessage").mockReturnValue({
      queueDraftMessage,
      currentUserId: "usr_me",
    } as unknown as ReturnType<typeof queueDraftModule.useQueueDraftMessage>)
  })

  function mountArmed(stashId: string) {
    return renderHook(
      () =>
        useInlineBranchComposer({
          workspaceId,
          conversationId: PARENT_ID,
          memberMessageIds: ["msg_fork", "msg_fork_b"],
          index,
          graph: makeGraph(),
          onArmBranchReply: onArmBranchReply as never,
        }),
      { wrapper: wrapperWithStash(stashId) }
    )
  }

  it("arms the footer for a branch-reply stash instead of mounting the inline composer", async () => {
    const draftId = await seedDraft("board:branch-reply:conv_branch")
    const { result } = mountArmed(draftId)
    await waitFor(() =>
      expect(onArmBranchReply).toHaveBeenCalledWith(
        { conversationId: "conv_branch", threadStreamId: "stream_thread_1", title: expect.any(String) },
        draftId
      )
    )
    // Armed, not opened inline — the docked footer owns the editor.
    expect(result.current.openComposer).toBeNull()
  })

  it("queueExistingBranchReply routes an existing-conversation directive into the branch thread", async () => {
    const { result } = mountArmed("draft_none")
    const input = { contentJson: { type: "doc", content: [] } }
    await result.current.queueExistingBranchReply("conv_branch", "stream_thread_1", input)
    expect(queueDraftMessage).toHaveBeenCalledWith(input, {
      workspaceId,
      streamId: "stream_thread_1",
      conversation: { intent: "existing", conversationId: "conv_branch" },
    })
  })
})
