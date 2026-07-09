import { describe, it, expect, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ServicesProvider } from "@/contexts"
import { useMoveToSubtopic } from "./use-move-to-subtopic"
import * as boardStoreModule from "@/stores/board-store"
import type { BranchConversationView } from "@/lib/board/branch-grouping"

const WS = "ws_1"

function branch(overrides: Partial<BranchConversationView>): BranchConversationView {
  return {
    conversationId: "conv_sub",
    threadStreamId: "thread_1",
    forkMessageId: "m1",
    title: "GPU budget",
    displayDepth: 1,
    overflow: false,
    messages: [],
    hiddenCount: 0,
    children: [],
    ...overrides,
  }
}

function MoveSurface({
  branches,
  currentConversationId,
}: {
  branches: BranchConversationView[]
  currentConversationId: string
}) {
  const move = useMoveToSubtopic({
    workspaceId: WS,
    conversation: { id: "conv_main", streamId: "chan_1", topicSummary: "Main thing" },
    branchesByForkMessageId: new Map([["m1", branches]]),
  })
  const handler = move.moveHandlerFor("m_target", currentConversationId)
  return (
    <>
      {handler ? (
        <button type="button" onClick={handler}>
          Move to sub-topic
        </button>
      ) : (
        <span>no action</span>
      )}
      {move.moveDialog}
    </>
  )
}

function Harness({
  branches,
  currentConversationId,
  reassignMessage,
}: {
  branches: BranchConversationView[]
  currentConversationId: string
  reassignMessage: (...args: unknown[]) => Promise<unknown>
}) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ServicesProvider services={{ conversations: { reassignMessage } as never }}>
        <MoveSurface branches={branches} currentConversationId={currentConversationId} />
      </ServicesProvider>
    </QueryClientProvider>
  )
}

describe("useMoveToSubtopic", () => {
  it("hides the action when the row has nowhere to go", () => {
    // Primary row, no branches: the only conversation under the root is the
    // row's own, so there is no target.
    render(<Harness branches={[]} currentConversationId="conv_main" reassignMessage={vi.fn()} />)
    expect(screen.getByText("no action")).toBeDefined()

    // A pending branch is not a real target either (its id is a draft panel id).
    render(
      <Harness branches={[branch({ pending: true })]} currentConversationId="conv_main" reassignMessage={vi.fn()} />
    )
    expect(screen.getAllByText("no action")).toHaveLength(2)
  })

  it("offers the branches to a primary row and reassigns to the picked one", async () => {
    const reassignMessage = vi.fn().mockResolvedValue({ conversation: { id: "conv_sub" }, previousConversation: null })
    render(<Harness branches={[branch({})]} currentConversationId="conv_main" reassignMessage={reassignMessage} />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    // The row's own conversation (main) is not offered; the branch is.
    expect(screen.queryByText("Main thing")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /GPU budget/ }))

    await waitFor(() => expect(reassignMessage).toHaveBeenCalledWith(WS, "conv_sub", "m_target"))
    // Selecting closes the picker (no confirm step — the move is reversible).
    expect(screen.queryByText("GPU budget")).toBeNull()
  })

  it("offers nested (depth-2) sub-topics as targets, and applies the response to the board store", async () => {
    const merge = vi.spyOn(boardStoreModule, "mergeBoardConversation").mockResolvedValue(true)
    const conversationResult = { id: "conv_grandchild" }
    const previousResult = { id: "conv_main" }
    const reassignMessage = vi
      .fn()
      .mockResolvedValue({ conversation: conversationResult, previousConversation: previousResult })
    const nested = branch({
      children: [branch({ conversationId: "conv_grandchild", threadStreamId: "thread_2", title: "Deep dive" })],
    })
    render(<Harness branches={[nested]} currentConversationId="conv_main" reassignMessage={reassignMessage} />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    await userEvent.click(screen.getByRole("button", { name: /Deep dive/ }))

    await waitFor(() => expect(reassignMessage).toHaveBeenCalledWith(WS, "conv_grandchild", "m_target"))
    // The board store re-files on the HTTP response, not the socket echo.
    await waitFor(() => expect(merge).toHaveBeenCalledWith("conv_grandchild", conversationResult))
    expect(merge).toHaveBeenCalledWith("conv_main", previousResult)
    merge.mockRestore()
  })

  it("ignores re-opens while a move is in flight", async () => {
    // A move that never settles: the action must not open the picker again (a
    // second pick would enqueue a duplicate correction).
    const reassignMessage = vi.fn().mockReturnValue(new Promise(() => {}))
    render(<Harness branches={[branch({})]} currentConversationId="conv_main" reassignMessage={reassignMessage} />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    await userEvent.click(screen.getByRole("button", { name: /GPU budget/ }))
    expect(reassignMessage).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    expect(screen.queryByRole("button", { name: /GPU budget/ })).toBeNull()
    expect(reassignMessage).toHaveBeenCalledTimes(1)
  })

  it("offers the main topic to a branch row", async () => {
    const reassignMessage = vi.fn().mockResolvedValue({ conversation: { id: "conv_main" }, previousConversation: null })
    render(<Harness branches={[branch({})]} currentConversationId="conv_sub" reassignMessage={reassignMessage} />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    // Its own branch is excluded; the main topic is the target.
    expect(screen.queryByText("GPU budget")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /Main thing/ }))

    await waitFor(() => expect(reassignMessage).toHaveBeenCalledWith(WS, "conv_main", "m_target"))
  })
})
