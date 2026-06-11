import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
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
  return render(
    <MemoryRouter>
      <MemoCapturedEvent event={createEvent(payload)} workspaceId="ws_1" />
    </MemoryRouter>
  )
}

describe("MemoCapturedEvent", () => {
  it("renders each captured memo title as a link into the memory explorer", () => {
    renderEvent({
      conversationId: "conv_1",
      memos: [
        { memoId: "memo_1", title: "Use prefixed ULIDs", knowledgeType: "decision", sourceMessageIds: ["msg_1"] },
        { memoId: "memo_2", title: "Deploy via Railway", knowledgeType: "procedure", sourceMessageIds: ["msg_2"] },
      ],
    })

    expect(screen.getByText(/Saved to memory:/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Use prefixed ULIDs" })).toHaveAttribute(
      "href",
      "/w/ws_1/memory?memo=memo_1"
    )
    expect(screen.getByRole("link", { name: "Deploy via Railway" })).toHaveAttribute(
      "href",
      "/w/ws_1/memory?memo=memo_2"
    )
  })

  it("renders nothing for an empty capture payload", () => {
    const { container } = renderEvent({ conversationId: "conv_1", memos: [] })

    expect(container).toBeEmptyDOMElement()
  })
})
