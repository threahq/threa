import { describe, it, expect } from "vitest"
import { createOptimisticBootstrap } from "./create-optimistic-bootstrap"
import type { Stream } from "@threa/types"

const mockStream: Stream = {
  id: "stream_01TEST",
  workspaceId: "ws_01TEST",
  slug: "test-stream",
  type: "scratchpad",
  displayName: "Test Stream",
  description: null,
  visibility: "private",
  companionMode: "on",
  companionPersonaId: null,
  parentStreamId: null,
  parentMessageId: null,
  rootStreamId: null,
  createdBy: "member_01TEST",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
  archivedAt: null,
}

describe("createOptimisticBootstrap", () => {
  it("should use temp_ prefix for event ID to enable WebSocket deduplication", () => {
    // This is critical - without temp_ prefix, the WebSocket handler cannot
    // dedupe by content matching, causing duplicate messages to appear
    const result = createOptimisticBootstrap({
      stream: mockStream,
      message: { id: "msg_01TEST", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Hello world",
    })

    expect(result.events[0].id).toMatch(/^temp_/)
  })

  it("should generate unique event IDs on each call", () => {
    const params = {
      stream: mockStream,
      message: { id: "msg_01TEST", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Hello world",
    }

    const result1 = createOptimisticBootstrap(params)
    const result2 = createOptimisticBootstrap(params)

    expect(result1.events[0].id).not.toBe(result2.events[0].id)
  })

  it("should include message ID in payload, not as event ID", () => {
    const result = createOptimisticBootstrap({
      stream: mockStream,
      message: { id: "msg_01SPECIFIC", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Hello world",
    })

    const payload = result.events[0].payload as { messageId: string }
    expect(payload.messageId).toBe("msg_01SPECIFIC")
    expect(result.events[0].id).not.toBe("msg_01SPECIFIC")
  })

  it("should include attachments in payload when provided", () => {
    const result = createOptimisticBootstrap({
      stream: mockStream,
      message: { id: "msg_01TEST", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Check out this image",
      attachments: [{ id: "att_01TEST", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 12345 }],
    })

    const payload = result.events[0].payload as { attachments?: unknown[] }
    expect(payload.attachments).toHaveLength(1)
  })

  it("should set actorId from stream.createdBy", () => {
    const result = createOptimisticBootstrap({
      stream: { ...mockStream, createdBy: "member_AUTHOR" },
      message: { id: "msg_01TEST", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Hello",
    })

    expect(result.events[0].actorId).toBe("member_AUTHOR")
  })

  it("should include membership with lastReadEventId set to the optimistic event", () => {
    const result = createOptimisticBootstrap({
      stream: mockStream,
      message: { id: "msg_01TEST", createdAt: "2024-01-01T00:00:00Z" },
      contentMarkdown: "Hello",
    })

    expect(result.membership).toEqual({
      streamId: mockStream.id,
      memberId: mockStream.createdBy,
      notificationLevel: null,
      lastReadEventId: result.events[0].id,
      lastReadAt: "2024-01-01T00:00:00Z",
      joinedAt: "2024-01-01T00:00:00Z",
    })
    expect(result.members).toHaveLength(1)
  })
})
