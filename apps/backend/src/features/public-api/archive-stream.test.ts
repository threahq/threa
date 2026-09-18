import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import { WORKSPACE_PERMISSION_SCOPES } from "@threahq/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { PUBLIC_API_ROUTES } from "./routes"
import type { StreamService } from "../streams"

const ARCHIVED_AT = new Date("2026-09-18T09:00:00.000Z")

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
    type: "scratchpad",
    displayName: "Agent scratchpad",
    slug: null,
    description: null,
    descriptionJson: null,
    visibility: "private",
    parentStreamId: null,
    parentAnchorId: null,
    rootStreamId: null,
    companionMode: "off",
    companionPersonaId: null,
    memoryMode: "auto",
    createdBy: "usr_1",
    createdAt: new Date("2026-09-18T08:00:00.000Z"),
    updatedAt: new Date("2026-09-18T08:00:00.000Z"),
    archivedAt: null,
    ...overrides,
  }
}

function createHandlers(
  streamService: Partial<StreamService>,
  botAccess: { isStreamRetrievableForBot?: boolean } = {}
) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: streamService as StreamService,
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {
      isStreamRetrievableForBot: mock(() => Promise.resolve(botAccess.isStreamRetrievableForBot ?? true)),
    } as unknown as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function userRequest(): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    userApiKey: { id: "key_1" },
    user: { id: "usr_1", name: "Tester" },
  } as unknown as Request
}

function botRequest(): Request {
  return {
    workspaceId: "ws_1",
    params: { streamId: "stream_1" },
    botApiKey: { botId: "bot_1" },
  } as unknown as Request
}

describe("public API archiveStream / unarchiveStream", () => {
  it("archives as the key owner and returns the archived stream", async () => {
    const setStreamArchived = mock(() => Promise.resolve(fakeStream({ archivedAt: ARCHIVED_AT })))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      setStreamArchived,
    } as unknown as StreamService)

    const { res, getBody } = createResponse()
    await handlers.archiveStream(userRequest(), res)

    expect(setStreamArchived).toHaveBeenCalledWith("ws_1", "stream_1", { kind: "user", userId: "usr_1" }, true)
    expect(getBody()).toEqual({
      data: {
        id: "stream_1",
        type: "scratchpad",
        displayName: "Agent scratchpad",
        visibility: "private",
        memoryMode: "auto",
        createdAt: "2026-09-18T08:00:00.000Z",
        archivedAt: ARCHIVED_AT.toISOString(),
      },
    })
  })

  it("unarchives as the key owner and reports the stream live again", async () => {
    const setStreamArchived = mock(() => Promise.resolve(fakeStream({ archivedAt: null })))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream({ archivedAt: ARCHIVED_AT }))),
      setStreamArchived,
    } as unknown as StreamService)

    const { res, getBody } = createResponse()
    await handlers.unarchiveStream(userRequest(), res)

    expect(setStreamArchived).toHaveBeenCalledWith("ws_1", "stream_1", { kind: "user", userId: "usr_1" }, false)
    expect(getBody()).toMatchObject({ data: { id: "stream_1" } })
    expect((getBody() as { data: Record<string, unknown> }).data.archivedAt).toBeUndefined()
  })

  it("acts as the bot behind a workspace-scoped key", async () => {
    const setStreamArchived = mock(() => Promise.resolve(fakeStream({ archivedAt: ARCHIVED_AT })))
    const handlers = createHandlers({ setStreamArchived } as unknown as StreamService)

    await handlers.archiveStream(botRequest(), createResponse().res)

    expect(setStreamArchived).toHaveBeenCalledWith("ws_1", "stream_1", { kind: "bot", botId: "bot_1" }, true)
  })

  it("reaches an already-archived stream: the access gate allows archived targets", async () => {
    const tryAccess = mock(() => Promise.resolve(fakeStream({ archivedAt: ARCHIVED_AT })))
    const setStreamArchived = mock(() => Promise.resolve(fakeStream({ archivedAt: ARCHIVED_AT })))
    const handlers = createHandlers({ tryAccess, setStreamArchived } as unknown as StreamService)

    await handlers.archiveStream(userRequest(), createResponse().res)

    expect(setStreamArchived).toHaveBeenCalledTimes(1)
  })

  it("rejects with 403 without leaking existence when the key cannot see the stream", async () => {
    const setStreamArchived = mock(() => Promise.resolve(fakeStream()))
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(null)),
      setStreamArchived,
    } as unknown as StreamService)

    await expect(handlers.archiveStream(userRequest(), createResponse().res)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(setStreamArchived).not.toHaveBeenCalled()
  })

  it("rejects a bot key with no grant on the stream", async () => {
    const setStreamArchived = mock(() => Promise.resolve(fakeStream()))
    const handlers = createHandlers({ setStreamArchived } as unknown as StreamService, {
      isStreamRetrievableForBot: false,
    })

    await expect(handlers.unarchiveStream(botRequest(), createResponse().res)).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
    })
    expect(setStreamArchived).not.toHaveBeenCalled()
  })

  it("returns 404 when the stream disappeared under the flip", async () => {
    const handlers = createHandlers({
      tryAccess: mock(() => Promise.resolve(fakeStream())),
      setStreamArchived: mock(() => Promise.resolve(null)),
    } as unknown as StreamService)

    await expect(handlers.archiveStream(userRequest(), createResponse().res)).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    })
  })

  it("declares both routes under streams:write, the scope its neighbouring write already needs", () => {
    const declared = PUBLIC_API_ROUTES.filter(
      (route) => route.operationId === "archiveStream" || route.operationId === "unarchiveStream"
    ).map((route) => ({ operationId: route.operationId, method: route.method, path: route.path, scopes: route.scopes }))

    expect(declared).toEqual([
      {
        operationId: "archiveStream",
        method: "post",
        path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/archive",
        scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_WRITE],
      },
      {
        operationId: "unarchiveStream",
        method: "post",
        path: "/api/v1/workspaces/{workspaceId}/streams/{streamId}/unarchive",
        scopes: [WORKSPACE_PERMISSION_SCOPES.STREAMS_WRITE],
      },
    ])
  })
})
