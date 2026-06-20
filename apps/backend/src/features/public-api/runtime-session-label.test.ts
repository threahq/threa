import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { LabelActorTypes, LabelableResourceTypes } from "@threa/types"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"

function personalBot(ownerUserId: string) {
  return { id: "bot_1", workspaceId: "ws_1", type: "personal", ownerUserId, archivedAt: null } as never
}

function createResponse() {
  let statusCode = 200
  let body: unknown
  const res = {} as Response
  res.status = mock((code: number) => {
    statusCode = code
    return res
  }) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  res.end = mock(() => res) as unknown as Response["end"]
  return { res, status: () => statusCode, body: () => body }
}

function createPool() {
  const client = {
    query: mock(() => Promise.resolve({ rows: [] })),
    release: mock(() => undefined),
  }
  return { pool: { connect: mock(() => Promise.resolve(client)) } as never, client }
}

function createHandlers(overrides: Partial<PublicApiDeps> = {}) {
  const { pool, client } = createPool()
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {
      createScratchpadInTransaction: mock(() => Promise.resolve({ id: "stream_1" })),
      addBotToStreamOn: mock(() => Promise.resolve()),
    } as unknown as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      repairBotTraitsInTransaction: mock(() => Promise.resolve()),
      createOrLinkPiRemoteSessionInTransaction: mock(() =>
        Promise.resolve({
          id: "brsl_1",
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
          runtimeSessionId: "sess_1",
        })
      ),
    } as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {
      assignByNameInTransaction: mock(() => Promise.resolve({})),
    } as unknown as PublicApiDeps["labelAssignmentService"],
    pool,
    io: {} as PublicApiDeps["io"],
    ...overrides,
  }
  return { handlers: createPublicApiHandlers(deps), deps, client }
}

function botRequest(body: unknown): Request {
  return {
    workspaceId: "ws_1",
    body,
    params: {},
    query: {},
    botApiKey: { id: "bkey_1", botId: "bot_1" },
  } as unknown as Request
}

describe("bot runtime session labels", () => {
  afterEach(() => mock.restore())

  it("assigns an optional label by name for the personal bot owner", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const assignByNameInTransaction = mock(() => Promise.resolve({}))
    const { handlers, deps } = createHandlers({
      labelAssignmentService: { assignByNameInTransaction } as unknown as PublicApiDeps["labelAssignmentService"],
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(
      botRequest({
        runtimeKind: "pi-local",
        instanceId: "inst_1",
        runtimeSessionId: "sess_1",
        displayName: "Pi remote - threa",
        labelName: "Pi remote",
      }),
      cap.res
    )

    expect(deps.streamService.createScratchpadInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createdBy: "usr_owner" })
    )
    expect(assignByNameInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: { type: LabelActorTypes.USER, id: "usr_owner" },
        name: "Pi remote",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: "stream_1",
      })
    )
    expect(cap.body()).toMatchObject({
      data: {
        linkId: "brsl_1",
        rootStreamId: "stream_1",
        activeStreamId: "stream_1",
        runtimeSessionId: "sess_1",
      },
    })
  })

  it("rejects the session creation when label assignment fails", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const assignByNameInTransaction = mock(() => Promise.reject(new Error("boom")))
    const { handlers, deps, client } = createHandlers({
      labelAssignmentService: { assignByNameInTransaction } as unknown as PublicApiDeps["labelAssignmentService"],
    })
    const cap = createResponse()

    await expect(
      handlers.createBotRuntimeSession(
        botRequest({
          runtimeKind: "pi-local",
          instanceId: "inst_1",
          runtimeSessionId: "sess_1",
          displayName: "Pi remote - threa",
          labelName: "Pi remote",
        }),
        cap.res
      )
    ).rejects.toThrow("boom")

    expect(deps.botRuntimeService.createOrLinkPiRemoteSessionInTransaction).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledWith("ROLLBACK")
  })
})
