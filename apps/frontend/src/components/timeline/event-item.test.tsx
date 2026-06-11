import { beforeEach, describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import * as messageEventModule from "./message-event"
import * as membershipEventModule from "./membership-event"
import * as memoCapturedEventModule from "./memo-captured-event"
import * as systemEventModule from "./system-event"
import { EventItem } from "./event-item"
import type { StreamEvent } from "@threa/types"

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(messageEventModule, "MessageEvent").mockImplementation((({
    event,
    isHighlighted,
  }: Parameters<typeof messageEventModule.MessageEvent>[0]) => (
    <div data-testid="message-event" data-highlighted={isHighlighted}>
      {(event.payload as { content: string }).content}
    </div>
  )) as unknown as typeof messageEventModule.MessageEvent)
  vi.spyOn(membershipEventModule, "MembershipEvent").mockImplementation((() => (
    <div data-testid="membership-event" />
  )) as unknown as typeof membershipEventModule.MembershipEvent)
  vi.spyOn(systemEventModule, "SystemEvent").mockImplementation((() => (
    <div data-testid="system-event" />
  )) as unknown as typeof systemEventModule.SystemEvent)
  vi.spyOn(memoCapturedEventModule, "MemoCapturedEvent").mockImplementation((() => (
    <div data-testid="memo-captured-event" />
  )) as unknown as typeof memoCapturedEventModule.MemoCapturedEvent)
})

const createMessageEvent = (messageId: string, contentMarkdown: string): StreamEvent => ({
  id: `event_${messageId}`,
  streamId: "stream_123",
  sequence: "1",
  eventType: "message_created",
  actorType: "user",
  actorId: "member_123",
  createdAt: new Date().toISOString(),
  payload: { messageId, contentMarkdown },
})

describe("EventItem", () => {
  const workspaceId = "ws_123"
  const streamId = "stream_123"

  describe("highlight behavior", () => {
    it("should pass isHighlighted=true when highlightMessageId matches the message", () => {
      const event = createMessageEvent("msg_target", "Target message")

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} highlightMessageId="msg_target" />)

      const messageEvent = screen.getByTestId("message-event")
      expect(messageEvent).toHaveAttribute("data-highlighted", "true")
    })

    it("should pass isHighlighted=false when highlightMessageId does not match", () => {
      const event = createMessageEvent("msg_other", "Other message")

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} highlightMessageId="msg_target" />)

      const messageEvent = screen.getByTestId("message-event")
      expect(messageEvent).toHaveAttribute("data-highlighted", "false")
    })

    it("should pass isHighlighted=false when highlightMessageId is null", () => {
      const event = createMessageEvent("msg_123", "Some message")

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} highlightMessageId={null} />)

      const messageEvent = screen.getByTestId("message-event")
      expect(messageEvent).toHaveAttribute("data-highlighted", "false")
    })

    it("should pass isHighlighted=false when highlightMessageId is undefined", () => {
      const event = createMessageEvent("msg_123", "Some message")

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} />)

      const messageEvent = screen.getByTestId("message-event")
      expect(messageEvent).toHaveAttribute("data-highlighted", "false")
    })
  })

  describe("event type rendering", () => {
    it("should render MessageEvent for message_created events", () => {
      const event = createMessageEvent("msg_123", "Hello")

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByTestId("message-event")).toBeInTheDocument()
    })

    it("should render deleted state when message_created has deletedAt", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "Deleted message"),
        payload: { messageId: "msg_123", contentMarkdown: "Deleted message", deletedAt: new Date().toISOString() },
      }

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByText("This message was deleted")).toBeInTheDocument()
    })

    it("should render MessageEvent for companion_response events", () => {
      const event: StreamEvent = {
        ...createMessageEvent("msg_123", "AI response"),
        eventType: "companion_response",
        actorType: "persona",
      }

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByTestId("message-event")).toBeInTheDocument()
    })

    it("should render MemoCapturedEvent for memos:captured events", () => {
      const event: StreamEvent = {
        id: "evt_capture",
        streamId,
        sequence: "10",
        broadcastSequence: "7",
        eventType: "memos:captured",
        actorId: null,
        actorType: "system",
        createdAt: new Date().toISOString(),
        payload: {
          conversationId: "conv_1",
          memos: [{ memoId: "memo_1", title: "A decision", knowledgeType: "decision", sourceMessageIds: ["msg_1"] }],
        },
      }

      render(<EventItem event={event} workspaceId={workspaceId} streamId={streamId} />)

      expect(screen.getByTestId("memo-captured-event")).toBeInTheDocument()
    })
  })
})
