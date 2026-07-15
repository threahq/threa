import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ConversationWithStaleness } from "@threa/types"
import { ConversationOverlayRow, ConversationPickerDrawer } from "./conversation-overlay"
import { buildConversationOverlayModel, type ConversationOverlayContext } from "./model"

function makeConversation(overrides: Partial<ConversationWithStaleness>): ConversationWithStaleness {
  return {
    id: "conv_1",
    streamId: "stream_123",
    workspaceId: "ws_1",
    messageIds: [],
    participantIds: [],
    secondaryMessageIds: [],
    topicSummary: null,
    summary: null,
    completenessScore: 1,
    confidence: 0.5,
    status: "active",
    parentConversationId: null,
    lastActivityAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    temporalStaleness: 0,
    effectiveCompleteness: 1,
    ...overrides,
  }
}

function makeOverlay(
  onReassignMessage: ConversationOverlayContext["onReassignMessage"],
  conversations = [
    makeConversation({ id: "conv_a", topicSummary: "Pizza", messageIds: ["msg_1"] }),
    makeConversation({ id: "conv_b", topicSummary: "Deploys", messageIds: ["msg_2"] }),
  ]
): ConversationOverlayContext {
  return {
    model: buildConversationOverlayModel(conversations, "stream_123"),
    focusedConversationId: null,
    onToggleFocus: vi.fn(),
    onReassignMessage,
    pendingMessageIds: new Set(),
    observeRow: () => () => {},
  }
}

describe("conversation correction pickers", () => {
  it("reassigns to an existing conversation by id", () => {
    const onReassignMessage = vi.fn<(messageId: string, toConversationId: string | null) => void>()
    render(
      <ConversationPickerDrawer
        open
        onOpenChange={vi.fn()}
        overlay={makeOverlay(onReassignMessage)}
        annotation={{ conversationId: "conv_a", blockStart: true }}
        messageId="msg_1"
        messageCreatedAt="2026-06-01T00:00:00.000Z"
      />
    )
    fireEvent.click(screen.getByText("Deploys"))
    expect(onReassignMessage).toHaveBeenCalledWith("msg_1", "conv_b")
  })

  it("orders suggestions by createdAt distance from the message", () => {
    const onReassignMessage = vi.fn<(messageId: string, toConversationId: string | null) => void>()
    const conversations = [
      makeConversation({ id: "conv_oldest", topicSummary: "Oldest", createdAt: "2026-06-01T09:00:00.000Z" }),
      makeConversation({ id: "conv_after", topicSummary: "After", createdAt: "2026-06-01T10:01:00.000Z" }),
      makeConversation({ id: "conv_before", topicSummary: "Before", createdAt: "2026-06-01T09:59:00.000Z" }),
    ]
    render(
      <ConversationPickerDrawer
        open
        onOpenChange={vi.fn()}
        overlay={makeOverlay(onReassignMessage, conversations)}
        annotation={{ conversationId: null, blockStart: false }}
        messageId="msg_1"
        messageCreatedAt="2026-06-01T10:00:00.000Z"
      />
    )

    expect(screen.getAllByText(/^(Before|After|Oldest)$/).map((element) => element.textContent)).toEqual([
      "Before",
      "After",
      "Oldest",
    ])
  })

  it("orders rail-dropdown suggestions by createdAt distance from the message", async () => {
    const onReassignMessage = vi.fn<(messageId: string, toConversationId: string | null) => void>()
    const conversations = [
      makeConversation({ id: "conv_oldest", topicSummary: "Oldest", createdAt: "2026-06-01T09:00:00.000Z" }),
      makeConversation({ id: "conv_after", topicSummary: "After", createdAt: "2026-06-01T10:01:00.000Z" }),
      makeConversation({ id: "conv_before", topicSummary: "Before", createdAt: "2026-06-01T09:59:00.000Z" }),
    ]
    render(
      <ConversationOverlayRow
        overlay={makeOverlay(onReassignMessage, conversations)}
        annotation={{ conversationId: null, blockStart: false }}
        messageId="msg_1"
        messageCreatedAt="2026-06-01T10:00:00.000Z"
      >
        <span>Message</span>
      </ConversationOverlayRow>
    )

    await userEvent.click(screen.getByRole("button", { name: "Correct conversation for this message" }))

    expect(screen.getAllByText(/^(Before|After|Oldest)$/).map((element) => element.textContent)).toEqual([
      "Before",
      "After",
      "Oldest",
    ])
  })

  it("moves the message to a new conversation with a null target", () => {
    const onReassignMessage = vi.fn<(messageId: string, toConversationId: string | null) => void>()
    render(
      <ConversationPickerDrawer
        open
        onOpenChange={vi.fn()}
        overlay={makeOverlay(onReassignMessage)}
        annotation={{ conversationId: "conv_a", blockStart: true }}
        messageId="msg_1"
        messageCreatedAt="2026-06-01T00:00:00.000Z"
      />
    )
    fireEvent.click(screen.getByText("New conversation"))
    expect(onReassignMessage).toHaveBeenCalledWith("msg_1", null)
  })
})
