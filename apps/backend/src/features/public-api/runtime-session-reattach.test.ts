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

function botRequest(): Request {
  return {
    workspaceId: "ws_1",
    body: {
      runtimeKind: "claude-code-channel",
      instanceId: "inst_1",
      runtimeSessionId: "sess_1",
      displayName: "Claude Code - threa",
    },
    params: {},
    query: {},
    botApiKey: { id: "bkey_1", botId: "bot_1" },
  } as unknown as Request
}

describe("createBotRuntimeSession reattach after unarchive", () => {
  afterEach(() => mock.restore())

  it("revives the archived link for the same runtime session instead of creating a new scratchpad", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as never))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("must not create a new scratchpad")))
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() =>
        Promise.resolve({
          status: "reattached",
          link: {
            id: "brsl_1",
            rootStreamId: "stream_old",
            activeStreamId: "stream_old",
            runtimeSessionId: "sess_1",
          },
        })
      ),
      repairBotTraitsInTransaction: mock(() => Promise.resolve()),
      createLinkedScratchpadSession,
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(botRequest(), cap.res)

    expect(createLinkedScratchpadSession).not.toHaveBeenCalled()
    expect(cap.body()).toMatchObject({
      data: { linkId: "brsl_1", rootStreamId: "stream_old", activeStreamId: "stream_old", runtimeSessionId: "sess_1" },
    })
  })

  it("409s with SCRATCHPAD_ARCHIVED while the linked scratchpad is still archived — never mints a duplicate", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("must not create a new scratchpad")))
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "archived_stream" })),
      createLinkedScratchpadSession,
    })

    await expect(handlers.createBotRuntimeSession(botRequest(), createResponse().res)).rejects.toMatchObject({
      status: 409,
      code: "SCRATCHPAD_ARCHIVED",
    })
    expect(createLinkedScratchpadSession).not.toHaveBeenCalled()
  })

  it("falls through to scratchpad creation when the runtime session has no archived link", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() =>
      Promise.resolve({
        link: { id: "brsl_new", rootStreamId: "stream_new", activeStreamId: "stream_new", runtimeSessionId: "sess_1" },
        stream: { id: "stream_new" },
      })
    )
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
      createLinkedScratchpadSession,
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(botRequest(), cap.res)

    expect(createLinkedScratchpadSession).toHaveBeenCalled()
    expect(cap.body()).toMatchObject({ data: { linkId: "brsl_new", rootStreamId: "stream_new" } })
  })
})
