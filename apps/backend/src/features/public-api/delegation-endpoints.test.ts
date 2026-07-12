import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool, PoolClient } from "pg"
import { AuthorTypes, DelegationStatuses, THREA_CALLBACK_TOKEN_HEADER } from "@threa/types"
import * as db from "../../db"
import * as streams from "../streams"
import { E2eStreamsRepository } from "../e2e-streams"
import { hashCallbackToken } from "../agents"
import type { BotChannelService } from "../api-keys"
import type { DelegatedTask, DelegationService } from "../delegations"
import type { EventService } from "../messaging"
import type { StreamService } from "../streams"
import { BotRepository } from "./bot-repository"
import { createDelegationPublicApiHandlers } from "./delegation-handlers"

const NOW = new Date("2026-07-10T12:00:00.000Z")

function makeDelegation(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: "dlg_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    sessionId: null,
    sourceConversationId: null,
    createdByKind: "persona",
    createdById: "persona_system_ariadne",
    title: "Add rate limiting",
    brief: "Do the thing. Done when tests pass.",
    contextRefs: ["memo:memo_1"],
    status: DelegationStatuses.OPEN,
    claimTokenHash: null,
    claimIdempotencyKey: null,
    claimExpiresAt: null,
    claimedByLabel: null,
    resultMessageId: null,
    statusNote: null,
    createdAt: NOW,
    updatedAt: NOW,
    statusChangedAt: NOW,
    ...overrides,
  }
}

function createResponse() {
  const payloads: unknown[] = []
  const res = {
    json: mock((payload: unknown) => {
      payloads.push(payload)
      return res
    }),
    status: mock(() => res),
  } as unknown as Response
  return { res, payloads }
}

interface RequestOptions {
  userKey?: boolean
  botKey?: boolean
  token?: string
  body?: unknown
  query?: unknown
}

function makeRequest({ userKey = true, botKey = false, token, body = {}, query = {} }: RequestOptions = {}) {
  return {
    workspaceId: "ws_1",
    params: { delegationId: "dlg_1" },
    body,
    query,
    user: userKey ? { id: "usr_1", name: "Kris" } : undefined,
    userApiKey: userKey ? { id: "uak_1", workspaceId: "ws_1", userId: "usr_1", scopes: new Set() } : undefined,
    botApiKey: botKey ? { id: "bak_1", workspaceId: "ws_1", botId: "bot_1", scopes: new Set() } : undefined,
    header: (name: string) => (name === THREA_CALLBACK_TOKEN_HEADER ? token : undefined),
  } as unknown as Request
}

function makeHandlers(overrides: {
  delegationService?: Partial<DelegationService>
  eventService?: Partial<EventService>
  streamService?: Partial<StreamService>
  botChannelService?: Partial<BotChannelService>
}) {
  return createDelegationPublicApiHandlers({
    pool: { __pool: true } as unknown as Pool,
    delegationService: (overrides.delegationService ?? {}) as DelegationService,
    eventService: (overrides.eventService ?? {}) as EventService,
    streamService: (overrides.streamService ?? {}) as StreamService,
    botChannelService: (overrides.botChannelService ?? {}) as BotChannelService,
  })
}

afterEach(() => mock.restore())

describe("delegation public API — key + token gates", () => {
  it("401s every endpoint without any API key context", async () => {
    const handlers = makeHandlers({})
    const { res } = createResponse()
    const bareReq = makeRequest({ userKey: false, botKey: false })
    for (const handler of [
      handlers.listDelegations,
      handlers.claimDelegation,
      handlers.heartbeatDelegation,
      handlers.reportDelegationStatus,
      handlers.completeDelegation,
      handlers.failDelegation,
    ]) {
      await expect(handler(bareReq, res)).rejects.toMatchObject({ status: 401 })
    }
  })

  it("401s a claim-authenticated call without the callback-token header", async () => {
    const handlers = makeHandlers({})
    const { res } = createResponse()
    await expect(handlers.heartbeatDelegation(makeRequest(), res)).rejects.toMatchObject({ status: 401 })
  })
})

describe("listDelegations", () => {
  it("returns only open delegations in streams the key's user can access", async () => {
    const listOpen = mock(async () => [
      makeDelegation({ id: "dlg_visible", streamId: "stream_ok" }),
      makeDelegation({ id: "dlg_hidden", streamId: "stream_secret" }),
    ])
    spyOn(streams, "listAccessibleStreamIds").mockResolvedValue(new Set(["stream_ok"]))
    const handlers = makeHandlers({ delegationService: { listOpen } })
    const { res, payloads } = createResponse()

    await handlers.listDelegations(makeRequest(), res)

    const data = (payloads[0] as { data: Array<{ id: string }> }).data
    expect(data.map((d) => d.id)).toEqual(["dlg_visible"])
  })

  it("filters by the bot's channel grants for a workspace (bot) key", async () => {
    const listOpen = mock(async () => [
      makeDelegation({ id: "dlg_granted", streamId: "stream_granted" }),
      makeDelegation({ id: "dlg_other", streamId: "stream_other" }),
    ])
    const getAccessibleStreamIdsForBot = mock(async () => ["stream_granted"])
    const handlers = makeHandlers({
      delegationService: { listOpen },
      botChannelService: { getAccessibleStreamIdsForBot },
    })
    const { res, payloads } = createResponse()

    await handlers.listDelegations(makeRequest({ userKey: false, botKey: true }), res)

    expect(getAccessibleStreamIdsForBot).toHaveBeenCalledWith("ws_1", "bot_1")
    const data = (payloads[0] as { data: Array<{ id: string }> }).data
    expect(data.map((d) => d.id)).toEqual(["dlg_granted"])
  })
})

describe("claimDelegation", () => {
  it("404s (hiding existence) when the user cannot access the delegation's stream", async () => {
    const handlers = makeHandlers({
      delegationService: { getById: mock(async () => makeDelegation()) },
      streamService: { tryAccess: mock(async () => null) },
    })
    const { res } = createResponse()
    await expect(handlers.claimDelegation(makeRequest({ body: { claimedByLabel: "Rig" } }), res)).rejects.toMatchObject(
      { status: 404 }
    )
  })

  it("gates a bot-key claim on the bot's channel grants (404 without one)", async () => {
    const isStreamAccessibleForBot = mock(async () => false)
    const handlers = makeHandlers({
      delegationService: { getById: mock(async () => makeDelegation()) },
      botChannelService: { isStreamAccessibleForBot },
    })
    const { res } = createResponse()

    await expect(
      handlers.claimDelegation(makeRequest({ userKey: false, botKey: true, body: { claimedByLabel: "Runner" } }), res)
    ).rejects.toMatchObject({ status: 404 })
    expect(isStreamAccessibleForBot).toHaveBeenCalledWith("ws_1", "bot_1", "stream_1")
  })

  it("409s a lost claim race with DELEGATION_NOT_OPEN", async () => {
    const handlers = makeHandlers({
      delegationService: {
        getById: mock(async () => makeDelegation()),
        claim: mock(async () => ({ ok: false as const, reason: "not_open" as const })),
      },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res } = createResponse()
    await expect(handlers.claimDelegation(makeRequest({ body: { claimedByLabel: "Rig" } }), res)).rejects.toMatchObject(
      { status: 409, code: "DELEGATION_NOT_OPEN" }
    )
  })

  it("returns the executor's working set: brief, contextRefs, and the cleartext claim token once", async () => {
    const claimed = makeDelegation({
      status: DelegationStatuses.CLAIMED,
      claimedByLabel: "Rig",
      claimExpiresAt: new Date("2026-07-10T12:15:00.000Z"),
    })
    const handlers = makeHandlers({
      delegationService: {
        getById: mock(async () => makeDelegation()),
        claim: mock(async () => ({ ok: true as const, delegation: claimed, claimToken: "token-cleartext" })),
      },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res, payloads } = createResponse()

    await handlers.claimDelegation(makeRequest({ body: { claimedByLabel: "Rig" } }), res)

    expect((payloads[0] as { data: object }).data).toMatchObject({
      id: "dlg_1",
      status: DelegationStatuses.CLAIMED,
      brief: "Do the thing. Done when tests pass.",
      contextRefs: ["memo:memo_1"],
      claimToken: "token-cleartext",
      claimExpiresAt: "2026-07-10T12:15:00.000Z",
    })
  })
})

describe("heartbeat / status / fail — token-guarded transitions", () => {
  it("404s when the claim is gone (lapsed, stolen, or terminal)", async () => {
    const handlers = makeHandlers({
      delegationService: {
        heartbeat: mock(async () => null),
        markRunning: mock(async () => null),
        fail: mock(async () => null),
        // Non-terminal row: the fail path's idempotent-retry check falls through.
        getById: mock(async () => makeDelegation()),
      },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res } = createResponse()
    const req = makeRequest({ token: "tok", body: { errorMessage: "boom" } })
    await expect(handlers.heartbeatDelegation(req, res)).rejects.toMatchObject({ status: 404 })
    await expect(handlers.reportDelegationStatus(req, res)).rejects.toMatchObject({ status: 404 })
    await expect(handlers.failDelegation(req, res)).rejects.toMatchObject({ status: 404 })
  })

  it("404s every claim-authenticated op once stream access is revoked (heartbeats stop renewing)", async () => {
    const heartbeat = mock(async () => new Date())
    const handlers = makeHandlers({
      delegationService: { getById: mock(async () => makeDelegation()), heartbeat },
      streamService: { tryAccess: mock(async () => null) },
    })
    const { res } = createResponse()

    await expect(handlers.heartbeatDelegation(makeRequest({ token: "tok" }), res)).rejects.toMatchObject({
      status: 404,
    })
    expect(heartbeat).not.toHaveBeenCalled()
  })

  it("passes the header token and note through to markRunning", async () => {
    const markRunning = mock(async () => makeDelegation({ status: DelegationStatuses.RUNNING, statusNote: "halfway" }))
    const handlers = makeHandlers({
      delegationService: { markRunning, getById: mock(async () => makeDelegation()) },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res, payloads } = createResponse()

    await handlers.reportDelegationStatus(makeRequest({ token: "tok", body: { statusNote: "halfway" } }), res)

    expect((markRunning.mock.calls[0] as unknown[])[0]).toMatchObject({
      workspaceId: "ws_1",
      id: "dlg_1",
      claimToken: "tok",
      statusNote: "halfway",
    })
    expect((payloads[0] as { data: { statusNote?: string } }).data.statusNote).toBe("halfway")
  })

  it("records the failure reason as the card's status note", async () => {
    const fail = mock(async () => makeDelegation({ status: DelegationStatuses.FAILED, statusNote: "boom" }))
    const handlers = makeHandlers({
      delegationService: { fail, getById: mock(async () => makeDelegation()) },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res } = createResponse()

    await handlers.failDelegation(makeRequest({ token: "tok", body: { errorMessage: "boom" } }), res)

    expect((fail.mock.calls[0] as unknown[])[0]).toMatchObject({ claimToken: "tok", statusNote: "boom" })
  })
})

describe("completeDelegation", () => {
  function transactionalHandlers(overrides: {
    completeInTransaction?: DelegationService["completeInTransaction"]
    createMessageInTransaction?: EventService["createMessageInTransaction"]
    findClaimedForUpdate?: DelegationService["findClaimedForUpdate"]
    isE2e?: boolean
  }) {
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as PoolClient))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(overrides.isE2e ?? false)
    const createMessageInTransaction =
      overrides.createMessageInTransaction ??
      (mock(async () => ({ message: { id: "msg_result" } })) as unknown as EventService["createMessageInTransaction"])
    const completeInTransaction =
      overrides.completeInTransaction ??
      (mock(async () =>
        makeDelegation({ status: DelegationStatuses.COMPLETED, resultMessageId: "msg_result" })
      ) as DelegationService["completeInTransaction"])
    const findClaimedForUpdate =
      overrides.findClaimedForUpdate ??
      (mock(async () =>
        makeDelegation({ status: DelegationStatuses.CLAIMED })
      ) as DelegationService["findClaimedForUpdate"])
    return {
      handlers: makeHandlers({
        delegationService: { getById: mock(async () => makeDelegation()), completeInTransaction, findClaimedForUpdate },
        streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
        botChannelService: { isStreamAccessibleForBot: mock(async () => true) },
        eventService: { createMessageInTransaction },
      }),
      createMessageInTransaction,
      completeInTransaction,
      findClaimedForUpdate,
    }
  }

  it("posts the result as the key's user (sentVia provenance) and completes in the same transaction", async () => {
    const { handlers, createMessageInTransaction, completeInTransaction } = transactionalHandlers({})
    const { res, payloads } = createResponse()

    await handlers.completeDelegation(
      makeRequest({ token: "tok", body: { resultMarkdown: "All done.", metadata: { "github.pr": "https://x/1" } } }),
      res
    )

    const messageParams = (createMessageInTransaction as ReturnType<typeof mock>).mock.calls[0][1]
    expect(messageParams).toMatchObject({
      streamId: "stream_1",
      authorId: "usr_1",
      authorType: AuthorTypes.USER,
      contentMarkdown: "All done.",
      clientMessageId: "delegation:dlg_1",
      sentVia: "api_key:uak_1",
      metadata: { "github.pr": "https://x/1" },
    })
    expect((completeInTransaction as ReturnType<typeof mock>).mock.calls[0][1]).toMatchObject({
      claimToken: "tok",
      resultMessageId: "msg_result",
    })
    expect((payloads[0] as { data: { resultMessageId?: string } }).data.resultMessageId).toBe("msg_result")
  })

  it("404s (rolling the message back with the transaction) when the claim CAS matches nothing", async () => {
    const { handlers } = transactionalHandlers({
      completeInTransaction: mock(async () => null) as DelegationService["completeInTransaction"],
    })
    const { res } = createResponse()
    await expect(
      handlers.completeDelegation(makeRequest({ token: "tok", body: { resultMarkdown: "All done." } }), res)
    ).rejects.toMatchObject({ status: 404 })
  })

  it("completes without posting a message when no result is given", async () => {
    const { handlers, createMessageInTransaction, completeInTransaction } = transactionalHandlers({})
    const { res } = createResponse()

    await handlers.completeDelegation(makeRequest({ token: "tok", body: {} }), res)

    expect((createMessageInTransaction as ReturnType<typeof mock>).mock.calls.length).toBe(0)
    expect((completeInTransaction as ReturnType<typeof mock>).mock.calls[0][1]).toMatchObject({
      resultMessageId: undefined,
    })
  })

  it("authors the result as the bot for a workspace (bot) key, with no sentVia", async () => {
    const { handlers, createMessageInTransaction } = transactionalHandlers({})
    spyOn(BotRepository, "findById").mockResolvedValue({ id: "bot_1", name: "Runner", archivedAt: null } as never)
    const { res } = createResponse()

    await handlers.completeDelegation(
      makeRequest({ userKey: false, botKey: true, token: "tok", body: { resultMarkdown: "All done." } }),
      res
    )

    const messageParams = (createMessageInTransaction as ReturnType<typeof mock>).mock.calls[0][1]
    expect(messageParams).toMatchObject({ authorId: "bot_1", authorType: AuthorTypes.BOT, sentVia: undefined })
  })

  it("400s a plaintext result into an E2E stream before any insert", async () => {
    const { handlers } = transactionalHandlers({ isE2e: true })
    const { res } = createResponse()
    await expect(
      handlers.completeDelegation(makeRequest({ token: "tok", body: { resultMarkdown: "All done." } }), res)
    ).rejects.toMatchObject({ status: 400, code: "E2E_STREAM_PLAINTEXT_UNSUPPORTED" })
  })

  it("404s (existence-hiding) a completion whose stream access was revoked between claim and complete", async () => {
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as PoolClient))
    const handlers = makeHandlers({
      delegationService: { getById: mock(async () => makeDelegation({ status: DelegationStatuses.RUNNING })) },
      streamService: { tryAccess: mock(async () => null) },
    })
    const { res } = createResponse()
    await expect(
      handlers.completeDelegation(makeRequest({ token: "tok", body: { resultMarkdown: "All done." } }), res)
    ).rejects.toMatchObject({ status: 404 })
  })

  it("does no work when the claim lock finds no live holder (validate before write)", async () => {
    const createMessageInTransaction = mock(async () => ({ message: { id: "msg_x" } }))
    const { handlers } = transactionalHandlers({
      findClaimedForUpdate: mock(async () => null) as DelegationService["findClaimedForUpdate"],
      createMessageInTransaction: createMessageInTransaction as unknown as EventService["createMessageInTransaction"],
    })
    const { res } = createResponse()

    await expect(
      handlers.completeDelegation(makeRequest({ token: "tok", body: { resultMarkdown: "All done." } }), res)
    ).rejects.toMatchObject({ status: 404 })
    expect(createMessageInTransaction).not.toHaveBeenCalled()
  })

  it("answers a retried completion idempotently instead of a false 404", async () => {
    const committed = makeDelegation({
      status: DelegationStatuses.COMPLETED,
      resultMessageId: "msg_result",
      claimTokenHash: hashCallbackToken("tok"),
    })
    const completeInTransaction = mock(async () => null)
    const handlers = makeHandlers({
      delegationService: { getById: mock(async () => committed), completeInTransaction },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res, payloads } = createResponse()

    await handlers.completeDelegation(makeRequest({ token: "tok", body: { resultMarkdown: "All done." } }), res)

    expect(completeInTransaction).not.toHaveBeenCalled()
    expect((payloads[0] as { data: { status: string; resultMessageId?: string } }).data).toMatchObject({
      status: DelegationStatuses.COMPLETED,
      resultMessageId: "msg_result",
    })
  })

  it("still 404s a retry bearing the wrong token", async () => {
    spyOn(db, "withTransaction").mockImplementation(async (_pool, fn) => fn({} as PoolClient))
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const committed = makeDelegation({
      status: DelegationStatuses.COMPLETED,
      claimTokenHash: hashCallbackToken("the-real-token"),
    })
    const handlers = makeHandlers({
      delegationService: {
        getById: mock(async () => committed),
        completeInTransaction: mock(async () => null),
        findClaimedForUpdate: mock(async () => null),
      },
      eventService: { createMessageInTransaction: mock(async () => ({ message: { id: "msg_x" } })) as never },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res } = createResponse()
    await expect(
      handlers.completeDelegation(makeRequest({ token: "wrong-token", body: { resultMarkdown: "x" } }), res)
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("failDelegation retry", () => {
  it("answers a retried fail idempotently when the terminal row carries this token", async () => {
    const failedRow = makeDelegation({
      status: DelegationStatuses.FAILED,
      statusNote: "boom",
      claimTokenHash: hashCallbackToken("tok"),
    })
    const handlers = makeHandlers({
      delegationService: { fail: mock(async () => null), getById: mock(async () => failedRow) },
      streamService: { tryAccess: mock(async () => ({ id: "stream_1" }) as never) },
    })
    const { res, payloads } = createResponse()

    await handlers.failDelegation(makeRequest({ token: "tok", body: { errorMessage: "boom" } }), res)

    expect((payloads[0] as { data: { status: string } }).data.status).toBe(DelegationStatuses.FAILED)
  })
})
