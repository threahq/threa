import { describe, test, expect } from "bun:test"
import { parseMessagePayload } from "./payload-parsers"
import { AuthorTypes } from "@threa/types"

describe("parseMessagePayload", () => {
  describe("modern format", () => {
    test("should parse valid modern payload", () => {
      const contentJson = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
      }
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          id: "event_789",
          sequence: "42",
          actorType: "user",
          actorId: "usr_abc",
          payload: {
            messageId: "msg_def",
            contentMarkdown: "Hello world",
            contentJson,
          },
        },
      }

      const result = parseMessagePayload(payload)

      expect(result).toEqual({
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          id: "event_789",
          sequence: "42",
          actorType: "user",
          actorId: "usr_abc",
          payload: {
            messageId: "msg_def",
            contentMarkdown: "Hello world",
            contentJson,
          },
        },
      })
    })

    test("should parse persona message", () => {
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          id: "event_789",
          sequence: "10",
          actorType: "persona",
          actorId: "persona_xyz",
          payload: {
            messageId: "msg_def",
            contentMarkdown: "AI response",
          },
        },
      }

      const result = parseMessagePayload(payload)

      expect(result?.event.actorType).toBe(AuthorTypes.PERSONA)
      expect(result?.event.actorId).toBe("persona_xyz")
    })

    test("should default missing optional fields", () => {
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          payload: {
            messageId: "msg_def",
          },
        },
      }

      const result = parseMessagePayload(payload)

      expect(result).toEqual({
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          id: "",
          sequence: "0",
          actorType: "user",
          actorId: null,
          payload: {
            messageId: "msg_def",
            contentMarkdown: "",
            contentJson: null,
          },
        },
      })
    })

    test("should null out non-object contentJson", () => {
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          payload: {
            messageId: "msg_def",
            contentMarkdown: "Hello",
            contentJson: "not-a-doc",
          },
        },
      }

      const result = parseMessagePayload(payload)

      expect(result?.event.payload.contentJson).toBeNull()
    })
  })

  describe("invalid payloads", () => {
    test("should return null for null payload", () => {
      const result = parseMessagePayload(null)
      expect(result).toBeNull()
    })

    test("should return null for non-object payload", () => {
      const result = parseMessagePayload("string")
      expect(result).toBeNull()
    })

    test("should return null when workspaceId missing", () => {
      const payload = {
        streamId: "stream_456",
        event: { payload: { messageId: "msg_123" } },
      }
      const result = parseMessagePayload(payload)
      expect(result).toBeNull()
    })

    test("should return null when streamId missing", () => {
      const payload = {
        workspaceId: "ws_123",
        event: { payload: { messageId: "msg_123" } },
      }
      const result = parseMessagePayload(payload)
      expect(result).toBeNull()
    })

    test("should return null when messageId missing from both formats", () => {
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: { payload: {} },
      }
      const result = parseMessagePayload(payload)
      expect(result).toBeNull()
    })
  })
})
