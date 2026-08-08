import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import { StreamNamingService } from "./naming-service"
import { MessageFormatter } from "../../lib/ai/message-formatter"
import { AttachmentRepository } from "../attachments"
import { MessageRepository } from "../messaging"
import { LinkPreviewRepository } from "../link-previews"
import { StreamRepository } from "./repository"
import { OutboxRepository } from "../../lib/outbox"
import * as dbModule from "../../db"
import * as displayNameModule from "./display-name"
import type { AI } from "@threa/agent-runtime"
import type { ConfigResolver, ComponentConfig } from "../../lib/ai/config-resolver"

const mockFormatMessages = mock(() => Promise.resolve("<messages></messages>"))
const mockFormatMessagesWithAttachments = mock(() => Promise.resolve("<messages></messages>"))
const mockMessageFormatter = {
  formatMessages: mockFormatMessages,
  formatMessagesWithAttachments: mockFormatMessagesWithAttachments,
} as unknown as MessageFormatter

const mockStream = {
  id: "stream_123",
  workspaceId: "ws_456",
  type: "scratchpad",
  displayName: null,
  displayNameGeneratedAt: null,
}

const mockMessages = [
  {
    id: "msg_1",
    content: "Hello, can you help me with something?",
    authorType: "user",
    authorId: "member_123",
    createdAt: new Date("2024-01-01T10:00:00Z"),
  },
  {
    id: "msg_2",
    content: "Sure, what do you need?",
    authorType: "persona",
    authorId: "persona_456",
    createdAt: new Date("2024-01-01T10:00:01Z"),
  },
]

const mockGenerateText = mock(async (_options: unknown) => ({ value: "", response: {} }))
const mockAI: Partial<AI> = {
  generateText: mockGenerateText as unknown as AI["generateText"],
}

const mockConfigResolver: ConfigResolver = {
  async resolve<T extends ComponentConfig>(): Promise<T> {
    return {
      modelId: "test-model",
      temperature: 0.3,
    } as T
  },
}

const mockPool = {} as any

describe("StreamNamingService", () => {
  let service: StreamNamingService

  beforeEach(() => {
    mockGenerateText.mockReset()
    mockFormatMessages.mockReset()
    mockFormatMessagesWithAttachments.mockReset()

    // spyOn shared modules instead of mock.module (INV-48)
    spyOn(StreamRepository, "findById").mockResolvedValue(mockStream as any)
    spyOn(StreamRepository, "findByIdForUpdate").mockResolvedValue(mockStream as any)
    spyOn(StreamRepository, "list").mockResolvedValue([])
    spyOn(StreamRepository, "update").mockResolvedValue(undefined as any)
    spyOn(StreamRepository, "updateDisplayName").mockResolvedValue({
      ...mockStream,
      displayNameSource: "generated",
      displayNameRevision: 1,
    } as any)
    spyOn(OutboxRepository, "insert").mockResolvedValue(undefined as any)
    spyOn(dbModule, "withClient").mockImplementation((_pool: unknown, fn: any) => fn({}))
    spyOn(dbModule, "withTransaction").mockImplementation((_pool: unknown, fn: any) => fn({}))
    spyOn(displayNameModule, "needsAutoNaming").mockReturnValue(true)

    spyOn(MessageRepository, "list").mockResolvedValue(mockMessages as any)
    mockFormatMessages.mockResolvedValue("<messages></messages>")
    mockFormatMessagesWithAttachments.mockResolvedValue("<messages></messages>")

    // findByIds drives awaitAttachmentProcessing — empty makes it complete immediately
    spyOn(AttachmentRepository, "findByIds").mockResolvedValue([])
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    spyOn(AttachmentRepository, "findByMessageIdsWithExtractions").mockResolvedValue(new Map())
    spyOn(LinkPreviewRepository, "findByMessageIds").mockResolvedValue(new Map())

    service = new StreamNamingService(mockPool, mockAI as AI, mockConfigResolver, mockMessageFormatter)
  })

  afterEach(() => {
    mock.restore()
  })

  describe("attemptAutoNaming with requireName=false (user message)", () => {
    test("should return false when LLM returns NOT_ENOUGH_CONTEXT", async () => {
      mockGenerateText.mockResolvedValue({ value: "NOT_ENOUGH_CONTEXT", response: {} })

      const result = await service.attemptAutoNaming("stream_123", false)

      expect(result).toBe(false)
      expect(StreamRepository.update).not.toHaveBeenCalled()
    })

    test("should generate name when LLM returns valid title", async () => {
      mockGenerateText.mockResolvedValue({ value: "Help Request", response: {} })

      const result = await service.attemptAutoNaming("stream_123", false)

      expect(result).toBe(true)
      expect(StreamRepository.updateDisplayName).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ streamId: "stream_123", displayName: "Help Request", source: "generated" })
      )
    })
  })

  describe("attemptAutoNaming with requireName=true (agent message)", () => {
    test("should throw when LLM returns NOT_ENOUGH_CONTEXT", async () => {
      mockGenerateText.mockResolvedValue({ value: "NOT_ENOUGH_CONTEXT", response: {} })

      await expect(service.attemptAutoNaming("stream_123", true)).rejects.toThrow(
        "Failed to generate required name: NOT_ENOUGH_CONTEXT returned"
      )

      expect(StreamRepository.update).not.toHaveBeenCalled()
    })

    test("should throw when LLM returns empty response", async () => {
      mockGenerateText.mockResolvedValue({ value: "", response: {} })

      await expect(service.attemptAutoNaming("stream_123", true)).rejects.toThrow(
        "Failed to generate required name: NOT_ENOUGH_CONTEXT returned"
      )
    })

    test("should generate name when LLM returns valid title", async () => {
      mockGenerateText.mockResolvedValue({ value: "Quick Question", response: {} })

      const result = await service.attemptAutoNaming("stream_123", true)

      expect(result).toBe(true)
      expect(StreamRepository.updateDisplayName).toHaveBeenCalled()
    })
  })

  describe("existing names in prompt", () => {
    test("should include existing scratchpad names in system message", async () => {
      spyOn(StreamRepository, "list").mockResolvedValue([
        { id: "stream_other1", displayName: "Project Planning" },
        { id: "stream_other2", displayName: "Bug Fixes" },
        { id: "stream_123", displayName: null }, // Current stream, should be excluded
      ] as any)

      mockGenerateText.mockResolvedValue({ value: "New Topic", response: {} })

      await service.attemptAutoNaming("stream_123", false)

      const calls = mockGenerateText.mock.calls
      const lastCall = calls[calls.length - 1]?.[0] as { messages: Array<{ role: string; content: string }> }
      const systemMessage = lastCall.messages.find((m) => m.role === "system")?.content ?? ""

      expect(systemMessage).toContain("Project Planning")
      expect(systemMessage).toContain("Bug Fixes")
    })

    test("should exclude current stream from existing names list", async () => {
      spyOn(StreamRepository, "list").mockResolvedValue([
        { id: "stream_123", displayName: "Current Stream Name" },
        { id: "stream_other", displayName: "Another Scratchpad" },
      ] as any)

      mockGenerateText.mockResolvedValue({ value: "New Topic", response: {} })

      await service.attemptAutoNaming("stream_123", false)

      const calls = mockGenerateText.mock.calls
      const lastCall = calls[calls.length - 1]?.[0] as { messages: Array<{ role: string; content: string }> }
      const systemMessage = lastCall.messages.find((m) => m.role === "system")?.content ?? ""

      expect(systemMessage).toContain("Another Scratchpad")
      expect(systemMessage).not.toContain("Current Stream Name")
    })
  })

  describe("prompt differences based on requireName", () => {
    test("should include NOT_ENOUGH_CONTEXT instruction when requireName=false", async () => {
      mockGenerateText.mockResolvedValue({ value: "Title", response: {} })

      await service.attemptAutoNaming("stream_123", false)

      const calls = mockGenerateText.mock.calls
      const lastCall = calls[calls.length - 1]?.[0] as { messages: Array<{ role: string; content: string }> }
      const systemMessage = lastCall.messages.find((m) => m.role === "system")?.content ?? ""

      expect(systemMessage).toContain("NOT_ENOUGH_CONTEXT")
    })

    test("should require generating a name when requireName=true", async () => {
      mockGenerateText.mockResolvedValue({ value: "Title", response: {} })

      await service.attemptAutoNaming("stream_123", true)

      const calls = mockGenerateText.mock.calls
      const lastCall = calls[calls.length - 1]?.[0] as { messages: Array<{ role: string; content: string }> }
      const systemMessage = lastCall.messages.find((m) => m.role === "system")?.content ?? ""

      expect(systemMessage).toContain("You MUST generate a title")
    })

    test("should instruct the model to follow the conversation language and drop preamble", async () => {
      mockGenerateText.mockResolvedValue({ value: "Title", response: {} })

      await service.attemptAutoNaming("stream_123", false)

      const calls = mockGenerateText.mock.calls
      const lastCall = calls[calls.length - 1]?.[0] as { messages: Array<{ role: string; content: string }> }
      const systemMessage = lastCall.messages.find((m) => m.role === "system")?.content ?? ""

      expect(systemMessage).toContain("dominant language of the conversation")
      expect(systemMessage).toContain("Do NOT state which language")
      expect(systemMessage).toContain("Do NOT add framing")
      expect(systemMessage).toContain("verbatim")
    })
  })

  describe("edge cases", () => {
    test("should clean quotes from generated name", async () => {
      mockGenerateText.mockResolvedValue({ value: '"Quoted Title"', response: {} })

      await service.attemptAutoNaming("stream_123", false)

      expect(StreamRepository.updateDisplayName).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ streamId: "stream_123", displayName: "Quoted Title", source: "generated" })
      )
    })

    test("should reject names that are too long", async () => {
      const longName = "A".repeat(150)
      mockGenerateText.mockResolvedValue({ value: longName, response: {} })

      const result = await service.attemptAutoNaming("stream_123", false)

      expect(result).toBe(false)
      expect(StreamRepository.update).not.toHaveBeenCalled()
    })

    test("should throw for too-long names when requireName=true", async () => {
      const longName = "A".repeat(150)
      mockGenerateText.mockResolvedValue({ value: longName, response: {} })

      await expect(service.attemptAutoNaming("stream_123", true)).rejects.toThrow("invalid response")
    })
  })

  describe("attachment processing", () => {
    test("should process attachments when messages have them", async () => {
      mockGenerateText.mockResolvedValue({ value: "Fish Image", response: {} })

      const attachmentsMap = new Map()
      attachmentsMap.set("msg_1", [{ id: "attach_1" }])
      spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(attachmentsMap)

      spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
        { id: "attach_1", processingStatus: "completed" },
      ] as any)

      const result = await service.attemptAutoNaming("stream_123", false)

      expect(result).toBe(true)
    })

    test("should work when no attachments", async () => {
      mockGenerateText.mockResolvedValue({ value: "Title", response: {} })

      const result = await service.attemptAutoNaming("stream_123", false)

      expect(result).toBe(true)
    })

    test("should fetch attachments with extractions after awaiting processing", async () => {
      mockGenerateText.mockResolvedValue({ value: "Fish Analysis", response: {} })

      const attachmentsMap = new Map()
      attachmentsMap.set("msg_1", [{ id: "attach_1" }])
      spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(attachmentsMap)

      spyOn(AttachmentRepository, "findByIds").mockResolvedValue([
        { id: "attach_1", processingStatus: "completed" },
      ] as any)

      const extractionsMap = new Map()
      extractionsMap.set("msg_1", [
        {
          id: "attach_1",
          extraction: {
            contentType: "photo",
            summary: "A colorful tropical fish",
            fullText: null,
          },
        },
      ])
      spyOn(AttachmentRepository, "findByMessageIdsWithExtractions").mockResolvedValue(extractionsMap)

      await service.attemptAutoNaming("stream_123", false)

      expect(mockFormatMessagesWithAttachments).toHaveBeenCalled()
    })

    test("should use formatMessagesWithAttachments for conversation text", async () => {
      mockGenerateText.mockResolvedValue({ value: "Image Discussion", response: {} })

      await service.attemptAutoNaming("stream_123", false)

      expect(mockFormatMessagesWithAttachments).toHaveBeenCalled()
      expect(mockFormatMessages).not.toHaveBeenCalled()
    })
  })
})
