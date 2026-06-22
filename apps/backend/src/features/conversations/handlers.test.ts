import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createConversationHandlers } from "./handlers"
import { StreamNotFoundError } from "../../lib/errors"

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    query: {},
    ...overrides,
  } as never
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(data: unknown) {
      res.body = data
      return res
    },
  }
  return res as never
}

describe("Conversation Handlers", () => {
  const mockValidateStreamAccess = mock(() => Promise.resolve({ id: "stream_1", workspaceId: "ws_1" }))
  const mockListByStream = mock(() => Promise.resolve([] as Record<string, unknown>[]))
  const mockListByWorkspace = mock(() => Promise.resolve([] as Record<string, unknown>[]))
  const mockGetById = mock(() => Promise.resolve(null as Record<string, unknown> | null))
  const mockGetMessages = mock(() => Promise.resolve([] as Record<string, unknown>[]))

  const handlers = createConversationHandlers({
    conversationService: {
      listByStream: mockListByStream,
      listByWorkspace: mockListByWorkspace,
      getById: mockGetById,
      getMessages: mockGetMessages,
    } as never,
    streamService: {
      validateStreamAccess: mockValidateStreamAccess,
    } as never,
  })

  beforeEach(() => {
    mockValidateStreamAccess.mockReset()
    mockListByStream.mockReset()
    mockListByWorkspace.mockReset()
    mockGetById.mockReset()
    mockGetMessages.mockReset()

    mockValidateStreamAccess.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" })
    mockListByStream.mockResolvedValue([])
    mockListByWorkspace.mockResolvedValue([])
    mockGetById.mockResolvedValue({
      id: "conv_1",
      streamId: "stream_1",
      workspaceId: "ws_1",
    })
    mockGetMessages.mockResolvedValue([])
  })

  describe("listByStream", () => {
    test("should call validateStreamAccess with correct params", async () => {
      const res = mockRes()
      await handlers.listByStream(mockReq(), res)

      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    })

    test("should return conversations when access is valid", async () => {
      const conversations = [{ id: "conv_1" }]
      mockListByStream.mockResolvedValue(conversations)
      const res = mockRes()

      await handlers.listByStream(mockReq(), res)

      expect((res as unknown as { body: unknown }).body).toEqual({ conversations })
    })

    test("should propagate StreamNotFoundError for unauthorized access", async () => {
      mockValidateStreamAccess.mockRejectedValue(new StreamNotFoundError())

      await expect(handlers.listByStream(mockReq(), mockRes())).rejects.toThrow("Stream not found")
    })
  })

  describe("listByWorkspace", () => {
    test("passes workspaceId, userId and validated query to the service", async () => {
      const res = mockRes()
      await handlers.listByWorkspace(mockReq({ query: { status: "active", limit: "25" } }), res)

      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", { status: "active", limit: 25 })
    })

    test("returns the conversations the service resolves", async () => {
      const conversations = [{ id: "conv_1" }, { id: "conv_2" }]
      mockListByWorkspace.mockResolvedValue(conversations)
      const res = mockRes()

      await handlers.listByWorkspace(mockReq({ query: {} }), res)

      expect((res as unknown as { body: unknown }).body).toEqual({ conversations })
    })

    test("does not gate on a single stream's access (filtering is in-query)", async () => {
      await handlers.listByWorkspace(mockReq({ query: {} }), mockRes())

      expect(mockValidateStreamAccess).not.toHaveBeenCalled()
    })
  })

  describe("getById", () => {
    test("should call validateStreamAccess for conversation's stream", async () => {
      const res = mockRes()
      await handlers.getById(mockReq({ params: { conversationId: "conv_1" } }), res)

      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    })

    test("should propagate StreamNotFoundError for unauthorized access", async () => {
      mockValidateStreamAccess.mockRejectedValue(new StreamNotFoundError())

      await expect(handlers.getById(mockReq({ params: { conversationId: "conv_1" } }), mockRes())).rejects.toThrow(
        "Stream not found"
      )
    })
  })

  describe("getMessages", () => {
    test("should call validateStreamAccess for conversation's stream", async () => {
      const res = mockRes()
      await handlers.getMessages(mockReq({ params: { conversationId: "conv_1" } }), res)

      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    })
  })
})
