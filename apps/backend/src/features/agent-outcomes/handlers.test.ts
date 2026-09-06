import { describe, expect, it, mock } from "bun:test"
import type { Request, Response } from "express"
import type { ListAgentOutcomesResponse } from "@threahq/types"
import { createAgentOutcomeHandlers } from "./handlers"
import type { AgentOutcomeService, ListAgentOutcomesParams } from "./service"

const EMPTY: ListAgentOutcomesResponse = { items: [], nextCursor: null, outstandingCount: 0 }

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

function makeRequest(query: Record<string, unknown>) {
  return { workspaceId: "ws_1", user: { id: "usr_1" }, query } as unknown as Request
}

function makeHandlers(list = mock(async (_params: ListAgentOutcomesParams) => EMPTY)) {
  const handlers = createAgentOutcomeHandlers({ agentOutcomeService: { list } as unknown as AgentOutcomeService })
  return { handlers, list }
}

describe("agent outcomes list handler", () => {
  it("defaults state to all, scope to tree and the count off, and passes the parsed filters through", async () => {
    const { handlers, list } = makeHandlers()
    const { res, payloads } = createResponse()

    await handlers.list(makeRequest({ streams: "stream_1, stream_2", kind: "follow_up", q: "deploy" }), res)

    expect(list.mock.calls[0]![0]).toEqual({
      workspaceId: "ws_1",
      userId: "usr_1",
      streamIds: ["stream_1", "stream_2"],
      scope: "tree",
      state: "all",
      kind: "follow_up",
      queryText: "deploy",
      cursor: undefined,
      limit: 50,
      withCount: false,
    })
    expect(payloads[0]).toEqual(EMPTY)
  })

  it("opts into the count and the exact-stream scope only when asked", async () => {
    const { handlers, list } = makeHandlers()
    const { res } = createResponse()

    await handlers.list(makeRequest({ scope: "stream", withCount: "true" }), res)

    expect(list.mock.calls[0]![0]).toMatchObject({ scope: "stream", withCount: true })
  })

  it("treats a blank streams filter as workspace-wide", async () => {
    const { handlers, list } = makeHandlers()
    const { res } = createResponse()

    await handlers.list(makeRequest({ streams: " , " }), res)

    expect(list.mock.calls[0]![0].streamIds).toBeUndefined()
  })

  it.each([
    ["state", { state: "pending" }],
    ["kind", { kind: "outcome" }],
    ["scope", { scope: "workspace" }],
    ["withCount", { withCount: "yes" }],
    ["limit above the max", { limit: "101" }],
    ["non-numeric limit", { limit: "many" }],
  ])("rejects a bad %s", async (_label, query) => {
    const { handlers } = makeHandlers()
    const { res } = createResponse()

    await expect(handlers.list(makeRequest(query), res)).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
    })
  })
})
