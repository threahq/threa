import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import type { Request, Response } from "express"
import { SubagentStatuses } from "@threahq/types"
import * as streamsModule from "../streams"
import { createSubagentHandlers } from "./handlers"
import { SubagentAlreadyActiveError } from "./repository"
import type { SubagentRun } from "./repository"
import type { SubagentService } from "./service"

const NOW = new Date("2026-09-01T12:00:00.000Z")

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: "subagent_1",
    workspaceId: "ws_1",
    parentStreamId: "stream_1",
    scopeStreamId: "stream_1",
    parentSessionId: null,
    triggerMessageId: null,
    cardEventId: "event_1",
    threadStreamId: "stream_thread_1",
    personaId: "persona_system_ariadne",
    model: "openrouter:openai/gpt-5.6-terra",
    createdBy: "usr_1",
    title: "Second opinion on the migration plan",
    brief: "Review the plan.",
    status: SubagentStatuses.ACTIVE,
    statusNote: null,
    resultMessageId: null,
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

function makeRequest() {
  return {
    workspaceId: "ws_1",
    params: { id: "subagent_1" },
    user: { id: "usr_1", name: "Kris" },
  } as unknown as Request
}

function makeHandlers(subagentService: Partial<SubagentService>) {
  return createSubagentHandlers({ pool: {} as Pool, subagentService: subagentService as SubagentService })
}

describe("subagent read handler", () => {
  afterEach(() => mock.restore())

  it("returns the run as the wire shape, and hides one the viewer cannot reach", async () => {
    const access = spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const handlers = makeHandlers({ getById: mock(async () => makeRun({ status: SubagentStatuses.COMPLETED })) })

    const ok = createResponse()
    await handlers.get(makeRequest(), ok.res)
    expect(ok.payloads[0]).toEqual({
      subagent: {
        id: "subagent_1",
        parentStreamId: "stream_1",
        threadStreamId: "stream_thread_1",
        cardEventId: "event_1",
        personaId: "persona_system_ariadne",
        model: "openrouter:openai/gpt-5.6-terra",
        title: "Second opinion on the migration plan",
        status: SubagentStatuses.COMPLETED,
        statusNote: null,
        resultMessageId: null,
        createdAt: NOW.toISOString(),
        statusChangedAt: NOW.toISOString(),
      },
    })
    // The brief never crosses: it is the delegation prompt, not card state.
    expect(JSON.stringify(ok.payloads[0])).not.toContain("Review the plan")

    access.mockResolvedValue(null as never)
    await expect(handlers.get(makeRequest(), createResponse().res)).rejects.toMatchObject({
      status: 404,
      code: "SUBAGENT_NOT_FOUND",
    })
  })
})

describe("subagent cancel handler", () => {
  afterEach(() => mock.restore())

  it("cancels an accessible run and reports a lost race honestly", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const cancel = mock(async (): Promise<SubagentRun | null> => makeRun({ status: SubagentStatuses.CANCELLED }))
    const handlers = makeHandlers({ getById: mock(async () => makeRun()), cancel })

    const first = createResponse()
    await handlers.cancel(makeRequest(), first.res)
    expect(first.payloads[0]).toEqual({ cancelled: true })
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws_1", id: "subagent_1", parentStreamId: "stream_1" })
    )

    // A run that settled first (report_back landed, the sweep expired it, a
    // second click) CASes nothing — the handler says so rather than erroring.
    cancel.mockResolvedValue(null)
    const second = createResponse()
    await handlers.cancel(makeRequest(), second.res)
    expect(second.payloads[0]).toEqual({ cancelled: false })
  })

  it("404s an unknown id without checking stream access (existence-hiding)", async () => {
    const accessSpy = spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const handlers = makeHandlers({ getById: mock(async () => null) })
    const { res } = createResponse()

    await expect(handlers.cancel(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "SUBAGENT_NOT_FOUND",
    })
    expect(accessSpy).not.toHaveBeenCalled()
  })

  it("404s a viewer without access to the run's parent stream", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)
    const cancel = mock(async (): Promise<SubagentRun | null> => makeRun())
    const handlers = makeHandlers({ getById: mock(async () => makeRun()), cancel })
    const { res } = createResponse()

    await expect(handlers.cancel(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "SUBAGENT_NOT_FOUND",
    })
    expect(cancel).not.toHaveBeenCalled()
  })
})

describe("subagent requeue handler", () => {
  afterEach(() => mock.restore())

  it("reactivates an accessible run and reports a lost race honestly", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const requeue = mock(async (): Promise<SubagentRun | null> => makeRun({ status: SubagentStatuses.ACTIVE }))
    const handlers = makeHandlers({ getById: mock(async () => makeRun({ status: SubagentStatuses.FAILED })), requeue })

    const first = createResponse()
    await handlers.requeue(makeRequest(), first.res)
    expect(first.payloads[0]).toEqual({ requeued: true })

    requeue.mockResolvedValue(null)
    const second = createResponse()
    await handlers.requeue(makeRequest(), second.res)
    expect(second.payloads[0]).toEqual({ requeued: false })
  })

  it("409s when another subagent took the conversation's live slot", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue({ id: "stream_1" } as never)
    const handlers = makeHandlers({
      getById: mock(async () => makeRun({ status: SubagentStatuses.EXPIRED })),
      requeue: mock(async () => {
        throw new SubagentAlreadyActiveError("stream_1")
      }),
    })
    const { res } = createResponse()

    await expect(handlers.requeue(makeRequest(), res)).rejects.toMatchObject({
      status: 409,
      code: "SUBAGENT_ALREADY_ACTIVE",
    })
  })

  it("404s a viewer without access to the run's parent stream", async () => {
    spyOn(streamsModule, "checkStreamAccess").mockResolvedValue(null)
    const requeue = mock(async (): Promise<SubagentRun | null> => makeRun())
    const handlers = makeHandlers({ getById: mock(async () => makeRun()), requeue })
    const { res } = createResponse()

    await expect(handlers.requeue(makeRequest(), res)).rejects.toMatchObject({
      status: 404,
      code: "SUBAGENT_NOT_FOUND",
    })
    expect(requeue).not.toHaveBeenCalled()
  })
})
