import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { Pool } from "pg"
import { createSearchHandlers } from "./handlers"
import * as accessModule from "./access"
import { readAuditSubjects } from "../access-log"
import type { SearchService } from "./service"
import type { SearchQueryLogService } from "./query-log-service"
import type { FeatureFlagService } from "../feature-flags"

function createResponse() {
  const res = {
    locals: {} as Record<string, unknown>,
    statusCode: 200,
    body: undefined as unknown,
    ended: false,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
    end() {
      res.ended = true
      return res
    },
  }
  return res
}

function createRequest(overrides: { params?: Record<string, string>; body?: unknown }) {
  return {
    user: { id: "usr_1", workosUserId: "workos_1" },
    workspaceId: "ws_1",
    params: overrides.params ?? {},
    body: overrides.body ?? {},
  }
}

function createHandlers(overrides: {
  searchQueryLog?: "on" | "off"
  record?: SearchQueryLogService["record"]
  steer?: { applied: boolean; note: string | null } | null
}) {
  const recordClick = mock((_params: Parameters<SearchQueryLogService["recordClick"]>[0]) => Promise.resolve())
  const record = overrides.record ?? mock(() => Promise.resolve({ id: "sqlog_1" }))
  const searchClusters = mock((_params: Parameters<SearchService["searchClusters"]>[0]) =>
    Promise.resolve({
      results: [],
      conversations: [],
      memos: [],
      clusters: [],
      excludedE2eStreamCount: 0,
      steer: overrides.steer ?? null,
    })
  )
  const handlers = createSearchHandlers({
    pool: {} as Pool,
    searchService: { searchClusters } as unknown as SearchService,
    searchQueryLogService: { record, recordClick } as unknown as SearchQueryLogService,
    featureFlagService: {
      getFlags: mock(() => Promise.resolve({ search: "on", searchQueryLog: overrides.searchQueryLog ?? "on" })),
    } as unknown as FeatureFlagService,
  })
  return { handlers, record, recordClick, searchClusters }
}

describe("search handlers", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns the results with a null log id when the opt-in log write fails", async () => {
    spyOn(accessModule, "resolveUserAccessibleStreamIds").mockResolvedValue([])
    const { handlers } = createHandlers({ record: mock(() => Promise.reject(new Error("insert failed"))) })
    const res = createResponse()

    await handlers.search(createRequest({ body: { query: "deploy checklist" } }) as never, res as never)

    expect(res.body).toEqual({
      results: [],
      clusters: [],
      memos: [],
      excludedE2eStreamCount: 0,
      steer: null,
      queryLogId: null,
    })
  })

  it("passes the steer trail to the service, logs it with the params, and echoes the outcome", async () => {
    spyOn(accessModule, "resolveUserAccessibleStreamIds").mockResolvedValue([])
    const steer = { applied: true, note: "Kept the decisions" }
    const { handlers, record, searchClusters } = createHandlers({ steer })
    const res = createResponse()

    await handlers.search(
      createRequest({ body: { query: "deploy", steer: [" only decisions ", "newest first"] } }) as never,
      res as never
    )

    expect(searchClusters).toHaveBeenCalledWith(
      expect.objectContaining({ query: "deploy", steer: ["only decisions", "newest first"] })
    )
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ steer: ["only decisions", "newest first"] }) })
    )
    expect(res.body).toEqual(expect.objectContaining({ steer, queryLogId: "sqlog_1" }))
  })

  it("rejects a steer trail longer than the cap", async () => {
    const { handlers, searchClusters } = createHandlers({})

    await expect(
      handlers.search(
        createRequest({ body: { query: "deploy", steer: ["a", "b", "c", "d", "e", "f"] } }) as never,
        createResponse() as never
      )
    ).rejects.toMatchObject({ status: 400 })
    expect(searchClusters).not.toHaveBeenCalled()
  })

  it("records nothing for a click once the user's consent is off, and still answers 204", async () => {
    const { handlers, recordClick } = createHandlers({ searchQueryLog: "off" })
    const res = createResponse()

    await handlers.recordClick(
      createRequest({ params: { id: "sqlog_1" }, body: { kind: "message", id: "msg_1" } }) as never,
      res as never
    )

    expect({ status: res.statusCode, ended: res.ended, calls: recordClick.mock.calls.length }).toEqual({
      status: 204,
      ended: true,
      calls: 0,
    })
  })

  it("attributes the click to the log entry and audits both refs", async () => {
    const { handlers, recordClick } = createHandlers({})
    const res = createResponse()

    await handlers.recordClick(
      createRequest({ params: { id: "sqlog_1" }, body: { kind: "conversation", id: "conv_1" } }) as never,
      res as never
    )

    expect(recordClick).toHaveBeenCalledWith({
      workspaceId: "ws_1",
      userId: "usr_1",
      id: "sqlog_1",
      kind: "conversation",
      targetId: "conv_1",
    })
    expect({ status: res.statusCode, subjects: readAuditSubjects(res as never) }).toEqual({
      status: 204,
      subjects: [
        { type: "search_query_log", id: "sqlog_1" },
        { type: "conversation", id: "conv_1" },
      ],
    })
  })

  it("rejects a click kind the log cannot attribute", async () => {
    const { handlers, recordClick } = createHandlers({})
    const res = createResponse()

    const err = await handlers
      .recordClick(
        createRequest({ params: { id: "sqlog_1" }, body: { kind: "attachment", id: "att_1" } }) as never,
        res as never
      )
      .then(
        () => null,
        (e: unknown) => (e as { status?: number }).status
      )

    expect({ err, calls: recordClick.mock.calls.length }).toEqual({ err: 400, calls: 0 })
  })
})
