import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { BotRepository } from "./bot-repository"
import { E2eStreamsRepository } from "../e2e-streams"
import * as db from "../../db"

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
  return { res, body: () => body }
}

function createHandlers(botRuntimeService: Record<string, unknown>) {
  const deps: PublicApiDeps = {
    eventService: {} as PublicApiDeps["eventService"],
    streamService: {} as PublicApiDeps["streamService"],
    searchService: {} as PublicApiDeps["searchService"],
    featureFlagService: {} as PublicApiDeps["featureFlagService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: botRuntimeService as unknown as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  }
  return createPublicApiHandlers(deps)
}

function attachRequest() {
  return {
    workspaceId: "ws_1",
    body: {
      runtimeKind: "claude-code-channel",
      instanceId: "inst_1",
      runtimeSessionId: "sess_1",
      displayName: "Claude Code - threa",
      attachTo: { rootStreamId: "stream_root", anchorId: "msg_1" },
    },
    params: {},
    query: {},
    botApiKey: { id: "bkey_1", botId: "bot_1" },
  } as unknown as Request
}

describe("createBotRuntimeSession attachTo", () => {
  afterEach(() => mock.restore())

  it("routes attachTo to attachRuntimeSessionToThread and never mints a fresh scratchpad", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("must not create a new scratchpad")))
    const attachRuntimeSessionToThread = mock(() =>
      Promise.resolve({
        link: {
          id: "brsl_1",
          rootStreamId: "stream_root",
          activeStreamId: "stream_thread",
          runtimeSessionId: "sess_1",
        },
        stream: { id: "stream_thread", e2eEnabled: false },
      })
    )
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      attachRuntimeSessionToThread,
      createLinkedScratchpadSession,
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(attachRequest(), cap.res)

    expect(attachRuntimeSessionToThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_1",
        botId: "bot_1",
        ownerUserId: "usr_owner",
        rootStreamId: "stream_root",
        anchorId: "msg_1",
      })
    )
    expect(createLinkedScratchpadSession).not.toHaveBeenCalled()
    expect(cap.body()).toMatchObject({
      data: {
        linkId: "brsl_1",
        rootStreamId: "stream_root",
        activeStreamId: "stream_thread",
        runtimeSessionId: "sess_1",
      },
    })
  })

  it("resumes the link that won a runtime-identity conflict instead of surfacing the 23505", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as never))
    const winner = {
      id: "brsl_winner",
      rootStreamId: "stream_other_root",
      activeStreamId: "stream_other_thread",
      runtimeSessionId: "sess_1",
    }
    const findActivePiRemoteSession = mock().mockResolvedValueOnce(null).mockResolvedValueOnce(winner)
    const handlers = createHandlers({
      findActivePiRemoteSession,
      attachRuntimeSessionToThread: mock(() => Promise.reject(Object.assign(new Error("unique"), { code: "23505" }))),
      repairBotTraitsInTransaction: mock(() => Promise.resolve()),
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(attachRequest(), cap.res)

    expect(cap.body()).toEqual({
      data: {
        linkId: "brsl_winner",
        rootStreamId: "stream_other_root",
        activeStreamId: "stream_other_thread",
        runtimeSessionId: "sess_1",
        streamUrlPath: "/w/ws_1/s/stream_other_thread",
        e2eEnabled: false,
      },
    })
  })

  it("answers a 409 when the conflicting identity is held by a finished link", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const handlers = createHandlers({
      // Both reads miss: the identity belongs to a link that is no longer
      // active, so there is nothing to resume and the SQLSTATE must not escape.
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      attachRuntimeSessionToThread: mock(() => Promise.reject(Object.assign(new Error("unique"), { code: "23505" }))),
    })
    const cap = createResponse()

    await expect(handlers.createBotRuntimeSession(attachRequest(), cap.res)).rejects.toMatchObject({
      status: 409,
      code: "RUNTIME_SESSION_CONFLICT",
    })
  })

  it("rethrows a non-identity failure from the attach", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      attachRuntimeSessionToThread: mock(() => Promise.reject(Object.assign(new Error("boom"), { code: "XX000" }))),
    })
    const cap = createResponse()

    await expect(handlers.createBotRuntimeSession(attachRequest(), cap.res)).rejects.toMatchObject({ code: "XX000" })
  })

  it("identity reuse wins before the attachTo branch is reached", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as never))
    const attachRuntimeSessionToThread = mock(() => Promise.reject(new Error("must not be called")))
    const repairBotTraitsInTransaction = mock(() => Promise.resolve())
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() =>
        Promise.resolve({
          id: "brsl_existing",
          rootStreamId: "stream_existing_root",
          activeStreamId: "stream_existing_active",
          runtimeSessionId: "sess_1",
        })
      ),
      attachRuntimeSessionToThread,
      repairBotTraitsInTransaction,
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(attachRequest(), cap.res)

    expect(attachRuntimeSessionToThread).not.toHaveBeenCalled()
    expect(cap.body()).toMatchObject({
      data: { linkId: "brsl_existing", rootStreamId: "stream_existing_root", activeStreamId: "stream_existing_active" },
    })
  })
})
