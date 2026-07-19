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
    locals: {} as Record<string, unknown>,
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
  const mockGetBoardPostById = mock(() => Promise.resolve(null as Record<string, unknown> | null))
  const mockUpdateConversation = mock(() => Promise.resolve({ conversation: {} as Record<string, unknown> }))
  const mockHideConversation = mock(() => Promise.resolve({ hiddenAt: "2026-07-05T00:00:00.000Z" }))
  const mockUnhideConversation = mock(() => Promise.resolve())
  const mockMuteStream = mock(() => Promise.resolve())
  const mockUnmuteStream = mock(() => Promise.resolve())
  const mockGetExclusions = mock(() =>
    Promise.resolve({
      hiddenConversations: [] as { conversationId: string; hiddenAt: string }[],
      mutedStreamIds: [] as string[],
    })
  )
  const mockSplitThread = mock(() =>
    Promise.resolve({ conversation: { id: "conv_new" }, sourceConversation: { id: "conv_1" } })
  )

  const handlers = createConversationHandlers({
    conversationService: {
      listByStream: mockListByStream,
      listByWorkspace: mockListByWorkspace,
      getById: mockGetById,
      getMessages: mockGetMessages,
      getBoardPostById: mockGetBoardPostById,
      updateConversation: mockUpdateConversation,
      splitThreadIntoConversation: mockSplitThread,
    } as never,
    boundaryExtractionService: {
      proposeSplit: mock(() =>
        Promise.resolve({ conversationId: "conv_1", groups: [], confidence: 1, reasoning: null })
      ),
    } as never,
    boardExclusionService: {
      hideConversation: mockHideConversation,
      unhideConversation: mockUnhideConversation,
      muteStream: mockMuteStream,
      unmuteStream: mockUnmuteStream,
      getExclusions: mockGetExclusions,
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
    mockGetBoardPostById.mockReset()
    mockUpdateConversation.mockReset()
    mockHideConversation.mockReset()
    mockUnhideConversation.mockReset()
    mockMuteStream.mockReset()
    mockUnmuteStream.mockReset()
    mockGetExclusions.mockReset()
    mockUpdateConversation.mockResolvedValue({
      conversation: { id: "conv_1", topicSummary: "Renamed", status: "active" },
    })
    mockHideConversation.mockResolvedValue({ hiddenAt: "2026-07-05T00:00:00.000Z" })
    mockGetExclusions.mockResolvedValue({ hiddenConversations: [], mutedStreamIds: [] })
    mockSplitThread.mockReset()
    mockSplitThread.mockResolvedValue({ conversation: { id: "conv_new" }, sourceConversation: { id: "conv_1" } })

    mockValidateStreamAccess.mockResolvedValue({ id: "stream_1", workspaceId: "ws_1" })
    mockListByStream.mockResolvedValue([])
    mockListByWorkspace.mockResolvedValue({ posts: [], nextCursor: null })
    mockGetById.mockResolvedValue({
      id: "conv_1",
      streamId: "stream_1",
      workspaceId: "ws_1",
    })
    mockGetMessages.mockResolvedValue([])
    mockGetBoardPostById.mockResolvedValue({ conversation: { id: "conv_1" }, openingMessage: null })
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
    test("passes workspaceId, userId and validated query (incl. decoded cursor) to the service", async () => {
      const res = mockRes()
      await handlers.listByWorkspace(
        mockReq({ query: { status: "active", limit: "25", cursor: "2026-06-22T12:00:00.000Z|conv_9" } }),
        res
      )

      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", {
        status: "active",
        lens: undefined,
        scopeStreamIds: undefined,
        limit: 25,
        cursor: { lastActivityAt: "2026-06-22T12:00:00.000Z", id: "conv_9" },
      })
    })

    test("threads the validated lens through to the service", async () => {
      await handlers.listByWorkspace(mockReq({ query: { lens: "needs-resolution" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ lens: "needs-resolution" })
      )
    })

    test("accepts the all lens as an explicit no-op filter", async () => {
      await handlers.listByWorkspace(mockReq({ query: { lens: "all" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", expect.objectContaining({ lens: "all" }))
    })

    test("rejects an unknown lens with a 400", async () => {
      await expect(handlers.listByWorkspace(mockReq({ query: { lens: "bogus" } }), mockRes())).rejects.toMatchObject({
        status: 400,
      })
    })

    test("splits the comma-separated streams scope into scopeStreamIds", async () => {
      await handlers.listByWorkspace(mockReq({ query: { streams: "stream_a,stream_b" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ scopeStreamIds: ["stream_a", "stream_b"] })
      )
    })

    test("splits the comma-separated types scope into scopeStreamTypes", async () => {
      await handlers.listByWorkspace(mockReq({ query: { types: "dm,scratchpad" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ scopeStreamTypes: ["dm", "scratchpad"] })
      )
    })

    test("rejects a types scope outside the root grains with a 400", async () => {
      // `thread` is deliberately not a scope grain — filtering is by root type.
      await expect(
        handlers.listByWorkspace(mockReq({ query: { types: "channel,thread" } }), mockRes())
      ).rejects.toMatchObject({ status: 400 })
    })

    test("rejects a streams scope past the cap with a 400", async () => {
      const streams = Array.from({ length: 51 }, (_, i) => `stream_${i}`).join(",")
      await expect(handlers.listByWorkspace(mockReq({ query: { streams } }), mockRes())).rejects.toMatchObject({
        status: 400,
      })
    })

    test("splits excludeStreams into excludeStreamIds alongside an include scope", async () => {
      await handlers.listByWorkspace(
        mockReq({ query: { streams: "stream_a", excludeStreams: "stream_b,stream_c" } }),
        mockRes()
      )
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ scopeStreamIds: ["stream_a"], excludeStreamIds: ["stream_b", "stream_c"] })
      )
    })

    test("splits excludeTypes into excludeStreamTypes and rejects non-root grains", async () => {
      await handlers.listByWorkspace(mockReq({ query: { excludeTypes: "system,dm" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ excludeStreamTypes: ["system", "dm"] })
      )
      await expect(
        handlers.listByWorkspace(mockReq({ query: { excludeTypes: "thread" } }), mockRes())
      ).rejects.toMatchObject({ status: 400 })
    })

    test("splits labels/excludeLabels into the label id scopes", async () => {
      await handlers.listByWorkspace(
        mockReq({ query: { labels: "label_a,label_b", excludeLabels: "label_c" } }),
        mockRes()
      )
      expect(mockListByWorkspace).toHaveBeenCalledWith(
        "ws_1",
        "usr_1",
        expect.objectContaining({ scopeLabelIds: ["label_a", "label_b"], excludeLabelIds: ["label_c"] })
      )
    })

    test("rejects a labels list past the cap with a 400", async () => {
      const labels = Array.from({ length: 51 }, (_, i) => `label_${i}`).join(",")
      await expect(handlers.listByWorkspace(mockReq({ query: { labels } }), mockRes())).rejects.toMatchObject({
        status: 400,
      })
    })

    test("threads showArchived: true through when ?archived=true", async () => {
      await handlers.listByWorkspace(mockReq({ query: { archived: "true" } }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", expect.objectContaining({ showArchived: true }))
    })

    test("rejects a non-boolean ?archived with a 400", async () => {
      await expect(handlers.listByWorkspace(mockReq({ query: { archived: "yes" } }), mockRes())).rejects.toMatchObject({
        status: 400,
      })
    })

    test("passes cursor: undefined when none is supplied", async () => {
      await handlers.listByWorkspace(mockReq({ query: {} }), mockRes())
      expect(mockListByWorkspace).toHaveBeenCalledWith("ws_1", "usr_1", {
        status: undefined,
        lens: undefined,
        scopeStreamIds: undefined,
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

  describe("splitThread", () => {
    const req = (overrides: Record<string, unknown> = {}) =>
      mockReq({ params: { conversationId: "conv_1" }, body: { threadStreamId: "thr_1" }, ...overrides })

    test("rejects a missing threadStreamId with a 400 (Zod)", async () => {
      await expect(handlers.splitThread(req({ body: {} }), mockRes())).rejects.toMatchObject({ status: 400 })
      expect(mockSplitThread).not.toHaveBeenCalled()
    })

    test("gates on the conversation's root via validateStreamAccess (INV-62)", async () => {
      await handlers.splitThread(req(), mockRes())
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    })

    test("propagates a stream-access rejection", async () => {
      mockValidateStreamAccess.mockRejectedValue(new StreamNotFoundError())
      await expect(handlers.splitThread(req(), mockRes())).rejects.toThrow("Stream not found")
      expect(mockSplitThread).not.toHaveBeenCalled()
    })

    test("404s when the conversation is in another workspace", async () => {
      mockGetById.mockResolvedValue({ id: "conv_1", streamId: "stream_1", workspaceId: "ws_other" })
      const res = mockRes()
      await handlers.splitThread(req(), res)
      expect((res as unknown as { statusCode: number }).statusCode).toBe(404)
      expect(mockValidateStreamAccess).not.toHaveBeenCalled()
      expect(mockSplitThread).not.toHaveBeenCalled()
    })

    test("delegates to the service and returns its result", async () => {
      const res = mockRes()
      await handlers.splitThread(req(), res)
      expect(mockSplitThread).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        threadStreamId: "thr_1",
        actorUserId: "usr_1",
      })
      expect((res as unknown as { body: unknown }).body).toEqual({
        conversation: { id: "conv_new" },
        sourceConversation: { id: "conv_1" },
      })
    })
  })

  describe("getBoardPost", () => {
    test("gates on the conversation's single root via validateStreamAccess (INV-62)", async () => {
      await handlers.getBoardPost(mockReq({ params: { conversationId: "conv_1" } }), mockRes())
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    })

    test("propagates a stream-access rejection", async () => {
      mockValidateStreamAccess.mockRejectedValue(new StreamNotFoundError())
      await expect(handlers.getBoardPost(mockReq({ params: { conversationId: "conv_1" } }), mockRes())).rejects.toThrow(
        "Stream not found"
      )
      expect(mockGetBoardPostById).not.toHaveBeenCalled()
    })

    test("404s when the conversation is in another workspace", async () => {
      mockGetById.mockResolvedValue({ id: "conv_1", streamId: "stream_1", workspaceId: "ws_other" })
      const res = mockRes()
      await handlers.getBoardPost(mockReq({ params: { conversationId: "conv_1" } }), res)
      expect((res as unknown as { statusCode: number }).statusCode).toBe(404)
      expect(mockValidateStreamAccess).not.toHaveBeenCalled()
    })

    test("404s when the post is empty/gone after the access check", async () => {
      mockGetBoardPostById.mockResolvedValue(null)
      const res = mockRes()
      await handlers.getBoardPost(mockReq({ params: { conversationId: "conv_1" } }), res)
      expect((res as unknown as { statusCode: number }).statusCode).toBe(404)
    })

    test("returns the projected post the service resolves", async () => {
      const post = { conversation: { id: "conv_1" }, openingMessage: null, recentMessages: [], streamIds: ["stream_1"] }
      mockGetBoardPostById.mockResolvedValue(post)
      const res = mockRes()
      await handlers.getBoardPost(mockReq({ params: { conversationId: "conv_1" } }), res)
      expect((res as unknown as { body: unknown }).body).toEqual({ post })
    })
  })

  describe("updateConversation", () => {
    const req = (body: unknown) => mockReq({ params: { conversationId: "conv_1" }, body })

    test("renames the topic and returns the updated conversation", async () => {
      const res = mockRes()
      await handlers.updateConversation(req({ topicSummary: "New topic" }), res)
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
      expect(mockUpdateConversation).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        topicSummary: "New topic",
        status: undefined,
      })
      expect((res as unknown as { body: unknown }).body).toEqual({
        conversation: { id: "conv_1", topicSummary: "Renamed", status: "active" },
      })
    })

    test("marks the conversation resolved", async () => {
      const res = mockRes()
      await handlers.updateConversation(req({ status: "resolved" }), res)
      expect(mockUpdateConversation).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: "conv_1", status: "resolved" })
      )
    })

    test("rejects an empty body with a 400", async () => {
      await expect(handlers.updateConversation(req({}), mockRes())).rejects.toMatchObject({ status: 400 })
      expect(mockUpdateConversation).not.toHaveBeenCalled()
    })

    test("rejects a non-user status (stalled) with a 400", async () => {
      await expect(handlers.updateConversation(req({ status: "stalled" }), mockRes())).rejects.toMatchObject({
        status: 400,
      })
      expect(mockUpdateConversation).not.toHaveBeenCalled()
    })

    test("404s a conversation in another workspace before writing", async () => {
      mockGetById.mockResolvedValue({ id: "conv_1", streamId: "stream_1", workspaceId: "other_ws" })
      const res = mockRes()
      await handlers.updateConversation(req({ topicSummary: "x" }), res)
      expect((res as unknown as { statusCode: number }).statusCode).toBe(404)
      expect(mockUpdateConversation).not.toHaveBeenCalled()
    })

    test("propagates a stream-access rejection (INV-62) before writing", async () => {
      mockValidateStreamAccess.mockRejectedValue(new Error("Stream not found"))
      await expect(handlers.updateConversation(req({ topicSummary: "x" }), mockRes())).rejects.toThrow(
        "Stream not found"
      )
      expect(mockUpdateConversation).not.toHaveBeenCalled()
    })
  })

  describe("board exclusions", () => {
    test("hideConversation checks access, then delegates", async () => {
      const res = mockRes()
      await handlers.hideConversation(mockReq({ params: { conversationId: "conv_1" } }), res)
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
      expect(mockHideConversation).toHaveBeenCalledWith({
        workspaceId: "ws_1",
        conversationId: "conv_1",
        userId: "usr_1",
      })
      expect((res as unknown as { body: unknown }).body).toEqual({ hiddenAt: "2026-07-05T00:00:00.000Z" })
    })

    test("muteStream validates the target stream then delegates", async () => {
      const res = mockRes()
      await handlers.muteStream(mockReq({ params: { streamId: "stream_9" } }), res)
      expect(mockValidateStreamAccess).toHaveBeenCalledWith("stream_9", "ws_1", "usr_1")
      expect(mockMuteStream).toHaveBeenCalledWith({ workspaceId: "ws_1", streamId: "stream_9", userId: "usr_1" })
    })

    test("getBoardExclusions returns the viewer's hidden + muted sets", async () => {
      mockGetExclusions.mockResolvedValue({
        hiddenConversations: [{ conversationId: "conv_1", hiddenAt: "2026-07-05T00:00:00.000Z" }],
        mutedStreamIds: ["stream_9"],
      })
      const res = mockRes()
      await handlers.getBoardExclusions(mockReq({ query: {} }), res)
      expect((res as unknown as { body: unknown }).body).toEqual({
        hiddenConversations: [{ conversationId: "conv_1", hiddenAt: "2026-07-05T00:00:00.000Z" }],
        mutedStreamIds: ["stream_9"],
      })
    })
  })
})
