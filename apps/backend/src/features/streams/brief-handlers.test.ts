import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Request, Response } from "express"
import type { Pool } from "pg"
import { Visibilities } from "@threahq/types"
import { StreamRepository, type Stream } from "./repository"
import { HttpError } from "../../lib/errors"
import { createStreamBriefHandlers } from "./brief-handlers"
import type { StreamBriefService, UpdateBriefParams } from "./brief-service"
import type { StreamBrief } from "./brief-repository"

function fakeBriefServiceUpdateResult(overrides: Partial<StreamBrief> = {}): StreamBrief {
  return {
    id: "sbrf_01",
    workspaceId: "ws_1",
    streamId: "stream_chan",
    content: "Goal: ship v2",
    version: 1,
    updatedByKind: "user",
    updatedById: "usr_1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-05T00:00:00Z"),
    ...overrides,
  }
}

function fakeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "stream_chan",
    workspaceId: "ws_1",
    rootStreamId: null,
    visibility: Visibilities.PUBLIC,
    ...overrides,
  } as Stream
}

function fakeReq(overrides: Partial<{ params: object; body: object }> = {}): Request {
  return {
    user: { id: "usr_1" },
    workspaceId: "ws_1",
    params: { streamId: "stream_chan" },
    body: {},
    ...overrides,
  } as unknown as Request
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as typeof res & Response
}

function makeHandlers(service: Partial<StreamBriefService>) {
  return createStreamBriefHandlers({
    pool: {} as Pool,
    streamBriefService: service as StreamBriefService,
  })
}

describe("stream brief handlers", () => {
  afterEach(() => mock.restore())

  it("GET hides streams the caller cannot access behind a 404", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(null)
    const handlers = makeHandlers({})

    await expect(handlers.get(fakeReq(), fakeRes())).rejects.toMatchObject({
      status: 404,
      code: "STREAM_NOT_FOUND",
    })
  })

  it("GET on a thread returns the ROOT stream's brief (threads inherit, INV-62)", async () => {
    const thread = fakeStream({ id: "stream_thread", rootStreamId: "stream_root" })
    const root = fakeStream({ id: "stream_root" })
    spyOn(StreamRepository, "findById").mockImplementation(async (_db, id) => (id === "stream_thread" ? thread : root))
    const get = mock(async (_params: { workspaceId: string; streamId: string }) => null)
    const handlers = makeHandlers({ get } as unknown as Partial<StreamBriefService>)

    const res = fakeRes()
    await handlers.get(fakeReq({ params: { streamId: "stream_thread" } }), res)

    expect(get.mock.calls[0]?.[0]).toEqual({ workspaceId: "ws_1", streamId: "stream_root" })
    expect(res.body).toEqual({ brief: null })
  })

  it("PUT delegates public non-member authority to the transactional service", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const update = mock(async () => {
      throw new HttpError("This stream is read-only", {
        status: 403,
        code: "STREAM_READ_ONLY",
        details: { reason: "not_a_member" },
      })
    })
    const handlers = makeHandlers({ update } as unknown as Partial<StreamBriefService>)

    const req = fakeReq({ body: { content: "Goal: ship v2", version: 0 } })
    await expect(handlers.put(req, fakeRes())).rejects.toMatchObject({
      status: 403,
      code: "STREAM_READ_ONLY",
      details: { reason: "not_a_member" },
    })
  })

  it("PUT delegates encrypted-stream ordering to the transactional service", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream({ e2eEnabled: true }))
    const update = mock(async () => {
      throw new HttpError("Briefs are not supported on encrypted streams", {
        status: 400,
        code: "BRIEF_E2E_UNSUPPORTED",
      })
    })
    const handlers = makeHandlers({ update } as unknown as Partial<StreamBriefService>)

    const req = fakeReq({ body: { content: "Goal: ship v2", version: 0 } })
    await expect(handlers.put(req, fakeRes())).rejects.toMatchObject({
      status: 400,
      code: "BRIEF_E2E_UNSUPPORTED",
    })
  })

  it("PUT rejects a version beyond pg INT4 range at validation instead of 500ing in the guard query", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const handlers = makeHandlers({})

    const req = fakeReq({ body: { content: "x", version: 3_000_000_000 } })
    await expect(handlers.put(req, fakeRes())).rejects.toMatchObject({ status: 400 })
  })

  it("PUT surfaces a lost optimistic-concurrency race as 409 carrying the fresh brief", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const current = fakeBriefServiceUpdateResult({ version: 5 })
    const update = mock(async () => ({ outcome: "version_conflict" as const, current }))
    const handlers = makeHandlers({ update } as unknown as Partial<StreamBriefService>)

    const req = fakeReq({ body: { content: "stale", version: 3 } })
    await expect(handlers.put(req, fakeRes())).rejects.toMatchObject({
      status: 409,
      code: "BRIEF_VERSION_CONFLICT",
      details: { current },
    })
  })

  it("PUT writes as the calling user and returns the updated brief", async () => {
    spyOn(StreamRepository, "findById").mockResolvedValue(fakeStream())
    const brief = fakeBriefServiceUpdateResult({ version: 1 })
    const update = mock(async (_params: UpdateBriefParams) => ({ outcome: "updated" as const, brief }))
    const handlers = makeHandlers({ update } as unknown as Partial<StreamBriefService>)

    const res = fakeRes()
    await handlers.put(fakeReq({ body: { content: "Goal: ship v2", version: 0 } }), res)

    expect(update.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: "ws_1",
      streamId: "stream_chan",
      content: "Goal: ship v2",
      expectedVersion: 0,
      updatedByKind: "user",
      updatedById: "usr_1",
      principal: { kind: "user", userId: "usr_1" },
      requestedStreamId: "stream_chan",
    })
    expect(res.body).toEqual({ brief })
  })
})
