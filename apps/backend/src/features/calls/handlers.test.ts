import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Server } from "socket.io"
import type { Pool } from "pg"
import { createCallHandlers } from "./handlers"
import { HttpError } from "../../lib/errors"
import * as accessModule from "./access"
import * as gatewayModule from "./signaling-gateway"

function fakeRes() {
  const res: Partial<Response> = {}
  res.status = mock(() => res as Response)
  res.json = mock(() => res as Response)
  res.send = mock(() => res as Response)
  return res as Response
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as unknown as Request
}

function makeHandlers(opts: {
  cloudflareEnabled?: boolean
  callsEnabled?: boolean
  callService?: Record<string, unknown>
}) {
  const featureFlagService = {
    getWorkspaceFlag: mock(async () => ((opts.callsEnabled ?? true) ? "on" : "off")),
  }
  return createCallHandlers({
    pool: {} as Pool,
    io: {} as Server,
    callService: (opts.callService ?? {}) as never,
    featureFlagService: featureFlagService as never,
    cloudflareEnabled: opts.cloudflareEnabled ?? true,
  })
}

describe("createCallHandlers.start — gating", () => {
  afterEach(() => mock.restore())

  it("503 CALLS_UNAVAILABLE when the CF media plane is unconfigured", async () => {
    const handlers = makeHandlers({ cloudflareEnabled: false })
    const promise = handlers.start(fakeReq({ body: { streamId: "stream_1", mode: "video" } }), fakeRes())
    await expect(promise).rejects.toMatchObject({ status: 503, code: "CALLS_UNAVAILABLE" })
  })

  it("404 CALLS_DISABLED when the workspace flag is off", async () => {
    const handlers = makeHandlers({ callsEnabled: false })
    const promise = handlers.start(fakeReq({ body: { streamId: "stream_1", mode: "video" } }), fakeRes())
    await expect(promise).rejects.toMatchObject({ status: 404, code: "CALLS_DISABLED" })
  })

  it("400 VALIDATION_ERROR on a bad body", async () => {
    const handlers = makeHandlers({})
    const promise = handlers.start(fakeReq({ body: { streamId: "stream_1", mode: "telepathy" } }), fakeRes())
    await expect(promise).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" })
  })

  it("starts the call and returns the roster snapshot", async () => {
    const startCall = mock(async (_p: unknown) => ({
      call: { id: "call_1" },
      created: true,
      participant: { id: "callp_1" },
      endpoint: { id: "callep_1" },
    }))
    const getRosterSnapshot = mock(async () => ({ rosterVersion: 1, roster: [{ userId: "usr_1" }] }))
    const handlers = makeHandlers({ callService: { startCall, getRosterSnapshot } })
    const res = fakeRes()

    await handlers.start(fakeReq({ body: { streamId: "stream_1", mode: "video", mediaIncarnation: "inc_1" } }), res)

    expect(startCall.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamId: "stream_1",
      mode: "video",
      mediaIncarnation: "inc_1",
    })
    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ call: { id: "call_1" }, rosterVersion: 1, roster: [{ userId: "usr_1" }] })
    )
  })
})

describe("createCallHandlers.bootstrap", () => {
  afterEach(() => mock.restore())

  it("404 CALL_NOT_FOUND when checkCallAccess denies", async () => {
    spyOn(accessModule, "checkCallAccess").mockResolvedValue(null)
    const handlers = makeHandlers({ callService: { getRosterSnapshot: mock(async () => ({})) } })
    const promise = handlers.bootstrap(fakeReq({ params: { callId: "call_1" } }), fakeRes())
    await expect(promise).rejects.toMatchObject({ status: 404, code: "CALL_NOT_FOUND" })
  })

  it("returns the roster and the caller's own entry", async () => {
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: { id: "call_1" } } as never)
    const getRosterSnapshot = mock(async () => ({
      rosterVersion: 3,
      roster: [
        { userId: "usr_1", endpointId: "callep_1" },
        { userId: "usr_2", endpointId: "callep_2" },
      ],
    }))
    const handlers = makeHandlers({ callService: { getRosterSnapshot } })
    const res = fakeRes()

    await handlers.bootstrap(fakeReq({ params: { callId: "call_1" } }), res)

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ rosterVersion: 3, self: { userId: "usr_1", endpointId: "callep_1" } })
    )
  })
})

describe("createCallHandlers.createCfSession", () => {
  afterEach(() => mock.restore())

  it("propagates a stale-incarnation 409 from the service", async () => {
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: { id: "call_1" } } as never)
    const createEndpointCfSession = mock(async (_p: unknown) => {
      throw new HttpError("stale", { status: 409, code: "CALL_STALE_INCARNATION" })
    })
    const handlers = makeHandlers({ callService: { createEndpointCfSession } })

    const promise = handlers.createCfSession(
      fakeReq({ params: { callId: "call_1", endpointId: "callep_1" }, body: { mediaIncarnation: "inc_1" } }),
      fakeRes()
    )
    await expect(promise).rejects.toMatchObject({ status: 409, code: "CALL_STALE_INCARNATION" })
    expect(createEndpointCfSession.mock.calls[0][0]).toMatchObject({
      endpointId: "callep_1",
      mediaIncarnation: "inc_1",
    })
  })

  it("returns the CF session result on success", async () => {
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: { id: "call_1" } } as never)
    const createEndpointCfSession = mock(async () => ({ cfSessionId: "sess_1", idempotent: false }))
    const handlers = makeHandlers({ callService: { createEndpointCfSession } })
    const res = fakeRes()

    await handlers.createCfSession(
      fakeReq({ params: { callId: "call_1", endpointId: "callep_1" }, body: { mediaIncarnation: "inc_1" } }),
      res
    )
    expect(res.json).toHaveBeenCalledWith({ cfSessionId: "sess_1", idempotent: false })
  })
})

describe("createCallHandlers.publishTracks", () => {
  afterEach(() => mock.restore())

  it("fans the bumped roster to the call room and returns the version", async () => {
    spyOn(accessModule, "checkCallAccess").mockResolvedValue({ call: { id: "call_1" } } as never)
    const broadcast = spyOn(gatewayModule, "broadcastRoster").mockImplementation(() => {})
    const snapshot = { rosterVersion: 5, roster: [] }
    const publishTracks = mock(async () => ({ cf: { requiresImmediateRenegotiation: false, tracks: [] }, snapshot }))
    const handlers = makeHandlers({ callService: { publishTracks } })
    const res = fakeRes()

    await handlers.publishTracks(
      fakeReq({
        params: { callId: "call_1", endpointId: "callep_1" },
        body: {
          mediaIncarnation: "inc_1",
          sdp: { type: "offer", sdp: "o" },
          tracks: [{ kind: "mic", mid: "0", trackName: "mic0" }],
        },
      }),
      res
    )

    expect(broadcast).toHaveBeenCalledWith(expect.anything(), "call_1", snapshot)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ rosterVersion: 5 }))
  })
})
