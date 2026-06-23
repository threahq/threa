import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import type { StreamService } from "../streams"

function createResponse(): { res: Response; getBody: () => unknown } {
  let body: unknown
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  return { res, getBody: () => body }
}

function fakeStream(overrides: Record<string, unknown> = {}) {
  return {
    id: "stream_1",
    workspaceId: "ws_1",
    type: "channel",
    displayName: null,
    slug: "general",
    description: "About this channel",
    descriptionJson: null,
    visibility: "public",
    parentStreamId: null,
    parentMessageId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    memoryMode: "auto",
    createdBy: "usr_1",
    createdAt: new Date("2026-06-22T10:00:00.000Z"),
    updatedAt: new Date("2026-06-22T10:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  }
}

function createHandlers(streamService: StreamService) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService,
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {
      isStreamAccessibleForBot: mock(() => Promise.resolve(true)),
    } as unknown as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function userRequest(body: Record<string, unknown>): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    body,
    userApiKey: { id: "key_1" },
    user: { id: "usr_1", name: "Tester" },
  } as unknown as Request
}

function botRequest(body: Record<string, unknown>): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    body,
    botApiKey: { botId: "bot_1" },
  } as unknown as Request
}

describe("public API updateStream", () => {
  afterEach(() => mock.restore())

  it("sets the description and attributes the change to the user", async () => {
    const updateStream = mock(() => Promise.resolve(fakeStream({ description: "New blurb" })))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      updateStream,
    } as unknown as StreamService)

    const { res, getBody } = createResponse()
    await handlers.updateStream(userRequest({ description: "New blurb" }), res)

    expect(updateStream).toHaveBeenCalledWith("stream_1", {
      description: "New blurb",
      actorId: "usr_1",
      actorType: "user",
    })
    expect(getBody()).toMatchObject({ data: { id: "stream_1", description: "New blurb" } })
  })

  it("attributes the change to the bot for a workspace key", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", name: "Robo", archivedAt: null } as never)
    const updateStream = mock(() => Promise.resolve(fakeStream()))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      updateStream,
    } as unknown as StreamService)

    await handlers.updateStream(botRequest({ description: "From a bot" }), createResponse().res)

    expect(updateStream).toHaveBeenCalledWith("stream_1", {
      description: "From a bot",
      actorId: "bot_1",
      actorType: "bot",
    })
  })

  it("clears the description with an empty string", async () => {
    const updateStream = mock(() => Promise.resolve(fakeStream({ description: null })))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      updateStream,
    } as unknown as StreamService)

    await handlers.updateStream(userRequest({ description: "" }), createResponse().res)

    expect(updateStream).toHaveBeenCalledWith("stream_1", { description: "", actorId: "usr_1", actorType: "user" })
  })

  it("rejects with 403 when the stream is not accessible", async () => {
    const updateStream = mock(() => Promise.resolve(fakeStream()))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(null)),
      updateStream,
    } as unknown as StreamService)

    await expect(handlers.updateStream(userRequest({ description: "x" }), createResponse().res)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(updateStream).not.toHaveBeenCalled()
  })

  it("returns 404 when the stream no longer exists", async () => {
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      updateStream: mock(() => Promise.resolve(null)),
    } as unknown as StreamService)

    await expect(handlers.updateStream(userRequest({ description: "x" }), createResponse().res)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })
  })
})
