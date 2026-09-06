import { describe, test, expect } from "bun:test"
import { parseMessagePayload } from "./payload-parsers"
import { AuthorTypes } from "@threahq/types"

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
            metadata: {},
          },
        },
      })
    })

    test("parses the message:edited payload shape", () => {
      const contentJson = { type: "doc", content: [{ type: "paragraph", content: [] }] }
      expect(
        parseMessagePayload({
          workspaceId: "ws_123",
          streamId: "stream_456",
          event: {
            id: "event_edit",
            sequence: "43",
            actorType: "user",
            actorId: "usr_abc",
            payload: {
              messageId: "msg_def",
              contentMarkdown: "Edited",
              contentJson,
              editedAt: new Date().toISOString(),
            },
          },
        })
      ).toEqual({
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          id: "event_edit",
          sequence: "43",
          actorType: "user",
          actorId: "usr_abc",
          payload: { messageId: "msg_def", contentMarkdown: "Edited", contentJson, metadata: {} },
        },
      })
    })

    test("keeps message metadata and defaults a non-object to empty", () => {
      const parse = (metadata: unknown) =>
        parseMessagePayload({
          workspaceId: "ws_123",
          streamId: "stream_456",
          event: { payload: { messageId: "msg_def", metadata } },
        })?.event.payload.metadata

      expect({
        object: parse({ "threa.command": "spawn" }),
        array: parse(["spawn"]),
        missing: parse(undefined),
      }).toEqual({ object: { "threa.command": "spawn" }, array: {}, missing: {} })
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
            metadata: {},
          },
        },
      })
    })

    test("should null out array contentJson", () => {
      const payload = {
        workspaceId: "ws_123",
        streamId: "stream_456",
        event: {
          payload: {
            messageId: "msg_def",
            contentMarkdown: "Hello",
            contentJson: [],
          },
        },
      }

      const result = parseMessagePayload(payload)

      expect(result?.event.payload.contentJson).toBeNull()
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
