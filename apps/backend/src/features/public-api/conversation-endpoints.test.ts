import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import * as search from "../search"
import { UserRepository } from "../workspaces"
import { StreamRepository } from "../streams"
import { AttachmentRepository } from "../attachments"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import type { StreamService } from "../streams"
import type { ConversationWithStaleness } from "../conversations"
import type { Message } from "../messaging"

const NOW = new Date("2026-07-12T09:00:00.000Z")

function fakeConversation(overrides: Partial<ConversationWithStaleness> = {}): ConversationWithStaleness {
  return {
    id: "conv_1",
    streamId: "stream_1",
    workspaceId: "ws_1",
    messageIds: ["evt_1", "evt_2"],
    participantIds: ["usr_1"],
    secondaryMessageIds: [],
    topicSummary: "Rate limiting",
    summary: "Discussion about adding rate limiting to the API.",
    completenessScore: 3,
    confidence: 0.8,
    status: "active",
    parentConversationId: null,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    temporalStaleness: 0,
    effectiveCompleteness: 3,
    ...overrides,
  }
}

function fakeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "evt_1",
    streamId: "stream_1",
    sequence: 5n,
    authorId: "usr_1",
    authorType: "user",
    contentMarkdown: "We should add rate limiting.",
    replyCount: 0,
    editedAt: null,
    createdAt: NOW,
    metadata: {},
    ...(overrides as object),
  } as unknown as Message
}

function createResponse(): { res: Response; getBody: () => unknown; statusCode: () => number | undefined } {
  let body: unknown
  let code: number | undefined
  const res = {} as Response
  res.status = mock((c: number) => {
    code = c
    return res
  }) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  return { res, getBody: () => body, statusCode: () => code }
}

interface HandlerOverrides {
  conversationService?: Record<string, unknown>
  streamService?: Partial<StreamService>
}

function createHandlers(overrides: HandlerOverrides = {}) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: (overrides.streamService ?? {}) as StreamService,
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
      getAccessibleStreamIdsForBot: mock(() => Promise.resolve(["stream_1"])),
    } as unknown as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    conversationService: (overrides.conversationService ?? {}) as unknown as PublicApiDeps["conversationService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function userRequest(overrides: { params?: Record<string, string>; query?: Record<string, unknown> } = {}): Request {
  return {
    workspaceId: "ws_1",
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    userApiKey: { id: "uak_1", workspaceId: "ws_1", userId: "usr_1", scopes: new Set() },
    user: { id: "usr_1", name: "Kris" },
  } as unknown as Request
}

function bareRequest(): Request {
  return { workspaceId: "ws_1", params: {}, query: {} } as unknown as Request
}

afterEach(() => mock.restore())

describe("public API listConversations", () => {
  it("returns serialized conversations with pagination", async () => {
    spyOn(search, "resolveUserAccessibleStreamIds").mockResolvedValue(["stream_1"])
    const listAccessible = mock(() => Promise.resolve([fakeConversation()]))
    const handlers = createHandlers({ conversationService: { listAccessible } })

    const { res, getBody } = createResponse()
    await handlers.listConversations(userRequest({ query: { limit: "50" } }), res)

    expect(listAccessible).toHaveBeenCalledWith("ws_1", {
      accessibleStreamIds: ["stream_1"],
      status: undefined,
      scopeRootStreamId: undefined,
      limit: 51,
      cursor: undefined,
    })
    const body = getBody() as { data: unknown[]; hasMore: boolean; cursor: string | null }
    // A cursor is emitted for the last row even when hasMore is false, matching
    // the listStreams/listMembers convention; the client stops on hasMore.
    expect(body.hasMore).toBe(false)
    expect(typeof body.cursor).toBe("string")
    expect(body.data).toEqual([
      {
        id: "conv_1",
        streamId: "stream_1",
        topicSummary: "Rate limiting",
        summary: "Discussion about adding rate limiting to the API.",
        status: "active",
        completenessScore: 3,
        confidence: 0.8,
        messageCount: 2,
        participantIds: ["usr_1"],
        parentConversationId: null,
        lastActivityAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    ])
  })

  it("reports hasMore and a cursor when a full page comes back", async () => {
    spyOn(search, "resolveUserAccessibleStreamIds").mockResolvedValue(["stream_1"])
    const page = Array.from({ length: 3 }, (_, i) => fakeConversation({ id: `conv_${i}` }))
    const listAccessible = mock(() => Promise.resolve(page))
    const handlers = createHandlers({ conversationService: { listAccessible } })

    const { res, getBody } = createResponse()
    await handlers.listConversations(userRequest({ query: { limit: "2" } }), res)

    const body = getBody() as { data: unknown[]; hasMore: boolean; cursor: string | null }
    expect(body.data).toHaveLength(2)
    expect(body.hasMore).toBe(true)
    expect(body.cursor).toBeTruthy()
  })

  it("short-circuits to an empty page when no streams are accessible", async () => {
    spyOn(search, "resolveUserAccessibleStreamIds").mockResolvedValue([])
    const listAccessible = mock(() => Promise.resolve([]))
    const handlers = createHandlers({ conversationService: { listAccessible } })

    const { res, getBody } = createResponse()
    await handlers.listConversations(userRequest(), res)

    expect(listAccessible).not.toHaveBeenCalled()
    expect(getBody()).toEqual({ data: [], hasMore: false, cursor: null })
  })

  it("narrows to a stream's effective root when streamId is given", async () => {
    spyOn(search, "resolveUserAccessibleStreamIds").mockResolvedValue(["stream_root"])
    spyOn(StreamRepository, "findById").mockResolvedValue({
      id: "thread_1",
      workspaceId: "ws_1",
      rootStreamId: "stream_root",
    } as never)
    const tryAccess = mock(() => Promise.resolve({ id: "thread_1" }))
    const listAccessible = mock(() => Promise.resolve([]))
    const handlers = createHandlers({
      conversationService: { listAccessible },
      streamService: { tryAccess } as unknown as StreamService,
    })

    await handlers.listConversations(userRequest({ query: { streamId: "thread_1" } }), createResponse().res)

    expect(tryAccess).toHaveBeenCalledWith("thread_1", "ws_1", "usr_1")
    expect(listAccessible).toHaveBeenCalledWith("ws_1", expect.objectContaining({ scopeRootStreamId: "stream_root" }))
  })

  it("401s without any API key context", async () => {
    const handlers = createHandlers({ conversationService: { listAccessible: mock() } })
    await expect(handlers.listConversations(bareRequest(), createResponse().res)).rejects.toMatchObject({ status: 401 })
  })
})

describe("public API getConversation", () => {
  it("returns the conversation when the stream is accessible", async () => {
    const getById = mock(() => Promise.resolve(fakeConversation()))
    const tryAccess = mock(() => Promise.resolve({ id: "stream_1" }))
    const handlers = createHandlers({
      conversationService: { getById },
      streamService: { tryAccess } as unknown as StreamService,
    })

    const { res, getBody } = createResponse()
    await handlers.getConversation(userRequest({ params: { conversationId: "conv_1" } }), res)

    expect(tryAccess).toHaveBeenCalledWith("stream_1", "ws_1", "usr_1")
    expect(getBody()).toMatchObject({ data: { id: "conv_1", messageCount: 2, topicSummary: "Rate limiting" } })
  })

  it("404s a conversation in another workspace", async () => {
    const getById = mock(() => Promise.resolve(fakeConversation({ workspaceId: "ws_other" })))
    const handlers = createHandlers({ conversationService: { getById } })

    await expect(
      handlers.getConversation(userRequest({ params: { conversationId: "conv_1" } }), createResponse().res)
    ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" })
  })

  it("404s a missing conversation", async () => {
    const getById = mock(() => Promise.resolve(null))
    const handlers = createHandlers({ conversationService: { getById } })

    await expect(
      handlers.getConversation(userRequest({ params: { conversationId: "conv_x" } }), createResponse().res)
    ).rejects.toMatchObject({ status: 404 })
  })

  it("403s when the conversation's stream is not accessible", async () => {
    const getById = mock(() => Promise.resolve(fakeConversation()))
    const tryAccess = mock(() => Promise.resolve(null))
    const handlers = createHandlers({
      conversationService: { getById },
      streamService: { tryAccess } as unknown as StreamService,
    })

    await expect(
      handlers.getConversation(userRequest({ params: { conversationId: "conv_1" } }), createResponse().res)
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" })
  })
})

describe("public API listConversationMessages", () => {
  it("returns the conversation's messages in order", async () => {
    spyOn(UserRepository, "findByIds").mockResolvedValue([{ id: "usr_1", name: "Kris" }] as never)
    spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    const getById = mock(() => Promise.resolve(fakeConversation()))
    const getMessages = mock(() =>
      Promise.resolve([fakeMessage({ id: "evt_1" }), fakeMessage({ id: "evt_2", sequence: 6n })])
    )
    const tryAccess = mock(() => Promise.resolve({ id: "stream_1" }))
    const handlers = createHandlers({
      conversationService: { getById, getMessages },
      streamService: { tryAccess } as unknown as StreamService,
    })

    const { res, getBody } = createResponse()
    await handlers.listConversationMessages(userRequest({ params: { conversationId: "conv_1" } }), res)

    const body = getBody() as { data: Array<{ id: string; authorDisplayName?: string }> }
    expect(body.data.map((m) => m.id)).toEqual(["evt_1", "evt_2"])
    expect(body.data[0]!.authorDisplayName).toBe("Kris")
  })

  it("returns an empty list for an emptied conversation without hydrating", async () => {
    const findByMessageIds = spyOn(AttachmentRepository, "findByMessageIds").mockResolvedValue(new Map())
    const getById = mock(() => Promise.resolve(fakeConversation({ messageIds: [] })))
    const getMessages = mock(() => Promise.resolve([]))
    const tryAccess = mock(() => Promise.resolve({ id: "stream_1" }))
    const handlers = createHandlers({
      conversationService: { getById, getMessages },
      streamService: { tryAccess } as unknown as StreamService,
    })

    const { res, getBody } = createResponse()
    await handlers.listConversationMessages(userRequest({ params: { conversationId: "conv_1" } }), res)

    expect(getBody()).toEqual({ data: [] })
    expect(findByMessageIds).not.toHaveBeenCalled()
  })

  it("403s when the conversation's stream is not accessible", async () => {
    const getById = mock(() => Promise.resolve(fakeConversation()))
    const getMessages = mock(() => Promise.resolve([]))
    const tryAccess = mock(() => Promise.resolve(null))
    const handlers = createHandlers({
      conversationService: { getById, getMessages },
      streamService: { tryAccess } as unknown as StreamService,
    })

    await expect(
      handlers.listConversationMessages(userRequest({ params: { conversationId: "conv_1" } }), createResponse().res)
    ).rejects.toMatchObject({ status: 403 })
    expect(getMessages).not.toHaveBeenCalled()
  })
})
