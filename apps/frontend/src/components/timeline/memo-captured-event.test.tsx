import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoCapturedEvent } from "./memo-captured-event"
import type { MemosCapturedEventPayload, StreamEvent } from "@threa/types"

function createEvent(payload: MemosCapturedEventPayload): StreamEvent {
  return {
    id: "evt_capture",
    streamId: "stream_1",
    sequence: "10",
    broadcastSequence: "7",
    eventType: "memos:captured",
    actorId: null,
    actorType: "system",
    createdAt: new Date().toISOString(),
    payload,
  }
}

function renderEvent(payload: MemosCapturedEventPayload) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MemoCapturedEvent event={createEvent(payload)} workspaceId="ws_1" />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe("MemoCapturedEvent", () => {
  it("renders each captured memo title as a button that opens the memo preview in place", async () => {
    const user = userEvent.setup()
    renderEvent({
      conversationId: "conv_1",
      memos: [
        { memoId: "memo_1", title: "Use prefixed ULIDs", knowledgeType: "decision", sourceMessageIds: ["msg_1"] },
        { memoId: "memo_2", title: "Deploy via Railway", knowledgeType: "procedure", sourceMessageIds: ["msg_2"] },
      ],
    })

    expect(screen.getByText(/Saved to memory:/)).toBeInTheDocument()
    // Titles are buttons (open the preview), not links away to the explorer.
    expect(screen.queryByRole("link", { name: "Use prefixed ULIDs" })).toBeNull()
    const trigger = screen.getByRole("button", { name: "Use prefixed ULIDs" })
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog")

    await user.click(trigger)

    // The preview dialog opens in place; its footer offers the explorer link.
    const explorerLink = await waitFor(() => screen.getByRole("link", { name: /Open in memory/i }))
    expect(explorerLink).toHaveAttribute("href", "/w/ws_1/memory?memo=memo_1")
  })

  it("renders nothing for an empty capture payload", () => {
    const { container } = renderEvent({ conversationId: "conv_1", memos: [] })

    expect(container).toBeEmptyDOMElement()
  })
})
