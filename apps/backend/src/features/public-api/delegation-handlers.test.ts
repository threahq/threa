import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import { createPublicApiHandlers, type PublicApiDeps } from "./handlers"
import { DelegationStatuses, type DelegationStatus } from "@threa/types"
import { E2eStreamsRepository } from "../e2e-streams"
import type { DelegatedTask } from "../delegations"

// Public delegation lifecycle (roadmap 5.3): a local agent claims an open task,
// reports progress, then completes it (posting the result as the claiming
// principal) or fails it. These unit tests drive the handlers against a stubbed
// DelegationService; the CAS/race semantics live in the service/repository tests.

function createResponse() {
  const json = mock((_body: unknown) => res)
  const status = mock((_code: number) => res)
  const res = { json, status } as unknown as Response & { json: typeof json; status: typeof status }
  return res
}

function fakeDelegation(overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  const now = new Date("2026-07-09T12:00:00.000Z")
  return {
    id: "dlg_1",
    workspaceId: "ws_1",
    streamId: "stream_1",
    sessionId: "session_1",
    sourceConversationId: null,
    createdByKind: "persona",
    createdById: "persona_system_ariadne",
    title: "Add rate limiting",
    brief: "Do the thing. Done when tests pass.",
    contextRefs: ["memo:memo_1"],
    status: DelegationStatuses.OPEN as DelegationStatus,
    claimTokenHash: null,
    claimExpiresAt: null,
    claimedByLabel: null,
    resultMessageId: null,
    statusNote: null,
    createdAt: now,
    updatedAt: now,
    statusChangedAt: now,
    ...overrides,
  }
}

function arrange(delegationOverrides: Partial<Record<string, unknown>> = {}) {
  const delegationService = {
    getById: mock(async () => fakeDelegation()),
    listOpen: mock(async () => [] as DelegatedTask[]),
    claim: mock(async () => ({
      ok: true as const,
      delegation: fakeDelegation({
        status: DelegationStatuses.CLAIMED as DelegationStatus,
        claimedByLabel: "Kris's MacBook",
        claimExpiresAt: new Date("2026-07-09T12:15:00.000Z"),
      }),
      claimToken: "tok_secret",
    })),
    heartbeat: mock(async () => new Date("2026-07-09T12:15:00.000Z")),
    markRunning: mock(async () =>
      fakeDelegation({ status: DelegationStatuses.RUNNING as DelegationStatus, statusNote: "half way" })
    ),
    complete: mock(async () => ({
      delegation: fakeDelegation({
        status: DelegationStatuses.COMPLETED as DelegationStatus,
        resultMessageId: "msg_r",
      }),
      message: {
        id: "msg_r",
        streamId: "stream_1",
        sequence: 5n,
        authorId: "usr_kris",
        authorType: "user",
        contentMarkdown: "Shipped it.",
        replyCount: 0,
        editedAt: null,
        createdAt: new Date("2026-07-09T12:16:00.000Z"),
      },
    })),
    fail: mock(async () =>
      fakeDelegation({ status: DelegationStatuses.FAILED as DelegationStatus, statusNote: "boom" })
    ),
    ...delegationOverrides,
  } as unknown as PublicApiDeps["delegationService"]

  // User-scoped key: access gate resolves via streamService.tryAccess; the
  // completion message is authored by the key owner. `streamAccessible: false`
  // makes tryAccess return null (non-member) so the gate must 404.
  const streamService = {
    tryAccess: mock(async () => (delegationOverrides.streamAccessible === false ? null : { id: "stream_1" })),
  } as unknown as PublicApiDeps["streamService"]

  const handlers = createPublicApiHandlers({
    eventService: {} as PublicApiDeps["eventService"],
    streamService,
    searchService: {} as PublicApiDeps["searchService"],
    memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
    attachmentService: {} as PublicApiDeps["attachmentService"],
    botChannelService: {} as PublicApiDeps["botChannelService"],
    botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
    labelService: {} as PublicApiDeps["labelService"],
    labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
    delegationService,
    pool: {} as PublicApiDeps["pool"],
    io: {} as PublicApiDeps["io"],
  })

  function req(body: unknown, params: Record<string, string> = { delegationId: "dlg_1" }) {
    return {
      workspaceId: "ws_1",
      params,
      userApiKey: { userId: "usr_kris" },
      user: { id: "usr_kris", name: "Kris" },
      body,
    } as unknown as Request
  }

  return { handlers, delegationService: delegationService as any, req }
}

describe("claimDelegation", () => {
  afterEach(() => mock.restore())

  it("returns the claimed delegation with the one-time claim token", async () => {
    const { handlers, req } = arrange()
    const res = createResponse()

    await handlers.claimDelegation(req({ claimedByLabel: "Kris's MacBook" }), res)

    const body = res.json.mock.calls[0]?.[0] as { data: { status: string; claimToken: string; claimExpiresAt: string } }
    expect(body.data.status).toBe(DelegationStatuses.CLAIMED)
    expect(body.data.claimToken).toBe("tok_secret")
    expect(body.data.claimExpiresAt).toBe("2026-07-09T12:15:00.000Z")
  })

  it("409s when the task is no longer open", async () => {
    const { handlers, req } = arrange({
      claim: mock(async () => ({ ok: false as const, reason: "not_open" as const })),
    })
    await expect(handlers.claimDelegation(req({ claimedByLabel: "x" }), createResponse())).rejects.toMatchObject({
      status: 409,
    })
  })

  it("404s when the delegation does not exist (access gate)", async () => {
    const { handlers, req } = arrange({ getById: mock(async () => null) })
    await expect(handlers.claimDelegation(req({ claimedByLabel: "x" }), createResponse())).rejects.toMatchObject({
      status: 404,
    })
  })

  it("404s (not 403) when the stream is inaccessible — hides existence from a non-member", async () => {
    const { handlers, req } = arrange({ streamAccessible: false })
    await expect(handlers.claimDelegation(req({ claimedByLabel: "x" }), createResponse())).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe("completeDelegation", () => {
  afterEach(() => mock.restore())

  it("completes with a result message authored by the principal and returns 201", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const { handlers, delegationService, req } = arrange()
    const res = createResponse()

    await handlers.completeDelegation(req({ claimToken: "tok_secret", resultMarkdown: "Shipped it." }), res)

    // The service is asked to post the result as the key owner (INV: "the claiming identity").
    const completeArg = delegationService.complete.mock.calls[0]?.[0]
    expect(completeArg.result.author).toEqual({ actorId: "usr_kris", actorType: "user" })
    expect(completeArg.result.contentMarkdown).toBe("Shipped it.")
    expect(res.status).toHaveBeenCalledWith(201)
    const body = res.json.mock.calls[0]?.[0] as { data: { delegation: { status: string }; message: { id: string } } }
    expect(body.data.delegation.status).toBe(DelegationStatuses.COMPLETED)
    expect(body.data.message.id).toBe("msg_r")
  })

  it("404s when the claim is invalid or lapsed", async () => {
    spyOn(E2eStreamsRepository, "isE2eStream").mockResolvedValue(false)
    const { handlers, req } = arrange({ complete: mock(async () => null) })
    await expect(
      handlers.completeDelegation(req({ claimToken: "stale", resultMarkdown: "x" }), createResponse())
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe("reportDelegationProgress / heartbeat / fail", () => {
  afterEach(() => mock.restore())

  it("reports progress → running with the note", async () => {
    const { handlers, req } = arrange()
    const res = createResponse()
    await handlers.reportDelegationProgress(req({ claimToken: "tok_secret", statusNote: "half way" }), res)
    const body = res.json.mock.calls[0]?.[0] as { data: { status: string; statusNote: string } }
    expect(body.data.status).toBe(DelegationStatuses.RUNNING)
    expect(body.data.statusNote).toBe("half way")
  })

  it("heartbeat returns the renewed expiry", async () => {
    const { handlers, req } = arrange()
    const res = createResponse()
    await handlers.heartbeatDelegation(req({ claimToken: "tok_secret" }), res)
    const body = res.json.mock.calls[0]?.[0] as { data: { claimExpiresAt: string } }
    expect(body.data.claimExpiresAt).toBe("2026-07-09T12:15:00.000Z")
  })

  it("heartbeat 404s when the claim is gone", async () => {
    const { handlers, req } = arrange({ heartbeat: mock(async () => null) })
    await expect(handlers.heartbeatDelegation(req({ claimToken: "stale" }), createResponse())).rejects.toMatchObject({
      status: 404,
    })
  })

  it("fail records the reason", async () => {
    const { handlers, req } = arrange()
    const res = createResponse()
    await handlers.failDelegation(req({ claimToken: "tok_secret", errorMessage: "boom" }), res)
    const body = res.json.mock.calls[0]?.[0] as { data: { status: string } }
    expect(body.data.status).toBe(DelegationStatuses.FAILED)
  })
})

describe("listOpenDelegations", () => {
  afterEach(() => mock.restore())

  it("filters open delegations to streams the key can access (INV-62)", async () => {
    const open = [
      fakeDelegation({ id: "dlg_1", streamId: "stream_ok" }),
      fakeDelegation({ id: "dlg_2", streamId: "stream_hidden" }),
    ]
    // A bot key's accessible set comes from botChannelService — stub it to make
    // only stream_ok visible so the hidden delegation must be dropped.
    const delegationService = { listOpen: mock(async () => open) } as unknown as PublicApiDeps["delegationService"]
    const botChannelService = {
      getAccessibleStreamIdsForBot: mock(async () => ["stream_ok"]),
    } as unknown as PublicApiDeps["botChannelService"]
    const handlers = createPublicApiHandlers({
      eventService: {} as PublicApiDeps["eventService"],
      streamService: {} as PublicApiDeps["streamService"],
      searchService: {} as PublicApiDeps["searchService"],
      memoExplorerService: {} as PublicApiDeps["memoExplorerService"],
      attachmentService: {} as PublicApiDeps["attachmentService"],
      botChannelService,
      botRuntimeService: {} as PublicApiDeps["botRuntimeService"],
      labelService: {} as PublicApiDeps["labelService"],
      labelAssignmentService: {} as PublicApiDeps["labelAssignmentService"],
      delegationService,
      pool: {} as PublicApiDeps["pool"],
      io: {} as PublicApiDeps["io"],
    })
    const req = { workspaceId: "ws_1", botApiKey: { botId: "bot_1" } } as unknown as Request
    const res = createResponse()

    await handlers.listOpenDelegations(req, res)

    const body = res.json.mock.calls[0]?.[0] as { data: Array<{ id: string; streamId: string }> }
    expect(body.data.map((d) => d.id)).toEqual(["dlg_1"])
    expect(body.data.every((d) => d.streamId !== "stream_hidden")).toBe(true)
  })
})
