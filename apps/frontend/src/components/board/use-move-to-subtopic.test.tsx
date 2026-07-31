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

/** A board-store row as `useBoardPosts` returns it — only the fields the sibling
 *  target list reads. */
function post(
  id: string,
  overrides: {
    streamId?: string
    topicSummary?: string | null
    messageIds?: string[]
    status?: "pending"
    lastActivityMs?: number
  } = {}
) {
  return {
    id,
    workspaceId: WS,
    conversation: {
      id,
      streamId: overrides.streamId ?? "chan_1",
      topicSummary: overrides.topicSummary === undefined ? `Topic ${id}` : overrides.topicSummary,
      messageIds: overrides.messageIds ?? ["m_x"],
    },
    _status: overrides.status,
    _lastActivityMs: overrides.lastActivityMs ?? 0,
  } as never
}

function MoveSurface({
  branches,
  currentConversationId,
  settling,
}: {
  branches: BranchConversationView[]
  currentConversationId: string
  settling?: boolean
}) {
  const move = useMoveToSubtopic({
    workspaceId: WS,
    conversation: { id: "conv_main", streamId: "chan_1", topicSummary: "Main thing" },
    branchesByForkMessageId: new Map([["m1", branches]]),
  })
  const handler = move.moveHandlerFor("m_target", currentConversationId, settling)
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
  settling,
}: {
  branches: BranchConversationView[]
  currentConversationId: string
  reassignMessage: (...args: unknown[]) => Promise<unknown>
  settling?: boolean
}) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ServicesProvider services={{ conversations: { reassignMessage } as never }}>
        <MoveSurface branches={branches} currentConversationId={currentConversationId} settling={settling} />
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

describe("useMoveToSubtopic on a settling row", () => {
  function stubBoard(posts: unknown[]) {
    return vi.spyOn(boardStoreModule, "useBoardPosts").mockReturnValue(posts as never)
  }

  it("offers the stream's other conversations when the row has no sub-topics, and re-files into the picked sibling", async () => {
    const spy = stubBoard([post("conv_main"), post("conv_sibling", { topicSummary: "Deploy plan" })])
    const reassignMessage = vi
      .fn()
      .mockResolvedValue({ conversation: { id: "conv_sibling" }, previousConversation: null })
    render(<Harness branches={[]} currentConversationId="conv_main" reassignMessage={reassignMessage} settling />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))
    await userEvent.click(screen.getByRole("button", { name: /Deploy plan/ }))

    await waitFor(() => expect(reassignMessage).toHaveBeenCalledWith(WS, "conv_sibling", "m_target"))
    spy.mockRestore()
  })

  it("skips other streams, the row's own conversation, and pending or empty rows", () => {
    const spy = stubBoard([
      post("conv_main"),
      post("conv_other_stream", { streamId: "chan_2", topicSummary: "Elsewhere" }),
      post("conv_pending", { topicSummary: "Pending", status: "pending" }),
      post("conv_empty", { topicSummary: "Empty", messageIds: [] }),
    ])
    render(<Harness branches={[]} currentConversationId="conv_main" reassignMessage={vi.fn()} settling />)

    expect(screen.getByText("no action")).toBeDefined()
    spy.mockRestore()
  })

  it("caps the sibling list at eight, newest activity first", async () => {
    const spy = stubBoard([
      post("conv_main"),
      ...Array.from({ length: 12 }, (_, i) => post(`conv_s${i}`, { topicSummary: `Sibling ${i}`, lastActivityMs: i })),
    ])
    render(<Harness branches={[]} currentConversationId="conv_main" reassignMessage={vi.fn()} settling />)

    await userEvent.click(screen.getByRole("button", { name: "Move to sub-topic" }))

    const titles = screen.getAllByRole("button").map((b) => b.textContent)
    expect(titles.filter((t) => t?.startsWith("Sibling"))).toEqual([
      "Sibling 11",
      "Sibling 10",
      "Sibling 9",
      "Sibling 8",
      "Sibling 7",
      "Sibling 6",
      "Sibling 5",
      "Sibling 4",
    ])
    spy.mockRestore()
  })

  it("leaves a settled row's targets untouched — siblings are a settling-only widening", () => {
    const spy = stubBoard([post("conv_main"), post("conv_sibling", { topicSummary: "Deploy plan" })])
    render(<Harness branches={[]} currentConversationId="conv_main" reassignMessage={vi.fn()} />)

    expect(screen.getByText("no action")).toBeDefined()
    spy.mockRestore()
  })
})
