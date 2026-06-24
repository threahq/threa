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
  const mockListByWorkspace = mock(() =>
    Promise.resolve({ posts: [] as Record<string, unknown>[], nextCursor: null as string | null })
  )
  const mockGetById = mock(() => Promise.resolve(null as Record<string, unknown> | null))
  const mockGetMessages = mock(() => Promise.resolve([] as Record<string, unknown>[]))
  const mockCreateAuthoredPost = mock(() => Promise.resolve({} as Record<string, unknown>))
  const mockGetFlag = mock(() => Promise.resolve("on" as string))

  const handlers = createConversationHandlers({
    conversationService: {
      listByStream: mockListByStream,
      listByWorkspace: mockListByWorkspace,
      getById: mockGetById,
      getMessages: mockGetMessages,
      createAuthoredPost: mockCreateAuthoredPost,
    } as never,
    streamService: {
      validateStreamAccess: mockValidateStreamAccess,
    } as never,
    featureFlagService: {
      getFlag: mockGetFlag,
    } as never,
  })

  beforeEach(() => {
    mockValidateStreamAccess.mockReset()
    mockListByStream.mockReset()
    mockListByWorkspace.mockReset()
    mockGetById.mockReset()
    mockGetMessages.mockReset()
    mockCreateAuthoredPost.mockReset()
    mockGetFlag.mockReset()

    mockValidateStreamAccess.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" })
    mockListByStream.mockResolvedValue([])
    mockListByWorkspace.mockResolvedValue({ posts: [], nextCursor: null })
    mockGetFlag.mockResolvedValue("on")
    mockGetById.mockResolvedValue({
      id: "conv_1",
      streamId: "stream_1",
      workspaceId: "ws_1",
    })
    mockGetMessages.mockResolvedValue([])
    mockCreateAuthoredPost.mockResolvedValue({ conversation: { id: "conv_new" } })
  })

  describe("createAuthoredPost", () => {
    const validBody = { streamId: "stream_2", contentJson: { type: "doc", content: [] } }

    test("404s when the board-view feature flag is not 'on'", async () => {
      mockGetFlag.mockResolvedValue("off")
      await expect(handlers.createAuthoredPost(mockReq({ body: validBody }), mockRes())).rejects.toMatchObject({
        status: 404,
      })
      expect(mockCreateAuthoredPost).not.toHaveBeenCalled()
    })

    test("validates the author can post into the target stream", async () => {
      await handlers.createAuthoredPost(mockReq({ body: validBody }), mockRes())
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_2", "ws_1", "usr_1")
    })

    test("propagates StreamNotFoundError without creating a post", async () => {
      mockValidateStreamAccess.mockRejectedValue(new StreamNotFoundError())
      await expect(handlers.createAuthoredPost(mockReq({ body: validBody }), mockRes())).rejects.toThrow(
        "Stream not found"
      )
      expect(mockCreateAuthoredPost).not.toHaveBeenCalled()
    })

    test("delegates to the service and returns 201 with the created post", async () => {
      const post = { conversation: { id: "conv_new" }, openingMessage: { id: "msg_1" } }
      mockCreateAuthoredPost.mockResolvedValue(post)
      const res = mockRes()

      await handlers.createAuthoredPost(
        mockReq({ body: { ...validBody, title: "  Roadmap  ", attachmentIds: ["att_1"] } }),
        res
      )

      expect(mockCreateAuthoredPost).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        streamId: "stream_2",
        userId: "usr_1",
        contentJson: { type: "doc", content: [] },
        title: "Roadmap",
        attachmentIds: ["att_1"],
      })
      expect((res as unknown as { statusCode: number; body: unknown }).statusCode).toBe(201)
      expect((res as unknown as { body: unknown }).body).toEqual({ post })
    })

    test("rejects a body missing contentJson with a 400", async () => {
      await expect(
        handlers.createAuthoredPost(mockReq({ body: { streamId: "stream_2" } }), mockRes())
      ).rejects.toMatchObject({ status: 400 })
      expect(mockCreateAuthoredPost).not.toHaveBeenCalled()
    })
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
    test("404s when the board-view feature flag is not 'on'", async () => {
      mockGetFlag.mockResolvedValue("off")
      await expect(handlers.listByWorkspace(mockReq({ query: {} }), mockRes())).rejects.toMatchObject({ status: 404 })
      expect(mockListByWorkspace).not.toHaveBeenCalled()
    })

    test("checks the board-view flag for the viewer", async () => {
      await handlers.listByWorkspace(mockReq({ query: {} }), mockRes())
      expect(mockGetFlag).toHaveBeenCalledWith("ws_1", "usr_1", "board-view")
    })

    test("passes workspaceId, userId and validated query (incl. decoded cursor) to the service", async () => {
      const res = mockRes()
      await handlers.listByWorkspace(
        mockReq({ query: { status: "active", limit: "25", cursor: "2026-06-22T12:00:00.000Z|conv_9" } }),
        res
      )

      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", {
        status: "active",
        limit: 25,
        cursor: { lastActivityAt: "2026-06-22T12:00:00.000Z", id: "conv_9" },
      })
    })

    test("passes cursor: undefined when none is supplied", async () => {
      await handlers.listByWorkspace(mockReq({ query: {} }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", {
        status: undefined,
        limit: undefined,
        cursor: undefined,
      })
    })

    test("rejects a malformed cursor with a 400", async () => {
      await expect(handlers.listByWorkspace(mockReq({ query: { cursor: "not-a-cursor" } }), mockRes())).rejects.toThrow(
        "Invalid board cursor"
      )
    })

    test("returns the paged result the service resolves", async () => {
      const posts = [{ conversation: { id: "conv_1" } }, { conversation: { id: "conv_2" } }]
      mockListByWorkspace.mockResolvedValue({ posts, nextCursor: "2026-06-22T12:00:00.000Z|conv_2" })
      const res = mockRes()

      await handlers.listByWorkspace(mockReq({ query: {} }), res)

      expect((res as unknown as { body: unknown }).body).toEqual({
        posts,
        nextCursor: "2026-06-22T12:00:00.000Z|conv_2",
      })
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
