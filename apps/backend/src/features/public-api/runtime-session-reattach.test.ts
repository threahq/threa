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

  it("resumes the revived link when the create loses a race to the unarchive consumer (23505)", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const revivedLink = {
      id: "brsl_1",
      rootStreamId: "stream_old",
      activeStreamId: "stream_old",
      runtimeSessionId: "sess_1",
    }
    // First read misses (link still 'archived'); by the time the insert runs the
    // unarchive consumer has flipped it 'active' → identity unique violation.
    const findActive = mock()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(revivedLink as never)
    const uniqueViolation = Object.assign(new Error("duplicate key value"), { code: "23505" })
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as never))
    const repairBotTraitsInTransaction = mock(() => Promise.resolve())
    const handlers = createHandlers({
      findActivePiRemoteSession: findActive,
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
      createLinkedScratchpadSession: mock(() => Promise.reject(uniqueViolation)),
      repairBotTraitsInTransaction,
    })
    const cap = createResponse()

    await handlers.createBotRuntimeSession(botRequest(), cap.res)

    expect(cap.body()).toMatchObject({
      data: { linkId: "brsl_1", rootStreamId: "stream_old", runtimeSessionId: "sess_1" },
    })
    // The recovery path repairs runtime traits like the other resume paths, so
    // the revived session can still receive active-scratchpad dispatches.
    expect(repairBotTraitsInTransaction).toHaveBeenCalled()
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

  it("ifMissing=error refuses to create a scratchpad when no session link exists", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("must not create a new scratchpad")))
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "none" })),
      createLinkedScratchpadSession,
    })
    const req = botRequest()
    ;(req.body as Record<string, unknown>).ifMissing = "error"

    await expect(handlers.createBotRuntimeSession(req, createResponse().res)).rejects.toMatchObject({
      status: 409,
      code: "RUNTIME_SESSION_NOT_FOUND",
    })
    expect(createLinkedScratchpadSession).not.toHaveBeenCalled()
  })

  it("ifArchived=replace retires the archived link and creates a fresh scratchpad instead of 409ing", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    const retireArchivedRuntimeSession = mock(() => Promise.resolve(true))
    const createLinkedScratchpadSession = mock(() =>
      Promise.resolve({
        link: { id: "brsl_new", rootStreamId: "stream_new", activeStreamId: "stream_new", runtimeSessionId: "sess_1" },
        stream: { id: "stream_new" },
      })
    )
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "archived_stream" })),
      retireArchivedRuntimeSession,
      createLinkedScratchpadSession,
    })
    const req = botRequest()
    ;(req.body as Record<string, unknown>).ifArchived = "replace"
    const cap = createResponse()

    await handlers.createBotRuntimeSession(req, cap.res)

    expect(retireArchivedRuntimeSession).toHaveBeenCalled()
    expect(createLinkedScratchpadSession).toHaveBeenCalled()
    expect(cap.body()).toMatchObject({ data: { linkId: "brsl_new", rootStreamId: "stream_new" } })
  })

  it("ifArchived=replace resumes the revived link when a concurrent unarchive wins the retire race", async () => {
    spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as never))
    const createLinkedScratchpadSession = mock(() => Promise.reject(new Error("must not create a new scratchpad")))
    // Nothing to retire (the stream is no longer archived) → the handler re-runs
    // the reattach and resumes the link the unarchive consumer revived.
    const reattach = mock()
      .mockResolvedValueOnce({ status: "archived_stream" })
      .mockResolvedValueOnce({
        status: "reattached",
        link: { id: "brsl_1", rootStreamId: "stream_old", activeStreamId: "stream_old", runtimeSessionId: "sess_1" },
      })
    const handlers = createHandlers({
      findActivePiRemoteSession: mock(() => Promise.resolve(null)),
      reattachArchivedRuntimeSession: reattach,
      retireArchivedRuntimeSession: mock(() => Promise.resolve(false)),
      repairBotTraitsInTransaction: mock(() => Promise.resolve()),
      createLinkedScratchpadSession,
    })
    const req = botRequest()
    ;(req.body as Record<string, unknown>).ifArchived = "replace"
    const cap = createResponse()

    await handlers.createBotRuntimeSession(req, cap.res)

    expect(createLinkedScratchpadSession).not.toHaveBeenCalled()
    expect(cap.body()).toMatchObject({ data: { linkId: "brsl_1", rootStreamId: "stream_old" } })
  })

  it("ifArchived=wait (and default) keeps the 409 SCRATCHPAD_ARCHIVED contract", async () => {
    for (const ifArchived of ["wait", undefined]) {
      spyOn(BotRepository, "findById").mockResolvedValue(personalBot("usr_owner"))
      const retireArchivedRuntimeSession = mock(() => Promise.resolve(true))
      const handlers = createHandlers({
        findActivePiRemoteSession: mock(() => Promise.resolve(null)),
        reattachArchivedRuntimeSession: mock(() => Promise.resolve({ status: "archived_stream" })),
        retireArchivedRuntimeSession,
        createLinkedScratchpadSession: mock(() => Promise.reject(new Error("must not create a new scratchpad"))),
      })
      const req = botRequest()
      if (ifArchived !== undefined) (req.body as Record<string, unknown>).ifArchived = ifArchived

      await expect(handlers.createBotRuntimeSession(req, createResponse().res)).rejects.toMatchObject({
        status: 409,
        code: "SCRATCHPAD_ARCHIVED",
      })
      expect(retireArchivedRuntimeSession).not.toHaveBeenCalled()
      mock.restore()
    }
  })
})
