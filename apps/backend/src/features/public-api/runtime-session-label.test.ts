import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"

function personalBot(ownerUserId: string) {
  return { id: "bot_1", workspaceId: "ws_1", type: "personal", ownerUserId, archivedAt: null } as never
}

function createResponse() {
  let body: unknown
  const res = {} as Response
  res.status = mock(() => res) as unknown as Response["status"]
  res.json = mock((payload: unknown) => {
    body = payload
    return res
  }) as unknown as Response["json"]
  res.end = mock(() => res) as unknown as Response["end"]
  return { res, body: () => body }
}

function createHandlers(overrides: Partial<PublicApiDeps> = {}) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
      createLinkedScratchpadSession: mock(() =>
        Promise.resolve({
          link: {
            id: "brsl_1",
            rootStreamId: "stream_1",
            activeStreamId: "stream_1",
            runtimeSessionId: "sess_1",
          },
          stream: { id: "stream_1" },
        })
      ),
    } as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
    ...overrides,
  }
  return { handlers: createPublicApiHandlers(deps), deps }
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

  it("delegates label creation to the runtime session service for the personal bot owner", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() =>
      Promise.resolve({
        link: {
          id: "brsl_1",
          rootStreamId: "stream_1",
          activeStreamId: "stream_1",
          runtimeSessionId: "sess_1",
        },
        stream: { id: "stream_1" },
      })
    )
    const { handlers } = createHandlers({
      botRuntimeService: {
        findActivePiRemoteSession: mock(() => Promise.resolve(null)),
        reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
        createLinkedScratchpadSession,
      } as unknown as PublicApiDeps["botRuntimeService"],
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

    expect(createLinkedScratchpadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        botId: "bot_1",
        ownerUserId: "usr_owner",
        runtimeKind: "pi-local",
        instanceId: "inst_1",
        runtimeSessionId: "sess_1",
        displayName: "Pi remote - threa",
        labelName: "Pi remote",
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

  it("rejects the handler when the runtime session service rejects", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("boom")))
    const { handlers } = createHandlers({
      botRuntimeService: {
        findActivePiRemoteSession: mock(() => Promise.resolve(null)),
        reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
        createLinkedScratchpadSession,
      } as unknown as PublicApiDeps["botRuntimeService"],
    })

    await expect(
      handlers.createBotRuntimeSession(
        botRequest({
          runtimeKind: "pi-local",
          instanceId: "inst_1",
          runtimeSessionId: "sess_1",
          displayName: "Pi remote - threa",
          labelName: "Pi remote",
        }),
        createResponse().res
      )
    ).rejects.toThrow("boom")
  })
})
